// The October 2026 budget split (discretionary $500 → $400 plus a separate
// emergencies / unplanned budget) is implemented three times: the app, the
// Worker that feeds the phone, and the mobile snapshot PWA. These tests pin the
// three to the same answers so a change to one can't silently drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));
const BUILTINS = { console, Date, Math, JSON, Number, String, Object, Array, Intl, Set, Boolean, isNaN };
// vm contexts have their own Array/Object prototypes, so deep-equal needs plain values.
const plain = value => JSON.parse(JSON.stringify(value));

function app() {
  const html = read('index.html');
  const context = vm.createContext({
    ...BUILTINS,
    appTodayIso: () => '2026-10-15', CURRENT_YEAR: 2026,
    state: { momBudget: null }, crypto: { randomUUID: () => 'id' },
    localStorage: { getItem: () => null, setItem: () => {} },
    fmt: value => `$${Number(value).toFixed(2)}`, escHtml: String, escAttr: String,
  });
  vm.runInContext(between(html, '// ── View: Mom Budget', '// ── Solar ROI'), context);
  return context;
}

function worker() {
  const context = vm.createContext({ ...BUILTINS });
  vm.runInContext(between(read('cloudflare/src/worker.js'), 'const MOM_BUDGET_DEFAULT', '// ── Investment Return'), context);
  return context;
}

function mobile(raw, month) {
  const html = read('mobile/index.html');
  const context = vm.createContext({
    Date, state: { data: { mom: raw }, momMonth: month },
    n: value => Number(value) || 0,
    sum: rows => rows.reduce((total, row) => total + (Number(row.amount) || 0), 0),
    money: String, fullMoney: String, esc: String,
    row: (...values) => values.join(' '), card: (...values) => values.join(' '), stat: (...values) => values.join(' '),
  });
  vm.runInContext(between(html, '  function momExpected(', '  function renderProperties('), context);
  return context;
}

// A record saved before the split: no schedule, no emergency budget or ledger.
const legacyRecord = () => ({
  template: {
    income: [{ id: 'ss', name: 'Social Security', amount: 2092.5 }],
    fixed: [
      { id: 'fair-share', name: 'Fair Share (household)', amount: 900, frequency: 'monthly', auto: true, locked: true },
      { id: 'medical', name: 'CoPays / Prescriptions', amount: 140, frequency: 'monthly' },
    ],
    variable: { discretionary: 500 },
  },
  months: {
    '2026-09': {
      fixedPaid: { medical: true }, fixedActual: { medical: 140 },
      discretionary: [{ id: 'a', date: '2026-09-05', amount: 212.4, name: 'Target' }],
      otherExpenses: [],
    },
    '2026-10': {
      fixedPaid: { medical: true, 'fair-share': true }, fixedActual: { medical: 155 },
      discretionary: [{ id: 'b', date: '2026-10-03', amount: 88.12, name: 'Pharmacy' }],
      emergency: [{ id: 'e', date: '2026-10-08', amount: 240, name: 'Urgent care' }],
      otherExpenses: [],
    },
  },
});

test('October 2026 splits the allowance into a $400 discretionary and a $200 emergency budget', () => {
  const a = app();
  a.state.momBudget = a.mbNormalize(legacyRecord());
  // September ran as one $800 lump and is the only month that will.
  assert.equal(a.mbVariableAmount('discretionary', '2026-09'), 800);
  assert.equal(a.mbVariableAmount('emergency', '2026-09'), 0);
  assert.equal(a.mbVariableAmount('discretionary', '2026-10'), 400);
  assert.equal(a.mbVariableAmount('emergency', '2026-10'), 200);
  assert.equal(a.mbVariableAmount('discretionary', '2027-06'), 400);
  assert.equal(a.mbVariableAmount('emergency', '2027-06'), 200);
  // The allowance is always the itemized budgets added up, so Month Math's
  // "Spending allowance" row always equals the budget rows above it.
  assert.equal(a.mbTrackingAllowance('2026-09'), 800);
  assert.equal(a.mbTrackingAllowance('2026-10'), 600);
});

