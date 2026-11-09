/**
 * Settle Up API: Google Apps Script bound to the NEW "Settle Up v2" spreadsheet.
 *
 * Deploy as a web app: Execute as = Me, Who has access = Anyone.
 * "Anyone" only means the URL is reachable; every call must carry a Google ID token
 * that is verified here and matched against the two allowed email addresses.
 *
 * Script Properties (Project Settings → Script properties):
 *   CLIENT_ID      Google OAuth web client ID (same one the front end uses)
 *   USER_A_NAME, USER_A_EMAIL, USER_B_NAME, USER_B_EMAIL
 *   DISCORD_WEBHOOK   (optional) also post the weekly digest to Discord
 *   CURRENCY          (optional) default £
 *
 * First run: choose `setup` in the editor and press Run. It creates the sheets,
 * and installs the weekly digest trigger (Mondays ~12:00 London).
 */

var API_VERSION = 3;   // bump when the app needs new server behaviour; the app warns if the deployed script is older
var TX_SHEET = 'Transactions';
var POT_SHEET = 'Pots';
var HEADERS = ['id', 'created_at', 'date', 'type', 'description', 'amount_pence', 'paid_by',
  'other_share_pct', 'pot', 'status', 'created_by', 'voided_by', 'voided_at', 'group_id', 'replaces'];

/* ───────────── entry points ───────────── */

function doGet() {
  return json_({ ok: true, service: 'settle-up', version: API_VERSION });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var me = verify_(req.token);
    switch (req.action) {
      case 'state':   return json_({ ok: true, state: state_(me) });
      case 'add':     return json_(locked_(function () { return add_(me, req.entry); }));
      case 'void':    return json_(locked_(function () { return void_(me, req.id); }));
      case 'edit':    return json_(locked_(function () { return edit_(me, req.id, req.entry); }));
      case 'settle': {
        var out = locked_(function () { return settle_(me, req.expected, req.date, req.group, req.ids, req.amounts); });
        var mail = out._mail; delete out._mail;
        if (mail) notifySettle_(mail.me, config_(), mail.settled, mail.net);   // slow, so it runs after the lock is released
        return json_(out);
      }
      case 'addPot':  return json_(locked_(function () { return addPot_(req.name); }));
      default: throw fail_('bad_request', 'Unknown action');
    }
  } catch (err) {
    if (err && err.code) return json_({ ok: false, code: err.code, error: err.message });
    console.error(err && err.stack || err);
    return json_({ ok: false, code: 'server', error: 'Something went wrong on the server' });
  }
}

/* ───────────── auth ───────────── */

function config_() {
  var p = PropertiesService.getScriptProperties();
  var c = {
    clientId: p.getProperty('CLIENT_ID'),
    users: [
      { name: p.getProperty('USER_A_NAME'), email: (p.getProperty('USER_A_EMAIL') || '').toLowerCase() },
      { name: p.getProperty('USER_B_NAME'), email: (p.getProperty('USER_B_EMAIL') || '').toLowerCase() },
    ],
    currency: p.getProperty('CURRENCY') || '£',
    discord: p.getProperty('DISCORD_WEBHOOK') || '',
  };
  if (!c.clientId || !c.users[0].email || !c.users[1].email) throw fail_('config', 'Script properties are not set up');
  return c;
}

function verify_(idToken) {
  if (!idToken) throw fail_('auth', 'Please sign in');
  var cfg = config_();
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  var hit = cache.get(key);
  if (hit) return hit;

  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw fail_('auth', 'Sign-in expired, please sign in again');
  var t = JSON.parse(res.getContentText());
  var expMs = Number(t.exp) * 1000;
  if (t.aud !== cfg.clientId || String(t.email_verified) !== 'true' || !(expMs > Date.now()))
    throw fail_('auth', 'Sign-in not valid');
  var email = normEmail_(t.email);
  var match = cfg.users.filter(function (u) { return normEmail_(u.email) === email; })[0];
  if (!match) throw fail_('forbidden', 'This account is not allowed');
  // Always return the address as configured, so stored rows use one spelling per person.
  cache.put(key, match.email, Math.max(1, Math.min(3000, Math.floor((expMs - Date.now()) / 1000) - 30)));
  return match.email;
}

/** Gmail ignores dots and +tags in the name part, so a.b@gmail.com and ab@gmail.com are one account. */
function normEmail_(raw) {
  var e = String(raw || '').trim().toLowerCase();
  var at = e.lastIndexOf('@');
  if (at < 1) return e;
  var local = e.slice(0, at), domain = e.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0].replace(/\./g, '');
    domain = 'gmail.com';
  }
  return local + '@' + domain;
}

