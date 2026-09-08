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
    months: { '2026-09': { discretionary: [] }, '2025-12': { discretionary: [{ id: 'past', amount: 12 }] } },
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
  const updated = structuredClone(legacy);
  updated.months['2026-09'].discretionary.push({ id: 'new', date: '2026-09-08', amount: 37.84, name: 'Amazon' });
  const saved = await api({ action: 'save_mom_budget', data: updated }, sessionToken);
  assert.deepEqual(await saved.json(), { success: true });
  // Immediately read again, before the delayed KV backup can run.
  const response = await api({ action: 'get_mom_budget_public_summary', month: '2026-09' });
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  const after = await response.json();
  assert.ok(Math.abs(before.month.overallSpendingRemaining - after.month.overallSpendingRemaining - 37.84) < 1e-9);
  assert.equal(after.month.discretionarySpent, 37.84);
  assert.equal(after.month.transactions.find(row => row.id === 'new').amount, 37.84);
  assert.equal(after.data, undefined);
  assert.equal(after.template, undefined);
  assert.equal(after.months, undefined);
  assert.deepEqual((await (await api({ action: 'get_mom_budget' }, sessionToken)).json()).data, updated);
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
