// Runs the real Code.gs settle_ against in-memory stand-ins for the spreadsheet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const A = 'a@x.com', B = 'b@x.com';
function server(rows) {
  let n = 0; const written = [];
  const ctx = vm.createContext({ console, Utilities: { getUuid: () => 'gen' + (++n) }, PropertiesService: {}, SpreadsheetApp: {}, LockService: {}, ContentService: {}, ScriptApp: {} });
  vm.runInContext(fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8'), ctx);
  ctx.config_ = () => ({ users: [{ name: 'A', email: A }, { name: 'B', email: B }], currency: '£', clientId: 'c' });
  ctx.readRows_ = () => rows.concat(written);
  ctx.appendRow_ = (r, extra) => written.push(Object.assign({ status: 'active', group_id: '' }, r, extra));
  ctx.state_ = () => ({ fresh: true });
  return { ctx, written };
}
const exp = (paid_by, amt, pot = 'Main') => ({ id: 'e' + Math.random(), type: 'expense', paid_by, amount_pence: amt, other_share_pct: 50, pot, status: 'active', group_id: '', date: '2026-01-01', description: 'x' });
const J = (o) => JSON.parse(JSON.stringify(o));   // vm objects have a foreign prototype

test('full settle writes one row for the whole balance', () => {
  const { ctx, written } = server([exp(B, 10000)]);        // B paid 100 @50% -> A owes B 50
  const r = J(ctx.settle_(A, { Main: -5000 }, '2026-02-01', 'g1', { Main: 's1' }));
  assert.equal(r.ok, true); assert.deepEqual(r.settled, { Main: 5000 });
  assert.equal(written.length, 1);
  assert.equal(written[0].amount_pence, 5000); assert.equal(written[0].paid_by, A);
  assert.equal(written[0].id, 's1'); assert.equal(written[0].description, 'Settle up');
});

test('part payment writes the smaller amount, labelled, and leaves the rest owed', () => {
  const { ctx, written } = server([exp(B, 10000)]);
  const r = J(ctx.settle_(A, { Main: -5000 }, '2026-02-01', 'g1', { Main: 's1' }, { Main: 2000 }));
  assert.deepEqual(r.settled, { Main: 2000 });
  assert.equal(written[0].amount_pence, 2000); assert.equal(written[0].description, 'Part payment');
  const net = J(ctx.balances_(ctx.readRows_(), A, B));
  assert.equal(net.Main, -3000);                             // 30.00 still owed
});

test('rejects overpaying, zero, negative and fractional pence; writes nothing', () => {
  for (const bad of [5001, 0, -100, 10.5, 'abc']) {
    const { ctx, written } = server([exp(B, 10000), exp(A, 4000, 'Holiday')]);
    assert.throws(() => ctx.settle_(A, { Main: -5000, Holiday: 2000 }, '2026-02-01', 'g', {}, { Main: bad }), /no more than what is owed|invalid|owed/);
    assert.equal(written.length, 0, 'nothing written for ' + bad);
  }
});

test('a retried settle (same group) is a no-op', () => {
  const { ctx, written } = server([exp(B, 10000)]);
  ctx.settle_(A, { Main: -5000 }, '2026-02-01', 'g1', { Main: 's1' });
  const again = J(ctx.settle_(A, { Main: -5000 }, '2026-02-01', 'g1', { Main: 's1' }));
  assert.equal(again.duplicate, true); assert.equal(written.length, 1);
});

test('a stale expected balance is refused with fresh state', () => {
  const { ctx, written } = server([exp(B, 10000), exp(B, 4000)]);   // balance is now -7000
  const r = J(ctx.settle_(A, { Main: -5000 }, '2026-02-01', 'g1', {}));
  assert.equal(r.code, 'conflict'); assert.deepEqual(r.state, { fresh: true }); assert.equal(written.length, 0);
});

test('settling several pots with different part amounts', () => {
  const { ctx, written } = server([exp(B, 10000), exp(A, 6000, 'Holiday')]);    // Main: A owes 50; Holiday: B owes 30
  const r = J(ctx.settle_(A, { Main: -5000, Holiday: 3000 }, '2026-02-01', 'g', { Main: 'm', Holiday: 'h' }, { Main: 5000, Holiday: 1000 }));
  assert.deepEqual(r.settled, { Main: 5000, Holiday: 1000 });
  const by = Object.fromEntries(written.map((w) => [w.pot, w]));
  assert.equal(by.Main.paid_by, A); assert.equal(by.Holiday.paid_by, B);
});