/* ───────────── actions ───────────── */

function state_(me) {
  var cfg = config_();
  return {
    version: API_VERSION,
    me: me,
    users: cfg.users,
    currency: cfg.currency,
    pots: potNames_(),
    rows: readRows_(),
  };
}

function add_(me, entry) {
  var cfg = config_();
  var row = normalise_(entry, cfg);
  var existing = findRow_(row.id);
  if (existing) return { ok: true, duplicate: true };   // idempotent retry
  ensurePot_(row.pot);
  appendRow_(Object.assign(row, { created_by: me, group_id: row.group_id || '' }));
  return { ok: true };
}

function void_(me, id) {
  var f = findRow_(id);
  if (!f) throw fail_('not_found', 'Entry not found');
  if (f.row.status !== 'void') {
    var sh = sheet_(TX_SHEET);
    sh.getRange(f.index, HEADERS.indexOf('status') + 1).setValue('void');
    sh.getRange(f.index, HEADERS.indexOf('voided_by') + 1).setValue(me);
    sh.getRange(f.index, HEADERS.indexOf('voided_at') + 1).setValue(new Date().toISOString());
  }
  return { ok: true };
}

function edit_(me, id, entry) {
  var cfg = config_();
  var f = findRow_(id);
  if (!f) throw fail_('not_found', 'Entry not found');
  var row = normalise_(entry, cfg);
  if (findRow_(row.id)) return { ok: true, duplicate: true };   // this edit already happened (retry)
  void_(me, id);
  ensurePot_(row.pot);
  appendRow_(Object.assign(row, { created_by: me, replaces: id }));
  return { ok: true };
}

/**
 * Settle up. The client sends the balances it was looking at (`expected`, net pence per pot).
 * If anything changed since, nothing is written and the fresh state is returned so the
 * user confirms the real figure rather than a stale one.
 */
function settle_(me, expected, date, group, ids, amounts) {
  var cfg = config_();
  var a = cfg.users[0], b = cfg.users[1];
  var rows = readRows_();
  group = String(group || '');
  if (group && rows.some(function (r) { return r.group_id === group; })) return { ok: true, duplicate: true };   // retry of a settle that already went through
  var net = balances_(rows, a.email, b.email);
  ids = ids || {};
  var pots = Object.keys(expected || {});
  if (!pots.length) throw fail_('bad_request', 'Nothing to settle');
  for (var i = 0; i < pots.length; i++) {
    if ((net[pots[i]] || 0) !== expected[pots[i]])
      return { ok: false, code: 'conflict', error: 'Balances changed, please review and try again', state: state_(me) };
  }
  // A payment may be less than the balance (a part payment), never more. Check everything before writing anything.
  amounts = amounts || {};
  var settled = {};
  pots.forEach(function (pot) {
    var n = net[pot] || 0;
    if (n === 0) return;
    var amt = amounts[pot] == null ? Math.abs(n) : Number(amounts[pot]);
    if (!isFinite(amt) || Math.floor(amt) !== amt || amt <= 0 || amt > Math.abs(n))
      throw fail_('invalid', 'A payment must be more than zero and no more than what is owed');
    settled[pot] = amt;
  });
  group = group || Utilities.getUuid();
  Object.keys(settled).forEach(function (pot) {
    var n = net[pot];
    appendRow_(normalise_({
      id: String(ids[pot] || Utilities.getUuid()), type: 'settlement', date: date, pot: pot,
      description: settled[pot] < Math.abs(n) ? 'Part payment' : 'Settle up',
      amount_pence: settled[pot], paid_by: n > 0 ? b.email : a.email, other_share_pct: 100,
    }, cfg), { created_by: me, group_id: group });
  });
  var any = Object.keys(settled).length > 0;
  return any ? { ok: true, settled: settled, _mail: { me: me, settled: settled, net: net } } : { ok: true, settled: {} };
}

function addPot_(name) {
  name = String(name || '').trim();
  if (!name || name.length > 40) throw fail_('bad_request', 'Pot name must be 1-40 characters');
  ensurePot_(name);
  return { ok: true, pots: potNames_() };
}

/* ───────────── data helpers ───────────── */

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
function sheet_(name) {
  var s = ss_().getSheetByName(name);
  if (!s) throw fail_('config', 'Run setup() first: missing sheet ' + name);
  return s;
}

