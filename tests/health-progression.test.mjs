import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const desktop = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const mobile = readFileSync(new URL('../mobile/index.html', import.meta.url), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const section = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const shared = source => section(source, '// ── Health gradual restart (', '// ── End Health gradual restart');

function harness(today = '2026-09-08', phone = false) {
  const c = vm.createContext({
    crypto: webcrypto, localStorage: { getItem: () => null, setItem() {} },
    state: { health: null, data: {} }, appTodayIso: () => today,
    document: { getElementById: () => null },
    escHtml: String, escAttr: String, esc: String,
    fmtDate: iso => iso, fmt: n => '$' + n, fmtShort: String,
    n: x => Number(x) || 0, sum: (rows, fn) => rows.reduce((s, x) => s + fn(x), 0),
    showBrandedNotice() {}, callApi: async () => ({}),
  });
  vm.runInContext(phone
    ? section(mobile, '  // ── Health (daily', '\n  function render(){')
    : section(desktop, '// ── View: Health ', '// ── Monthly Budget: Fair Share section'), c);
  if (!phone) { c.healthCelebrate = () => {}; c._renderHealthHtml = () => {}; }
  return c;
}

test('both pages compile and use identical restart/progression rules', () => {
  for (const html of [desktop, mobile]) {
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  }
  assert.equal(shared(desktop), shared(mobile));
});

test('Sep 14 restart clears dated records once and retains reusable settings', () => {
  const c = harness();
  const old = c.healthDefault();
  old.profile.startDate = '2026-09-07';
  old.profile.sept2026ResetV1 = true;
  old.profile.goalWeight = 160;
  old.days = { '2026-09-07': { closed: true }, '2026-09-15': { note: 'old planning' } };
  old.weighIns = [{ date: '2026-09-07', weight: 180 }];
  old.foods.push({ id: 'custom-food', name: 'My lunch', calories: 325 });
  old.mealPlan['1'] = [{ id: 'custom-meal', name: 'My meal', calories: 325 }];
  old.rewardSchedule['2'] = { am: 'Coffee', pm: 'Movie' };
  old.workoutPlan['2'] = old.workoutPlan['2'].filter(e => e.id !== 'tu-curl');
  old.workoutPlan['2'].push({ id: 'custom', name: 'My exercise', detail: '1 × 6' });
  const h = c.healthNormalize(old);
  assert.equal(h.profile.startDate, '2026-09-14');
  assert.equal(c.healthWeekday(h.profile.startDate), 1);
  assert.equal(h.profile.goalWeight, 160);
  assert.deepEqual(copy(h.days), {});
  assert.deepEqual(copy(h.weighIns), []);
  assert.equal(h.foods.find(f => f.id === 'custom-food').calories, 325);
  assert.equal(h.mealPlan['1'][0].name, 'My meal');
  assert.deepEqual(copy(h.rewardSchedule['2']), { am: 'Coffee', pm: 'Movie' });
  assert.ok(!h.workoutPlan['2'].some(e => e.id === 'tu-curl'));
  assert.equal(h.workoutPlan['2'].find(e => e.id === 'custom').detail, '1 × 6');
  h.days['2026-09-14'] = { closed: true, workoutsDone: { 'mo-pu': true, 'mo-walk': true } };
  h.weighIns.push({ date: '2026-09-14', weight: 181 });
  h.profile.startDate = '2026-09-21';
  assert.deepEqual(copy(c.healthNormalize(copy(h))), copy(h));
});

test('first fortnight is a walk and one strength set, with an easy Wednesday and rest weekends', () => {
  const c = harness(), h = c.healthNormalize({});
  assert.equal(c.healthWorkoutsForDate('2026-09-13', h).length, 0);
  for (let offset = 0; offset < 14; offset++) {
    const iso = c.healthAddDays('2026-09-14', offset);
    const wd = c.healthWeekday(iso), exs = c.healthWorkoutsForDate(iso, h);
    assert.equal(exs.length, wd === 0 || wd === 6 ? 0 : wd === 3 ? 1 : 2, iso);
    assert.ok(exs.every(e => c.healthExerciseSets(e) === 1), iso);
    for (const e of exs.filter(e => e.ramp.kind === 'walk')) assert.match(e.detail, /^10 min/);
  }
});

test('equipment rules keep pushups regular and use only the available equipment', () => {
  const c = harness(), h = c.healthNormalize({});
  const firstMonday = c.healthWorkoutsForDate('2026-09-14', h);
  const firstThursday = c.healthWorkoutsForDate('2026-09-17', h);
  assert.equal(firstMonday.find(e => e.ramp.kind === 'push').name, 'Push-Ups');
  assert.match(firstMonday.find(e => e.ramp.kind === 'push').detail, /regular push-ups/i);
  assert.equal(firstThursday.find(e => e.ramp.kind === 'push').name, 'Push-Ups');
  assert.doesNotMatch(firstMonday.find(e => e.ramp.kind === 'push').detail, /wall|incline|decline/i);
  assert.equal(c.healthWorkoutsForDate('2026-10-12', h).find(e => e.id === 'mo-cp').name, 'Bench Press');
  assert.equal(c.healthWorkoutsForDate('2026-11-09', h).find(e => e.id === 'mo-roll').name, 'Ab Wheel');
  const allPlan = Object.values(h.workoutPlan).flat();
  assert.ok(allPlan.every(e => !/band/i.test(e.name || '') || /biceps\s*curl/i.test(e.name || '')));
  assert.equal(h.profile.healthEquipmentV1, true);
});

test('requirements progress by the selected date across month and DST boundaries, with caps', () => {
  const c = harness(), h = c.healthNormalize({});
  const boundaries = ['2026-09-14', '2026-09-28', '2026-10-12', '2026-10-26', '2026-11-09', '2026-11-23'];
  for (const [i, iso] of boundaries.entries()) {
    const exs = c.healthWorkoutsForDate(iso, h);
    assert.equal(c.healthProgramWeek(iso, h), i * 2 + 1);
    assert.equal(exs.length, i + 2);
    assert.match(exs.find(e => e.ramp.kind === 'walk').detail, new RegExp('^' + Math.min(30, 10 + i * 5) + ' min'));
    assert.ok(exs.filter(e => e.ramp.startWeek === i * 2 + 1).every(e => e.sets === 1));
  }
  assert.equal(c.healthProgramWeek('2026-11-01', h), 7);
  assert.equal(c.healthProgramWeek('2026-11-02', h), 8);
  assert.equal(c.healthWorkoutsForDate('2026-09-28', h).find(e => e.id === 'mo-pu').sets, 1);
  assert.equal(c.healthWorkoutsForDate('2026-10-12', h).find(e => e.id === 'mo-pu').sets, 2);
  assert.equal(c.healthWorkoutsForDate('2026-11-09', h).find(e => e.id === 'mo-pu').sets, 3);
  assert.ok(c.healthWorkoutsForDate('2027-09-13', h).every(e => e.sets <= 3));
  assert.equal(c.healthWorkoutsForDate('2026-09-14', h).length, 2);
});

test('checkboxes, bulk completion and reward gating use only that date’s requirements', async () => {
  const c = harness();
  c.state.health = c.healthNormalize({});
  const day = c.healthEnsureDay('2026-09-14');
  day.foodLog.push({ calories: 100, protein: 10 });
  assert.equal(c.healthRewardUnlocked('2026-09-14'), false);
  await c.healthToggleSet('2026-09-14', 'mo-cp', 0);
  assert.equal(day.workoutsDone['mo-cp'], undefined);
  await c.healthToggleSet('2026-09-14', 'mo-pu', 0);
  assert.equal(c.healthDayAdherence('2026-09-14').wDone, 1);
  await c.healthMarkWholeWorkout('2026-09-14');
  assert.deepEqual(Object.keys(day.workoutsDone).sort(), ['mo-pu', 'mo-walk']);
  assert.equal(c.healthRewardUnlocked('2026-09-14'), true);
  const later = c.healthEnsureDay('2026-10-12');
  await c.healthToggleSet('2026-10-12', 'mo-pu', 0);
  assert.deepEqual(copy(later.workoutsDone['mo-pu']), [true, false]);
  await c.healthMarkAllSets('2026-10-12', 'mo-pu');
  assert.equal(later.workoutsDone['mo-pu'], true);
  assert.equal(c.healthDayAdherence('2026-10-12').workoutOk, false);
});

test('closing a day freezes its workout for history even if setup changes', async () => {
  const c = harness();
  c.state.health = c.healthNormalize({});
  await c.healthMarkWholeWorkout('2026-09-14');
  await c.healthConfirmCloseDay('2026-09-14');
  c.state.health.workoutPlan['1'] = [];
  c.state.health.profile.startDate = '2026-08-03';
  const a = c.healthDayAdherence('2026-09-14');
  assert.equal(a.wTotal, 2);
  assert.equal(a.wDone, 2);
  assert.equal(a.workoutOk, true);
  assert.match(c.healthHistoryHtml(), /2\/2/);
  await c.healthMarkWholeWorkout('2026-09-14');
  assert.equal(c.healthDayAdherence('2026-09-14').wDone, 2);
});

test('mobile can apply the restart first and agrees with desktop on completions', () => {
  const c = harness(), m = harness('2026-09-08', true);
  const h = copy(c.healthDefault());
  h.profile.startDate = '2026-09-07';
  h.days = { '2026-09-07': { closed: true } };
  assert.equal(m.healthApplySept14Restart(h), true);
  assert.equal(m.healthApplySept14Restart(h), false);
  assert.equal(h.profile.startDate, '2026-09-14');
  h.days['2026-09-14'] = { workoutsDone: { 'mo-pu': true, 'mo-walk': true }, foodLog: [{ calories: 100 }], habits: {} };
  c.state.health = c.healthNormalize(copy(h));
  assert.ok(c.state.health.days['2026-09-14']);
  for (const iso of ['2026-09-14', '2026-09-16', '2026-09-19', '2026-10-12', '2026-11-23']) {
    assert.deepEqual(copy(m.hPlanFor(h, iso)), copy(c.healthWorkoutsForDate(iso, c.state.health)));
    const da = c.healthDayAdherence(iso), ma = m.hDayAdherence(h, iso);
    assert.equal(ma.wTotal, da.wTotal);
    assert.equal(ma.workoutOk, da.workoutOk);
  }
  assert.equal(m.hUnlocked(h, '2026-09-14'), true);
});

test('migration must save successfully before the Health record is cached', async () => {
  const c = harness();
  const original = copy(c.healthDefault());
  let attempts = 0, saved;
  c.callApi = async body => {
    if (body.action === 'get_health') return { data: copy(original) };
    attempts++;
    if (attempts === 1) throw new Error('save failed');
    saved = copy(body.data);
    return { success: true };
  };
  await assert.rejects(c.loadHealth(), /save failed/);
  assert.equal(c.state.health, null);
  await c.loadHealth();
  assert.equal(attempts, 2);
  assert.equal(saved.profile.sept142026ResetV1, true);
  c.state.health = null;
  c.callApi = async body => { assert.equal(body.action, 'get_health'); return { data: copy(saved) }; };
  await c.loadHealth();
});

test('daily, weekly, setup and weight screens render the new start and staged plan', () => {
  const c = harness();
  c.state.health = c.healthNormalize({});
  vm.runInContext("_healthDate = '2026-09-14'; _healthWeekMon = '2026-09-14';", c);
  assert.match(c.healthDailyHtml(), /0\/2 done · 0\/2 sets/);
  assert.match(c.healthDailyHtml(), /min="2026-09-14"/);
  assert.doesNotMatch(c.healthDailyHtml(), /Weekend Reset|front-loaded day/);
  assert.match(c.healthWeeklyHtml(), /2 workout items · 2 sets/);
  assert.match(c.healthSetupHtml(), /From week 11/);
  assert.match(c.healthWeightHtml(), /healthSaveWeighIn\('2026-09-14'\)/);
});
