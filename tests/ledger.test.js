const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../docs/ledger.js');

const A = 'chris@x.com', B = 'natalie@x.com';
const ua = { name: 'Chris', email: A }, ub = { name: 'Natalie', email: B };
const ex = (paid_by, amt, pct, pot = 'Main', extra = {}) =>
  Object.assign({ type: 'expense', paid_by, amount_pence: amt, other_share_pct: pct, pot, status: 'active', date: '2026-01-01', description: 'x' }, extra);

test('toPence handles messy input', () => {
  assert.equal(L.toPence('£10.00'), 1000);
  assert.equal(L.toPence('1,234.5'), 123450);
  assert.equal(L.toPence('10'), 1000);
  assert.equal(L.toPence(89.23), 8923);
  assert.equal(L.toPence('abc'), NaN);
  assert.equal(L.toPence(''), NaN);
});

test('fmt', () => {
  assert.equal(L.fmt(120054), '£1,200.54');
  assert.equal(L.fmt(5), '£0.05');
  assert.equal(L.fmt(-2000), '-£20.00');
});

test('even split: payer is owed half', () => {
  assert.deepEqual(L.balances([ex(A, 1000, 50)], A, B), { Main: 500 });
  assert.deepEqual(L.balances([ex(B, 1000, 50)], A, B), { Main: -500 });
});

test('100% means the other person owes it all; 0% means personal', () => {
  assert.equal(L.balances([ex(A, 3000, 100)], A, B).Main, 3000);
  assert.equal(L.balances([ex(A, 3000, 0)], A, B).Main, 0);
});

test('odd pence split rounds once, consistently', () => {
  // Tesco £89.23 at 50% -> 4461.5p -> rounds to 4462
  assert.equal(L.balances([ex(B, 8923, 50)], A, B).Main, -4462);
});

test('voided rows are ignored', () => {
  assert.deepEqual(L.balances([ex(A, 1000, 50, 'Main', { status: 'void' })], A, B), {});
});

test('pots are independent', () => {
  const rows = [ex(A, 1000, 50, 'Main'), ex(A, 100000, 50, 'Holiday'), ex(B, 400, 50, 'Dog')];
  assert.deepEqual(L.balances(rows, A, B), { Main: 500, Holiday: 50000, Dog: -200 });
});

test('settle up zeroes every pot, in both directions', () => {
  const rows = [ex(A, 1000, 50, 'Main'), ex(B, 5000, 50, 'Holiday'), ex(A, 777, 100, 'Dog')];
  const net = L.balances(rows, A, B);
  const plan = L.settlementPlan(net, ua, ub, Object.keys(net), '2026-02-01');
  const after = L.balances(rows.concat(plan.map(p => Object.assign({ status: 'active' }, p))), A, B);
  for (const pot of Object.keys(net)) assert.equal(after[pot], 0, pot);
  // Natalie owes Chris on Main and Dog, so she pays there; Chris owes on Holiday
  const byPot = Object.fromEntries(plan.map(p => [p.pot, p]));
  assert.equal(byPot.Main.paid_by, B);
  assert.equal(byPot.Holiday.paid_by, A);
  assert.equal(byPot.Dog.amount_pence, 777);
});

test('settle plan skips already-settled pots', () => {
  assert.deepEqual(L.settlementPlan({ Main: 0 }, ua, ub, ['Main'], '2026-02-01'), []);
});

test('voiding a settlement restores the debt', () => {
  const rows = [ex(A, 1000, 50)];
  const s = { type: 'settlement', paid_by: B, amount_pence: 500, pot: 'Main', status: 'active' };
  assert.equal(L.balances(rows.concat(s), A, B).Main, 0);
  assert.equal(L.balances(rows.concat(Object.assign({}, s, { status: 'void' })), A, B).Main, 500);
});

test('validate', () => {
  const ok = ex(A, 1000, 50);
  assert.equal(L.validate(ok, [A, B]), null);
  assert.ok(L.validate(Object.assign({}, ok, { amount_pence: 0 }), [A, B]));
  assert.ok(L.validate(Object.assign({}, ok, { amount_pence: 10.5 }), [A, B]));
  assert.ok(L.validate(Object.assign({}, ok, { other_share_pct: 101 }), [A, B]));
  assert.ok(L.validate(Object.assign({}, ok, { paid_by: 'eve@x.com' }), [A, B]));
  assert.ok(L.validate(Object.assign({}, ok, { description: ' ' }), [A, B]));
  assert.ok(L.validate(Object.assign({}, ok, { date: '01/01/2026' }), [A, B]));
});
