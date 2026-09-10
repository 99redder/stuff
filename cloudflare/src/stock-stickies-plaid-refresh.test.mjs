import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRobinhoodInvestmentsRefresh } from './stock-stickies-plaid-refresh.js';

const success = { ok: true, status: 200, payload: { request_id: 'completed' } };
const failure = (code, requestId = 'failed') => ({
  ok: false,
  status: 400,
  payload: { error_code: code, request_id: requestId },
});

test('a successful paid refresh is never repeated', async () => {
  let calls = 0;
  const result = await requestRobinhoodInvestmentsRefresh(async () => {
    calls += 1;
    return success;
  }, { wait: () => assert.fail('must not wait after success') });
  assert.equal(result, success);
  assert.equal(calls, 1);
});

for (const code of ['INSTITUTION_NOT_RESPONDING', 'INTERNAL_SERVER_ERROR']) {
  test(`${code} recovers with one delayed retry`, async () => {
    let calls = 0;
    const delays = [];
    const result = await requestRobinhoodInvestmentsRefresh(async () =>
      ++calls === 1 ? failure(code) : success,
    { wait: async ms => { delays.push(ms); } });
    assert.equal(result, success);
    assert.equal(calls, 2);
    assert.deepEqual(delays, [5_000]);
  });
}

test('persistent Robinhood failure stops after two attempts and preserves diagnostics', async () => {
  let calls = 0;
  await assert.rejects(requestRobinhoodInvestmentsRefresh(async () =>
    failure('INSTITUTION_NOT_RESPONDING', `request-${++calls}`),
  { wait: async () => {} }), error => {
    assert.equal(error.code, 'INSTITUTION_NOT_RESPONDING');
    assert.equal(error.requestId, 'request-2');
    assert.equal(error.needsConsent, false);
    assert.match(error.message, /Robinhood is not responding/);
    assert.match(error.message, /positions were not changed/);
    return true;
  });
  assert.equal(calls, 2);
});

for (const code of [
  'ITEM_LOGIN_REQUIRED', 'ADDITIONAL_CONSENT_REQUIRED', 'USER_PERMISSION_REVOKED',
  'PRODUCT_NOT_ENABLED', 'PRODUCT_NOT_SUPPORTED', 'PRODUCT_NOT_READY',
  'RATE_LIMIT_EXCEEDED', 'INSTITUTION_DOWN', 'UNEXPECTED_ERROR',
]) {
  test(`${code} does not trigger another paid request`, async () => {
    let calls = 0;
    await assert.rejects(requestRobinhoodInvestmentsRefresh(async () => {
      calls += 1;
      return failure(code);
    }, { wait: () => assert.fail('must not retry') }), error => {
      assert.equal(error.code, code);
      assert.equal(error.needsConsent,
        ['ITEM_LOGIN_REQUIRED', 'ADDITIONAL_CONSENT_REQUIRED', 'USER_PERMISSION_REVOKED'].includes(code));
      if (code === 'UNEXPECTED_ERROR') assert.match(error.message, /UNEXPECTED_ERROR/);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('an ambiguous network failure is not retried as another paid refresh', async () => {
  let calls = 0;
  const networkError = new Error('network interrupted');
  await assert.rejects(requestRobinhoodInvestmentsRefresh(async () => {
    calls += 1;
    throw networkError;
  }, { wait: () => assert.fail('must not retry') }), error => error === networkError);
  assert.equal(calls, 1);
});

test('a reconnect error on the retry directs the user to reconnect', async () => {
  let calls = 0;
  await assert.rejects(requestRobinhoodInvestmentsRefresh(async () =>
    failure(++calls === 1 ? 'INSTITUTION_NOT_RESPONDING' : 'ITEM_LOGIN_REQUIRED'),
  { wait: async () => {} }), error => {
    assert.equal(error.needsConsent, true);
    assert.equal(error.code, 'ITEM_LOGIN_REQUIRED');
    return true;
  });
  assert.equal(calls, 2);
});