function rowObj_(v) {
  var o = {};
  HEADERS.forEach(function (h, i) { o[h] = v[i]; });
  o.amount_pence = Number(o.amount_pence);
  o.other_share_pct = Number(o.other_share_pct);
  o.date = dateStr_(o.date);
  o.created_at = o.created_at instanceof Date ? o.created_at.toISOString() : String(o.created_at);
  o.voided_at = o.voided_at instanceof Date ? o.voided_at.toISOString() : String(o.voided_at || '');
  o.group_id = String(o.group_id || '');
  return o;
}

function readRows_() {
  var sh = sheet_(TX_SHEET);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues().map(rowObj_).filter(function (o) { return o.id; });
}

var TZ_ = null;
function tz_() { return TZ_ || (TZ_ = ss_().getSpreadsheetTimeZone()); }   // looked up once per request, not once per row

function dateStr_(d) {
  // Sheets turns '2026-07-01' into a date at midnight in the SPREADSHEET's time zone, so read it back in that zone
  // (UTC would shift summer dates back a day).
  if (d instanceof Date) return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
  return String(d);
}

function findRow_(id) {
  var sh = sheet_(TX_SHEET);
  var last = sh.getLastRow();
  if (last < 2) return null;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {          // newest first: retries usually concern recent rows
    if (ids[i][0] === id) {
      var v = sh.getRange(i + 2, 1, 1, HEADERS.length).getValues()[0];
      return { index: i + 2, row: rowObj_(v) };
    }
  }
  return null;
}

function appendRow_(row, extra) {
  row = Object.assign({}, row, extra || {});
  var sh = sheet_(TX_SHEET);
  var out = HEADERS.map(function (h) { return row[h] == null ? '' : row[h]; });
  sh.appendRow(out);
}

function normalise_(entry, cfg) {
  var e = entry || {};
  var emails = cfg.users.map(function (u) { return u.email; });
  var row = {
    id: String(e.id || Utilities.getUuid()),
    created_at: new Date().toISOString(),
    date: String(e.date || ''),
    type: e.type,
    description: String(e.description || '').trim().slice(0, 200),
    amount_pence: Number(e.amount_pence),
    paid_by: String(e.paid_by || '').toLowerCase(),
    other_share_pct: e.type === 'settlement' ? 100 : Number(e.other_share_pct),
    pot: String(e.pot || '').trim().slice(0, 40),
    status: 'active',
  };
  var err = validate_(row, emails);
  if (err) throw fail_('invalid', err);
  // Text going into a sheet must never be interpreted as a formula.
  row.description = row.description.replace(/^[=+\-@]/, "'$&");
  row.pot = row.pot.replace(/^[=+\-@]/, "'$&");
  return row;
}

/** Mirrors docs/ledger.js validate(); kept in sync by tests/parity.test.js */
function validate_(e, emails) {
  if (e.type !== 'expense' && e.type !== 'settlement') return 'Unknown type';
  if (!isFinite(e.amount_pence) || Math.floor(e.amount_pence) !== e.amount_pence || e.amount_pence <= 0) return 'Amount must be more than zero';
  if (e.amount_pence > 100000000) return 'Amount is unreasonably large';
  if (emails.indexOf(e.paid_by) === -1) return 'Unknown payer';
  if (!e.pot || !String(e.pot).trim()) return 'Pick a pot';
  if (e.type === 'expense') {
    if (!e.description || !String(e.description).trim()) return 'Add a description';
    if (typeof e.other_share_pct !== 'number' || !(e.other_share_pct >= 0 && e.other_share_pct <= 100)) return 'Share must be between 0 and 100';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) return 'Bad date';
  return null;
}

/** Mirrors docs/ledger.js balances(). */
function balances_(rows, emailA, emailB) {
  var out = {};
  rows.forEach(function (r) {
    if (r.status === 'void') return;
    var sign = r.paid_by === emailA ? 1 : r.paid_by === emailB ? -1 : 0;
    if (!sign) return;
    var delta = r.type === 'settlement' ? r.amount_pence : Math.round(r.amount_pence * r.other_share_pct / 100);
    out[r.pot] = (out[r.pot] || 0) + sign * delta;
  });
  return out;
}

function potNames_() {
  var sh = sheet_(POT_SHEET);
  var last = sh.getLastRow();
  if (last < 2) return ['Main'];
  return sh.getRange(2, 1, last - 1, 2).getValues()
    .filter(function (r) { return r[0] && String(r[1]).toLowerCase() !== 'archived'; })
    .map(function (r) { return String(r[0]); });
}

