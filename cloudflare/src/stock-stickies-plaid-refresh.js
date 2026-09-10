const TRANSIENT_REFRESH_CODES = new Set([
  'INSTITUTION_NOT_RESPONDING',
  'INTERNAL_SERVER_ERROR',
]);

const REFRESH_ERRORS = {
  INSTITUTION_NOT_RESPONDING: 'Robinhood is not responding to Plaid. The automatic retry also failed. Your positions were not changed. Please try again in a few minutes.',
  INTERNAL_SERVER_ERROR: 'Plaid is temporarily unable to refresh Robinhood. The automatic retry also failed. Your positions were not changed. Please try again in a few minutes.',
  INSTITUTION_DOWN: 'Robinhood is temporarily unavailable through Plaid. Your positions were not changed. Please try again later.',
  PRODUCT_NOT_READY: 'Plaid is still preparing Robinhood investment data. Your positions were not changed. Please try again in a few minutes.',
  PRODUCT_NOT_SUPPORTED: 'Robinhood does not support Plaid’s on-demand Investments Refresh for this connection.',
  PRODUCT_NOT_ENABLED: 'Plaid Investments Refresh is not enabled for this production connection.',
  ITEM_LOGIN_REQUIRED: 'Robinhood must be reconnected before positions can be refreshed.',
  ADDITIONAL_CONSENT_REQUIRED: 'Robinhood needs permission to share investment positions. Reconnect Robinhood to continue.',
  USER_PERMISSION_REVOKED: 'Robinhood permission has been revoked. Reconnect Robinhood to continue.',
  RATE_LIMIT_EXCEEDED: 'Plaid has temporarily limited Robinhood refresh requests. Your positions were not changed. Please try again in a few minutes.',
};

const RECONNECT_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'ADDITIONAL_CONSENT_REQUIRED',
  'USER_PERMISSION_REVOKED',
]);

// Retry only an explicit temporary upstream failure, once. Never retry an
// accepted (potentially billable) refresh or substitute an older holdings cache:
// the caller uses success to authorize removal of closed positions.
export async function requestRobinhoodInvestmentsRefresh(
  sendRequest,
  { wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {},
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await sendRequest();
    if (result.ok) return result;

    const payload = result.payload || {};
    const code = String(payload.error_code || payload.error_type || 'UNKNOWN_ERROR').slice(0, 80);
    if (attempt === 0 && TRANSIENT_REFRESH_CODES.has(code)) {
      await wait(5_000);
      continue;
    }

    const error = new Error(REFRESH_ERRORS[code] ||
      `Plaid could not refresh Robinhood (${code}). Your positions were not changed. Please try again later.`);
    error.code = code;
    error.status = result.status;
    error.requestId = String(payload.request_id || '').slice(0, 120);
    error.needsConsent = RECONNECT_CODES.has(code);
    throw error;
  }
}
