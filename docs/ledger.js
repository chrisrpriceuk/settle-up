/* Settle Up: ledger core. Pure functions, no I/O. All money is integer pence.
 *
 * Model (two people, A and B, any number of named pots):
 *   expense:    `paid_by` paid `amount_pence`; the OTHER person owes other_share_pct% of it.
 *               50 = split evenly, 100 = it was entirely the other person's, 0 = personal.
 *   settlement: `paid_by` transferred `amount_pence` to the other person to reduce a debt.
 *   status 'void' rows are ignored (history is never deleted).
 *
 * net(pot) > 0  => B owes A      net(pot) < 0  => A owes B
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ledger = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toPence(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : NaN;
    const s = String(v == null ? '' : v).replace(/[£$€,\s]/g, '');
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    return Math.round(parseFloat(s) * 100);
  }

  function fmt(pence, symbol) {
    const sym = symbol == null ? '£' : symbol;
    const sign = pence < 0 ? '-' : '';
    const abs = Math.abs(pence);
    const pounds = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + sym + pounds + '.' + String(abs % 100).padStart(2, '0');
  }

  /** The other person's share of an expense, in pence. */
  function share(amountPence, pct) {
    return Math.round((amountPence * pct) / 100);
  }

  /** Returns an error string, or null if the entry is acceptable. */
  function validate(e, emails) {
    if (!e || typeof e !== 'object') return 'Missing entry';
    if (e.type !== 'expense' && e.type !== 'settlement') return 'Unknown type';
    if (!Number.isInteger(e.amount_pence) || e.amount_pence <= 0) return 'Amount must be more than zero';
    if (e.amount_pence > 100000000) return 'Amount is unreasonably large';
    if (emails && emails.indexOf(e.paid_by) === -1) return 'Unknown payer';
    if (!e.pot || !String(e.pot).trim()) return 'Pick a pot';
    if (e.type === 'expense') {
      if (!e.description || !String(e.description).trim()) return 'Add a description';
      const p = e.other_share_pct;
      if (typeof p !== 'number' || !(p >= 0 && p <= 100)) return 'Share must be between 0 and 100';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) return 'Bad date';
    return null;
  }

  /** Net per pot from userA's point of view. Returns { potName: pence }. */
  function balances(rows, emailA, emailB) {
    const out = {};
    for (const r of rows) {
      if (r.status === 'void') continue;
      const sign = r.paid_by === emailA ? 1 : r.paid_by === emailB ? -1 : 0;
      if (!sign) continue;
      const delta = r.type === 'settlement' ? r.amount_pence : share(r.amount_pence, r.other_share_pct);
      out[r.pot] = (out[r.pot] || 0) + sign * delta;
    }
    return out;
  }

  /** Plain-English view of one pot's net. */
  function describe(net, a, b) {
    if (net === 0) return { settled: true, debtor: null, creditor: null, amount: 0 };
    return net > 0
      ? { settled: false, debtor: b, creditor: a, amount: net }
      : { settled: false, debtor: a, creditor: b, amount: -net };
  }

  /** Settlement rows (without ids) that bring the given pots to zero. */
  function settlementPlan(net, a, b, pots, date) {
    const plan = [];
    for (const pot of pots) {
      const n = net[pot] || 0;
      if (n === 0) continue;
      const d = describe(n, a, b);
      plan.push({
        type: 'settlement', date: date, pot: pot, description: 'Settle up',
        amount_pence: d.amount, paid_by: d.debtor.email, other_share_pct: 100,
      });
    }
    return plan;
  }

  return { toPence, fmt, share, validate, balances, describe, settlementPlan };
});