test('September keeps the $800 lump it was tracked against', () => {
  const a = app();
  a.state.momBudget = a.mbNormalize(legacyRecord());
  const september = a.mbCalcMonth('2026-09');
  assert.equal(september.discretionary, 800);
  assert.equal(september.emergency, 0);
  assert.equal(september.trackingAllowance, 800);
  assert.equal(september.trackingUsed, 352.4);       // $140 copays + $212.40 discretionary
  assert.equal(Math.round(september.trackingRemaining * 100) / 100, 447.6);
});

test('the spending allowance always equals the budget rows shown above it', () => {
  const a = app();
  a.state.momBudget = a.mbNormalize(legacyRecord());
  for (const month of ['2026-09', '2026-10', '2027-04']) {
    const c = a.mbCalcMonth(month);
    assert.equal(c.trackingAllowance, c.discretionary + c.emergency, month);
  }
  // Still true after the budgets are edited mid-stream.
  a.mbSetVariableAmount('emergency', '2026-11', 275);
  const november = a.mbCalcMonth('2026-11');
  assert.equal(november.trackingAllowance, 400 + 275);
});

test('each month gets its own ledgers, so a new month starts empty and earlier ones stay readable', () => {
  const a = app();
  a.state.momBudget = a.mbNormalize(legacyRecord());
  vm.runInContext("_mbMonth = '2026-11'", a);
  assert.equal(a.mbCalcMonth('2026-11').discretionarySpent, 0);
  assert.equal(a.mbCalcMonth('2026-11').emergencySpent, 0);
  assert.deepEqual(plain(a.mbLedgerHistory('discretionary')),
    [{ monthKey: '2026-10', count: 1, total: 88.12 }, { monthKey: '2026-09', count: 1, total: 212.4 }]);
  assert.deepEqual(plain(a.mbLedgerHistory('emergency')), [{ monthKey: '2026-10', count: 1, total: 240 }]);
  // The history only looks backwards from the month on screen.
  vm.runInContext("_mbMonth = '2026-09'", a);
  assert.equal(a.mbLedgerHistory('discretionary').length, 0);
});

test('editing a budget applies from the month on screen forward and never rewrites tracked months', () => {
  const a = app();
  a.state.momBudget = a.mbNormalize(legacyRecord());
  a.mbSetVariableAmount('discretionary', '2027-01', 450);
  assert.equal(a.mbVariableAmount('discretionary', '2026-09'), 800);
  assert.equal(a.mbVariableAmount('discretionary', '2026-12'), 400);
  assert.equal(a.mbVariableAmount('discretionary', '2027-01'), 450);
  // Setting it back to the amount already in effect drops the redundant entry.
  a.mbSetVariableAmount('discretionary', '2027-01', 400);
  assert.deepEqual(plain(a.mbVariableSchedule('discretionary')),
    [{ from: '2026-09', amount: 800 }, { from: '2026-10', amount: 400 }]);
});

test('a record seeded by the first pass is corrected to the September lump', () => {
  const a = app();
  const halfMigrated = legacyRecord();
  halfMigrated.template.octoberBudgetV1 = true;   // first pass ran, v2 has not
  halfMigrated.template.variable.emergency = 0;
  halfMigrated.template.variableSchedule = {
    discretionary: [{ from: '2026-10', amount: 400 }],
    emergency: [{ from: '2026-09', amount: 200 }],   // landed on September by mistake
  };
  a.state.momBudget = a.mbNormalize(halfMigrated);
  assert.equal(a.mbTrackingAllowance('2026-09'), 800);
  assert.equal(a.mbVariableAmount('emergency', '2026-09'), 0);
  assert.equal(a.mbTrackingAllowance('2026-10'), 600);
});

test('re-normalizing an already-migrated record keeps the owner\'s edits', () => {
  const a = app();
  a.state.momBudget = a.mbNormalize(legacyRecord());
  a.mbSetVariableAmount('emergency', '2026-10', 325);
  const saved = JSON.parse(JSON.stringify(a.state.momBudget));
  a.state.momBudget = a.mbNormalize(saved);
  assert.equal(a.mbVariableAmount('emergency', '2026-10'), 325);
});

