import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Mom Budget public details are closed and authoritative data stays private', async t => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./worker.js', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], external: ['cloudflare:workers'],
  });
  const directory = await mkdtemp(join(tmpdir(), 'mom-budget-test-'));
  const options = {
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2024-01-01', compatibilityFlags: ['rpc'],
    bindings: { ADMIN_PASSWORD: 'local-test-password' }, kvNamespaces: ['RENTALS'], kvPersist: join(directory, 'kv'),
    durableObjects: { MOM_BUDGET_STORE: { className: 'MomBudgetStore', useSQLite: true }, MOM_PHONE_ACCESS: { className: 'MomPhoneAccess', useSQLite: true } },
    durableObjectsPersist: join(directory, 'objects'),
  };
  let mf = new Miniflare(options);
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const kv = await mf.getKVNamespace('RENTALS');
  const legacy = { template: { income: [], fixed: [], variable: { discretionary: 500 } }, months: { '2026-09': { discretionary: [{ id: 'old', date: '2026-09-01', amount: 75 }] } } };
  await kv.put('mom_budget', JSON.stringify(legacy));
  await kv.put('budget', JSON.stringify({}));
  const api = (body, token = '', origin = 'https://99redder.github.io') => mf.dispatchFetch('https://local.test/api/data', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Session': token }, body: JSON.stringify(body),
  });
  const login = await api({ action: 'verify_password', password: 'local-test-password' });
  const { sessionToken } = await login.json();
  assert.ok(sessionToken);
  const first = await api({ action: 'get_mom_budget' }, sessionToken);
  assert.deepEqual((await first.json()).data, legacy);
  const publicSummary = await api({ action: 'get_mom_budget_public_summary', month: '2026-09' });
  assert.notEqual(publicSummary.status, 200);
  assert.match((await publicSummary.json()).error, /sign-in|not found|unauthorized/i);
  assert.equal((await api({ action: 'mom_phone_invite', name: 'Unexpected device', mode: 'passkey' }, sessionToken)).status, 403);
  const staleInvite = await mf.dispatchFetch('https://rentals-api.99redder.workers.dev/mom/api/enroll/options', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://99redder.github.io' },
    body: JSON.stringify({ token: 'A'.repeat(43) }),
  });
  assert.equal(staleInvite.status, 403);
  const updated = structuredClone(legacy);
  updated.months['2026-09'].discretionary.push({ id: 'new', date: '2026-09-01', amount: 37.84, name: 'Amazon' });
  assert.deepEqual(await (await api({ action: 'save_mom_budget', data: updated }, sessionToken)).json(), { success: true });
  assert.deepEqual((await (await api({ action: 'get_mom_budget' }, sessionToken)).json()).data, updated);
  assert.equal((await api({ action: 'get_mom_budget' })).status, 401);
  assert.equal((await api({ action: 'save_mom_budget', data: legacy })).status, 401);
  assert.equal((await api({ action: 'get_mom_budget_public_summary' }, '', 'https://untrusted.example')).status, 403);
  // The separate phone route never returns data without its own session.
  const phone = await mf.dispatchFetch('https://rentals-api.99redder.workers.dev/mom/api/summary', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://99redder.github.io' }, body: '{}' });
  assert.equal(phone.status, 401);

  // Sign-in codes: the owner gets one, the phone pairs with it, and from then on
  // the device key alone signs the phone back in — no cookie, passkey, or link.
  const momApi = (action, body) => mf.dispatchFetch(`https://rentals-api.99redder.workers.dev/mom/api/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://99redder.github.io' }, body: JSON.stringify(body),
  });
  const codeResponse = await api({ action: 'mom_phone_pair_code', name: 'Test phone' }, sessionToken);
  assert.equal(codeResponse.status, 200);
  const { code } = await codeResponse.json();
  assert.match(code, /^\d{6}$/);
  const wrong = code === '000000' ? '000001' : '000000';
  assert.equal((await momApi('pair', { code: wrong })).status, 401);
  const paired = await momApi('pair', { code });
  assert.equal(paired.status, 200);
  const { deviceKey } = await paired.json();
  assert.match(deviceKey, /^[\w-]{43}$/);
  assert.match(paired.headers.get('Set-Cookie'), /__Host-mom_session=/);
  assert.equal((await momApi('pair', { code })).status, 401, 'a code works once');
  const restored = await momApi('summary', { deviceKey });
  assert.equal(restored.status, 200, 'the device key restores a lost session');
  assert.match(restored.headers.get('Set-Cookie'), /__Host-mom_session=/);
  const { access } = await (await api({ action: 'mom_phone_list' }, sessionToken)).json();
  const grant = access.find(row => row.name === 'Test phone');
  assert.equal(grant.mode, 'device');
  assert.equal((await api({ action: 'mom_phone_revoke', id: grant.id }, sessionToken)).status, 200);
  const revoked = await momApi('summary', { deviceKey });
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).deviceKeyRevoked, true);
  assert.equal((await momApi('logout', {})).status, 404, 'her app has no sign-out');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && JSON.stringify(await kv.get('mom_budget', 'json')) !== JSON.stringify(updated)) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await kv.get('mom_budget', 'json'), updated);
});
