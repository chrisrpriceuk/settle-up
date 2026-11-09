// Guards against the server (Code.gs) and the app (ledger.js) drifting apart:
// same balances and same validation verdicts on lots of random ledgers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const L = require('../docs/ledger.js');

const ctx = vm.createContext({ console, Utilities: {}, PropertiesService: {}, SpreadsheetApp: {}, LockService: {}, ContentService: {}, ScriptApp: {} });
vm.runInContext(fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8'), ctx);

const A = 'a@x.com', B = 'b@x.com';
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

function randomRow() {
  const settle = rnd() < 0.2;
  return {
    type: settle ? 'settlement' : 'expense',
    paid_by: pick([A, B]),
    amount_pence: Math.floor(rnd() * 50000) + 1,
    other_share_pct: settle ? 100 : pick([0, 25, 33, 50, 60, 66.5, 75, 100]),
    pot: pick(['Main', 'Holiday', 'Dog']),
    status: rnd() < 0.15 ? 'void' : 'active',
    description: 'd', date: '2026-03-04',
  };
}

test('balances agree on random ledgers', () => {
  for (let i = 0; i < 300; i++) {
    const rows = Array.from({ length: 1 + Math.floor(rnd() * 40) }, randomRow);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.balances_(rows, A, B))), L.balances(rows, A, B));
  }
});

test('validation verdicts agree', () => {
  const bad = [
    {}, { amount_pence: 0 }, { amount_pence: 1.5 }, { amount_pence: -5 }, { amount_pence: 1e12 },
    { paid_by: 'eve@x.com' }, { pot: '' }, { description: '' }, { other_share_pct: 101 },
    { other_share_pct: -1 }, { date: '4/3/2026' }, { type: 'gift' },
  ];
  for (let i = 0; i < 200; i++) {
    const row = Object.assign(randomRow(), pick([{}, ...bad]));
    assert.equal(!!ctx.validate_(row, [A, B]), !!L.validate(row, [A, B]), JSON.stringify(row));
  }
});

test('gmail dots and +tags do not change identity; other domains are untouched', () => {
  const n = ctx.normEmail_;
  assert.equal(n('Mrs.Natalie.Price@gmail.com'), n('mrsnataliePrice@googlemail.com'));
  assert.equal(n('chris+bills@gmail.com'), n('c.hris@gmail.com'));
  assert.notEqual(n('a.b@example.com'), n('ab@example.com'));
  assert.notEqual(n('chris@gmail.com'), n('natalie@gmail.com'));
});
