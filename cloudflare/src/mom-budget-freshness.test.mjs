import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Mom Budget saves are immediately visible to the phone and survive restart', async t => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./worker.js', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers'],
  });
  const directory = await mkdtemp(join(tmpdir(), 'mom-budget-test-'));
  const options = {
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2024-01-01', compatibilityFlags: ['rpc'],
    bindings: { ADMIN_PASSWORD: 'local-test-password' },
    kvNamespaces: ['RENTALS'], kvPersist: join(directory, 'kv'),
    durableObjects: { MOM_BUDGET_STORE: { className: 'MomBudgetStore', useSQLite: true } },
    durableObjectsPersist: join(directory, 'objects'),
  };
  let mf = new Miniflare(options);
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  let kv = await mf.getKVNamespace('RENTALS');
  const legacy = {
    template: { income: [], fixed: [], variable: { discretionary: 500 } },
    months: {
      '2025-12': { discretionary: [{ id: 'past', amount: 12 }] },
      '2026-08': { fixedPaid: { 'fair-share': true }, discretionary: [{ id: 'august', amount: 100 }] },
      '2026-09': {
        fixedPaid: { 'fair-share': true },
        discretionary: [{ id: 'before-start', date: '2026-08-31', amount: 75 }],
        otherExpenses: [{ id: 'old-overage', date: '2026-08-31', amount: 25 }],
      },
      '2026-10': { discretionary: [{ id: 'october', date: '2026-10-01', amount: 45 }] },
      '2026-13': { discretionary: [{ id: 'invalid-month', amount: 999 }] },
    },
  };
  await kv.put('mom_budget', JSON.stringify(legacy));
  await kv.put('budget', JSON.stringify({}));
  const api = (body, token = '', origin = 'https://99redder.github.io') => mf.dispatchFetch('https://local.test/api/data', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Session': token },
    body: JSON.stringify(body),
  });
  const login = await api({ action: 'verify_password', password: 'local-test-password' });
  const { sessionToken } = await login.json();
  assert.ok(sessionToken);
  const first = await api({ action: 'get_mom_budget' }, sessionToken);
  assert.deepEqual((await first.json()).data, legacy, 'imports every existing record unchanged');
  const before = await (await api({ action: 'get_mom_budget_public_summary', month: '2026-09' })).json();
  assert.equal(before.trackingStartedAt, '2026-09-01');
  assert.equal(before.month.overallSpendingRemaining, 800);
  assert.equal(before.month.trackingAllowance, 800);
  assert.equal(before.month.trackingUsed, 0);
  assert.equal(before.month.trackingRemaining, 800);
  assert.deepEqual(before.month.transactions, []);
  assert.deepEqual(before.year, { year: '2026', months: 1, planned: 800, actual: 0, variance: 800, usedPercent: 0, remainingPercent: 100 },
    'September is month one even before its first tracked expense; older and future activity is excluded');
  const updated = structuredClone(legacy);
  updated.months['2026-09'].discretionary.push({ id: 'new', date: '2026-09-01', amount: 37.84, name: 'Amazon' });
  const saved = await api({ action: 'save_mom_budget', data: updated }, sessionToken);
  assert.deepEqual(await saved.json(), { success: true });
  // Immediately read again, before the delayed KV backup can run.
  const response = await api({ action: 'get_mom_budget_public_summary', month: '2026-09' });
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  const after = await response.json();
  assert.ok(Math.abs(before.month.overallSpendingRemaining - after.month.overallSpendingRemaining - 37.84) < 1e-9);
  assert.equal(after.month.discretionarySpent, 37.84);
  assert.equal(after.month.transactions.find(row => row.id === 'new').amount, 37.84);
  assert.equal(after.month.transactions.length, 1);
  assert.equal(after.year.months, 1);
  assert.equal(after.year.planned, 800);
  assert.equal(after.year.actual, 37.84);
  assert.ok(Math.abs(after.year.variance - 762.16) < 1e-9);
  assert.ok(Math.abs(after.year.usedPercent - 4.73) < 0.01);
  assert.equal(after.data, undefined);
  assert.equal(after.template, undefined);
  assert.equal(after.months, undefined);
  assert.deepEqual((await (await api({ action: 'get_mom_budget' }, sessionToken)).json()).data, updated);
  await t.test('tracking begins in September and remains bounded at year rollover', async () => {
    for (const month of ['2025-12', '2026-01', '2026-08']) {
      const response = await api({ action: 'get_mom_budget_public_summary', month });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.match(body.error, /September 1, 2026/);
      assert.equal(body.month, undefined);
      assert.equal(body.year, undefined);
    }
    const october = await (await api({ action: 'get_mom_budget_public_summary', month: '2026-10' })).json();
    assert.equal(october.year.months, 2);
    assert.equal(october.year.planned, 1600);
    assert.equal(october.year.actual, 82.84);
    const january = await (await api({ action: 'get_mom_budget_public_summary', month: '2027-01' })).json();
    assert.deepEqual(january.year, { year: '2027', months: 1, planned: 800, actual: 0, variance: 800, usedPercent: 0, remainingPercent: 100 });
    assert.deepEqual(january.month.transactions, []);
  });
  assert.equal((await api({ action: 'get_mom_budget' })).status, 401);
  assert.equal((await api({ action: 'save_mom_budget', data: legacy })).status, 401);
  assert.equal((await api({ action: 'get_mom_budget_public_summary' }, '', 'https://untrusted.example')).status, 403);
  assert.equal((await api({ action: 'save_mom_budget', data: [] }, sessionToken)).status, 400);

  // Verify the alarm keeps the legacy KV backup in sync.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (JSON.stringify(await kv.get('mom_budget', 'json')) === JSON.stringify(updated)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(await kv.get('mom_budget', 'json'), updated);
  // A stale KV copy must not override the authoritative data after eviction.
  await kv.put('mom_budget', JSON.stringify(legacy));
  await mf.dispose();
  mf = new Miniflare(options);
  assert.deepEqual((await (await api({ action: 'get_mom_budget' }, sessionToken)).json()).data, updated);
});