function ensurePot_(name) {
  var sh = sheet_(POT_SHEET);
  var names = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); });
  if (names.indexOf(name) === -1) sh.appendRow([name, 'active']);
}

function locked_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw fail_('busy', 'Busy, please try again');
  try { return fn(); } finally { lock.releaseLock(); }
}

function fail_(code, message) { var e = new Error(message); e.code = code; return e; }
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ───────────── notifications ───────────── */

function money_(pence, cur) {
  var abs = Math.abs(pence);
  return (pence < 0 ? '-' : '') + cur + (Math.floor(abs / 100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + ('0' + (abs % 100)).slice(-2);
}

function lineFor_(net, viewer, a, b, cur) {
  if (net === 0) return 'all settled up';
  var debtor = net > 0 ? b : a, creditor = net > 0 ? a : b;
  var amt = money_(Math.abs(net), cur);
  if (viewer.email === debtor.email) return 'you owe ' + creditor.name + ' ' + amt;
  return debtor.name + ' owes you ' + amt;
}

/** Weekly trigger. Emails both people their own view of where they stand. */
function weeklyDigest() {
  var cfg = config_();
  var a = cfg.users[0], b = cfg.users[1];
  var rows = readRows_();
  var net = balances_(rows, a.email, b.email);
  var pots = potNames_();
  var weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  var recent = rows.filter(function (r) { return r.status !== 'void' && r.created_at >= weekAgo && r.type === 'expense'; });
  var total = pots.reduce(function (s, p) { return s + Math.abs(net[p] || 0); }, 0);

  cfg.users.forEach(function (viewer) {
    var lines = pots.map(function (p) { return '• ' + p + ': ' + lineFor_(net[p] || 0, viewer, a, b, cfg.currency); });
    var body = 'Where you stand this week:\n\n' + lines.join('\n') +
      '\n\n' + recent.length + ' expense' + (recent.length === 1 ? '' : 's') + ' added in the last 7 days.';
    var subject = total === 0 ? 'Settle Up: all square' : 'Settle Up: ' + lineFor_(net[pots[0]] || 0, viewer, a, b, cfg.currency);
    MailApp.sendEmail({ to: viewer.email, subject: subject, body: body, name: 'Settle Up' });
  });

  if (cfg.discord) {
    var msg = 'Settle Up weekly update\n' + pots.map(function (p) {
      var n = net[p] || 0;
      return p + ': ' + (n === 0 ? 'settled' : (n > 0 ? b.name + ' owes ' + a.name : a.name + ' owes ' + b.name) + ' ' + money_(Math.abs(n), cfg.currency));
    }).join('\n');
    UrlFetchApp.fetch(cfg.discord, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ content: msg }), muteHttpExceptions: true });
  }
}

function notifySettle_(me, cfg, settled, net) {
  try {
    var other = cfg.users.filter(function (u) { return u.email !== me; })[0];
    var who = cfg.users.filter(function (u) { return u.email === me; })[0];
    var parts = Object.keys(settled).map(function (p) {
      var left = Math.abs(net[p]) - settled[p];
      return p + ': ' + money_(settled[p], cfg.currency) + (left > 0 ? ' (part payment, ' + money_(left, cfg.currency) + ' still owed)' : ' (settled)');
    });
    MailApp.sendEmail({ to: other.email, subject: 'Settle Up: ' + who.name + ' recorded a payment',
      body: who.name + ' recorded a payment.\n\n' + parts.join('\n'), name: 'Settle Up' });
  } catch (e) { console.error('notifySettle failed', e); }
}

/* ───────────── one-off setup ───────────── */

function setup() {
  var ss = ss_();
  var tx = ss.getSheetByName(TX_SHEET) || ss.insertSheet(TX_SHEET);
  if (tx.getLastRow() === 0) {
    tx.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    tx.setFrozenRows(1);
  }
  var pots = ss.getSheetByName(POT_SHEET) || ss.insertSheet(POT_SHEET);
  if (pots.getLastRow() === 0) {
    pots.getRange(1, 1, 1, 2).setValues([['pot', 'status']]).setFontWeight('bold');
    pots.appendRow(['Main', 'active']);
  }
  config_();   // throws a clear error if Script Properties are missing
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'weeklyDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('weeklyDigest').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(12).create();
  console.log('Setup complete.');
}