test('the Worker feeding the phone computes the same numbers as the app', () => {
  const a = app(), w = worker();
  a.state.momBudget = a.mbNormalize(legacyRecord());
  const data = w.normalizeMomBudget(legacyRecord());
  const fields = ['discretionary', 'emergency', 'discretionarySpent', 'emergencySpent', 'emergencyRemaining',
    'discretionaryRemaining', 'discretionaryAdjusted', 'otherOverages', 'trackingAllowance',
    'trackingUsed', 'trackingRemaining', 'trackingUsedPercent', 'overallSpendingRemaining'];
  for (const month of ['2026-09', '2026-10', '2026-11']) {
    const fromApp = a.mbCalcMonth(month), fromWorker = w.calcMomBudgetMonth(data, month);
    for (const field of fields) {
      assert.equal(fromWorker[field], fromApp[field], `${month}.${field}`);
    }
  }
  // The year adds up each month's own allowance ($800 Sept + $600 Oct).
  assert.equal(w.calcMomBudgetYear(data, '2026-10').planned, 1400);
});

test('emergency spending reaches the phone as its own transaction group', () => {
  const w = worker();
  const data = w.normalizeMomBudget(legacyRecord());
  const transactions = w.momBudgetMonthTransactions(data, '2026-10');
  const emergency = transactions.find(entry => entry.group === 'Emergencies / Unplanned');
  assert.deepEqual([String(emergency.name), Number(emergency.amount)], ['Urgent care', 240]);
  assert.ok(!transactions.some(entry => entry.id === 'fixed-fair-share'), 'Fair Share stays a reference transfer');
});

test('the phone page shows the allowance and discretionary, and never mentions emergencies', () => {
  const html = read('mom-budget-phone.html');
  assert.doesNotMatch(html, /\$800 monthly allowance/);
  for (const id of ['overall-allowance', 'discretionary-left', 'discretionary-spent', 'discretionary-budget']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /els\.overallAllowance\.textContent = money\(month\.trackingAllowance\)/);
  // Her phone deliberately carries no emergencies / unplanned card.
  assert.doesNotMatch(html, /emergenc/i);
});

test('the mobile snapshot mirrors the split, including for a record saved before it', () => {
  const raw = legacyRecord();
  const c = mobile(raw, '2026-10');
  assert.equal(c.momVariable(raw, 'discretionary', '2026-09'), 500);
  assert.equal(c.momVariable(raw, 'discretionary', '2026-10'), 400);
  assert.equal(c.momVariable(raw, 'emergency', '2026-10'), 200);
  const october = c.momMonth(raw, '2026-10');
  assert.equal(october.budget, 600);
  assert.equal(october.discretionaryLeft, 400 - 88.12);
  assert.equal(october.emergencyLeft, 200 - 240);
  assert.equal(october.left, 600 - 88.12 - 240);
  assert.match(c.renderMom(), /Emergencies \/ unplanned/);
  // A record the desktop has already re-saved uses its stored schedule instead.
  const edited = legacyRecord();
  edited.template.variableSchedule = { discretionary: [{ from: '2026-10', amount: 425 }], emergency: [{ from: '2026-10', amount: 200 }] };
  assert.equal(mobile(edited, '2026-10').momVariable(edited, 'discretionary', '2026-10'), 425);
});

// The phone page pins its own inline script with a CSP sha256 hash, so any edit
// to that script silently blocks the whole page until the hash is regenerated.
test('the phone page CSP hash still matches its inline script', () => {
  const html = read('mom-budget-phone.html');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const digest = `sha256-${createHash('sha256').update(script).digest('base64')}`;
  const pinned = html.match(/script-src 'self' '(sha256-[A-Za-z0-9+/=]+)'/)[1];
  assert.equal(pinned, digest,
    `Regenerate the CSP hash in mom-budget-phone.html: script-src 'self' '${digest}'`);
});
