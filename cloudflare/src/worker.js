// rentals-api — Cloudflare Worker for Rental Property Manager
// All amounts stored and returned in DOLLARS (never cents).
// KV keys: transactions:{property}, summaries:{property}, defaults:{property}, depreciation:{property}

const VALID_PROPERTIES = ['6AL', '95EB', '446BB', '731WO', '4781MC'];
const MOVE_IN_PURCHASE_PROPERTY = '4781MC';

const VALID_CATEGORIES = [
  'rent', 'deposit', 'late_fee', 'other_income',
  'taxes', 'insurance', 'repairs', 'improvements', 'utilities',
  'hoa', 'management', 'auto', 'legal', 'marketing', 'other_expense',
  'mortgage_interest', 'pmi'  // historical summaries only
];

const ALLOWED_ORIGIN = 'https://99redder.github.io';
const SESSION_COOKIE = 'rentals_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const REMEMBERED_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days on a trusted device
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BURST_RETRY_SECONDS = 60;
const MAX_API_REQUEST_BYTES = 1_000_000;
const MAX_API_JSON_DEPTH = 12;
const MAX_API_ARRAY_ITEMS = 5_000;
const MAX_API_OBJECT_KEYS = 2_000;
const MAX_API_STRING_LENGTH = 100_000;
const MAX_UPSTREAM_JSON_BYTES = 1_000_000;
const MAX_USDA_PDF_BYTES = 5_000_000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Session',
  'Access-Control-Allow-Credentials': 'true',
  'Vary': 'Origin',
};

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=()',
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (origin && origin !== ALLOWED_ORIGIN) {
      return jsonResponse({ error: 'Origin not allowed' }, 403);
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return addSecurityHeaders(new Response(null, { status: 204, headers: CORS_HEADERS }));
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/data' && request.method === 'POST') {
      return handleDataApi(request, env);
    }

    return jsonResponse({ error: 'Not Found' }, 404);
  },

  async scheduled(controller, env, ctx) {
    // Cloudflare cron expressions run in UTC. Two triggers cover 6:00 AM in
    // both EST and EDT; only the one that is actually 6 AM in New York runs.
    const easternHour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(controller.scheduledTime));
    if (easternHour !== '06') return;

    ctx.waitUntil(runScheduledRobinhoodRefresh(env, controller.scheduledTime));
  }
};

async function runScheduledRobinhoodRefresh(env, scheduledTime) {
  const response = await handleGetRobinhoodBalance(env, true, 'scheduled');
  console.log(JSON.stringify({
    event: 'scheduled_robinhood_balance_refresh',
    scheduledTime: new Date(scheduledTime).toISOString(),
    status: response.status,
    ok: response.ok,
  }));
  try {
    await refreshNetWorthPlaid(env);
  } catch (error) {
    console.error(JSON.stringify({ event: 'scheduled_net_worth_refresh_error', message: error instanceof Error ? error.message : String(error) }));
  }
  try {
    await refreshTreasuryPortfolio(env);
  } catch (error) {
    console.error(JSON.stringify({ event: 'scheduled_treasury_refresh_error', message: error instanceof Error ? error.message : String(error) }));
  }
  try {
    await refreshPreciousMetals(env);
  } catch (error) {
    console.error(JSON.stringify({ event: 'scheduled_precious_metals_refresh_error', message: error instanceof Error ? error.message : String(error) }));
  }
}

async function handleDataApi(request, env) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    return jsonResponse({ error: 'Content-Type must be application/json' }, 415);
  }

  let body;
  try {
    body = await readJsonLimited(request, MAX_API_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return jsonResponse({ error: 'Request body is too large' }, 413);
    }
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const envelopeError = validateApiEnvelope(body);
  if (envelopeError) return jsonResponse({ error: envelopeError }, 400);

  const { action } = body;

  // Password check — creates an HttpOnly session cookie on success.
  if (action === 'verify_password') {
    return handleVerifyPassword(request, env, body.password, body.rememberDevice === true);
  }
  if (action === 'logout') {
    return handleLogout(request, env);
  }
  if (action === 'verify_session') {
    const ok = await isAuthenticated(request, env);
    return jsonResponse({ ok }, ok ? 200 : 401);
  }
  if (action === 'get_mom_budget_public_summary') {
    if (request.headers.get('Origin') !== ALLOWED_ORIGIN) {
      return jsonResponse({ error: 'Origin required' }, 403);
    }
    return handleGetMomBudgetPublicSummary(request, env, body.month);
  }

  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // Non-property actions
  if (action === 'get_tax_planning') return handleGetTaxPlanning(env, body.year);
  if (action === 'save_tax_planning') return handleSaveTaxPlanning(env, body.year, body.data);
  if (action === 'fetch_fmg_tax_summary') return handleFetchFmgTaxSummary(body);
  if (action === 'fetch_esai_tax_summary') return handleFetchEsaiTaxSummary(body);
  if (action === 'get_budget') return handleGetBudget(env);
  if (action === 'save_budget') return handleSaveBudget(env, body.data);
  if (action === 'get_cash_flow') return handleGetCashFlow(env, body.year);
  if (action === 'save_cash_flow') return handleSaveCashFlow(env, body.year, body.data);
  if (action === 'refresh_usda_food_benchmark') return handleRefreshUsdaFoodBenchmark();
  if (action === 'get_mom_budget') return handleGetMomBudget(env);
  if (action === 'save_mom_budget') return handleSaveMomBudget(env, body.data);

  if (action === 'get_solar_config')     return handleGetSolarConfig(env);
  if (action === 'save_solar_config')    return handleSaveSolarConfig(env, body.config);
  if (action === 'get_solar_entries')    return handleGetSolarEntries(env);
  if (action === 'add_solar_entry')      return handleAddSolarEntry(env, body.entry);
  if (action === 'update_solar_entry')   return handleUpdateSolarEntry(env, body.id, body.entry);
  if (action === 'delete_solar_entry')   return handleDeleteSolarEntry(env, body.id);
  if (action === 'get_solar_summaries')  return handleGetSolarSummaries(env);
  if (action === 'save_solar_summary')   return handleSaveSolarSummary(env, body.year, body.data);
  if (action === 'delete_solar_summary') return handleDeleteSolarSummary(env, body.year);

  // Deductions — global
  if (action === 'get_deductions')  return handleGetDeductions(env);
  if (action === 'save_deductions') return handleSaveDeductions(env, body.data);

  // Savings — global
  if (action === 'get_savings')  return handleGetSavings(env);
  if (action === 'save_savings') return handleSaveSavings(env, body.data);
  if (action === 'get_robinhood_balance') return handleGetRobinhoodBalance(env, body.refresh === true, 'client');
  if (action === 'get_net_worth') return handleGetNetWorth(env);
  if (action === 'save_net_worth') return handleSaveNetWorth(env, body.data);
  if (action === 'refresh_net_worth_plaid') return handleRefreshNetWorthPlaid(env);
  if (action === 'get_vehicle_trims') return handleGetVehicleTrims(body);
  if (action === 'value_net_worth_vehicle') return handleValueNetWorthVehicle(env, body.vehicle);
  // Note: Fair Share settings live inside the `budget` KV record
  // (data.fairShare), saved via save_budget — no dedicated action/key.

  const { property } = body;

  if (!property || !VALID_PROPERTIES.includes(property)) {
    return jsonResponse({ error: 'Invalid or missing property' }, 400);
  }

  const readOnlyWhenSold = new Set([
    'add_transaction', 'add_transactions', 'delete_transaction',
    'save_summary', 'delete_summary',
    'save_defaults', 'save_depreciation',
    'save_maintenance', 'seed_maintenance', 'add_maintenance_entry', 'update_maintenance_entry', 'delete_maintenance_entry',
    'save_move_in_purchases', 'add_move_in_purchase', 'update_move_in_purchase', 'delete_move_in_purchase'
  ]);
  if (readOnlyWhenSold.has(action) && await isPropertySold(env, property)) {
    return jsonResponse({ error: 'Property is sold/closed. Records are historical and read-only.' }, 409);
  }

  switch (action) {
    case 'get_transactions':
      return handleGetTransactions(env, property);

    case 'add_transaction':
      return handleAddTransaction(env, property, body.transaction);

    case 'add_transactions':
      return handleAddTransactions(env, property, body.transactions);

    case 'delete_transaction':
      return handleDeleteTransaction(env, property, body.id);

    case 'get_summaries':
      return handleGetSummaries(env, property);

    case 'save_summary':
      return handleSaveSummary(env, property, body.year, body.data);

    case 'delete_summary':
      return handleDeleteSummary(env, property, body.year);

    case 'get_defaults':
      return handleGetDefaults(env, property);

    case 'save_defaults':
      return handleSaveDefaults(env, property, body.defaults);

    case 'get_depreciation':
      return handleGetDepreciation(env, property);

    case 'save_depreciation':
      return handleSaveDepreciation(env, property, body.config);

    case 'get_maintenance':
      return handleGetMaintenance(env, property);

    case 'save_maintenance':
      return handleSaveMaintenance(env, property, body.entries);

    case 'seed_maintenance':
      return handleSeedMaintenance(env, property);

    case 'add_maintenance_entry':
      return handleAddMaintenanceEntry(env, property, body.entry);

    case 'update_maintenance_entry':
      return handleUpdateMaintenanceEntry(env, property, body.id, body.entry);

    case 'delete_maintenance_entry':
      return handleDeleteMaintenanceEntry(env, property, body.id);

    case 'get_move_in_purchases':
      return handleGetMoveInPurchases(env, property);

    case 'save_move_in_purchases':
      return handleSaveMoveInPurchases(env, property, body.entries);

    case 'add_move_in_purchase':
      return handleAddMoveInPurchase(env, property, body.entry);

    case 'update_move_in_purchase':
      return handleUpdateMoveInPurchase(env, property, body.id, body.entry);

    case 'delete_move_in_purchase':
      return handleDeleteMoveInPurchase(env, property, body.id);

    case 'get_investment':
      return handleGetInvestment(env, property);

    case 'save_investment':
      return handleSaveInvestment(env, property, body.config);

    case 'close_investment':
      return handleCloseInvestment(env, property, body.closeout);

    case 'get_sale_closeout_draft':
      return handleGetSaleCloseoutDraft(env, property);

    case 'save_sale_closeout_draft':
      return handleSaveSaleCloseoutDraft(env, property, body.draft);

    case 'delete_sale_closeout_draft':
      return handleDeleteSaleCloseoutDraft(env, property);

    default:
      return jsonResponse({ error: 'Invalid action' }, 400);
  }
}

async function handleVerifyPassword(request, env, password, rememberDevice = false) {
  const stored = env.ADMIN_PASSWORD || '';
  if (!stored) return jsonResponse({ error: 'Password not configured on server' }, 500);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await authBurstAllowed(env, ip))) {
    return jsonResponse({ error: 'Too many login attempts. Try again shortly.' }, 429, {
      'Retry-After': String(LOGIN_BURST_RETRY_SECONDS),
    });
  }

  const failKey = `auth_fail:${ip}`;
  const failures = parseInt(await env.RENTALS.get(failKey) || '0', 10) || 0;
  if (failures >= LOGIN_MAX_FAILURES) {
    return jsonResponse({ error: 'Too many failed login attempts. Try again later.' }, 429, {
      'Retry-After': String(LOGIN_WINDOW_SECONDS),
    });
  }

  if (!timingSafeEqualStrings(String(password || ''), stored)) {
    await env.RENTALS.put(failKey, String(failures + 1), { expirationTtl: LOGIN_WINDOW_SECONDS });
    return jsonResponse({ ok: false });
  }

  await env.RENTALS.delete(failKey);
  const token = crypto.randomUUID() + '-' + crypto.randomUUID();
  const sessionKey = `session:${await sha256Hex(token)}`;
  const passwordVersion = await sessionPasswordVersion(token, stored);
  const sessionTtl = rememberDevice ? REMEMBERED_SESSION_TTL_SECONDS : SESSION_TTL_SECONDS;
  const userAgentHash = rememberDevice ? await sha256Hex(request.headers.get('User-Agent') || '') : '';
  await env.RENTALS.put(sessionKey, JSON.stringify({
    createdAt: new Date().toISOString(),
    ip,
    passwordVersion,
    rememberDevice,
    userAgentHash,
  }), { expirationTtl: sessionTtl });

  return jsonResponse({ ok: true, sessionToken:token, expiresIn:sessionTtl }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; Max-Age=${sessionTtl}; Path=/; HttpOnly; Secure; SameSite=None`,
  });
}

async function handleLogout(request, env) {
  const token = getSessionToken(request);
  if (token) await env.RENTALS.delete(`session:${await sha256Hex(token)}`);
  return jsonResponse({ success: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None`,
  });
}

async function handleFetchFmgTaxSummary(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const year = String(body.year || '').trim();

  if (!username || !password) return jsonResponse({ error: 'FMG username and password are required' }, 400);
  if (!/^\d{4}$/.test(year)) return jsonResponse({ error: 'Invalid year' }, 400);

  let loginRes;
  try {
    loginRes = await fetch('https://florencemaegifts.com/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
  } catch (err) {
    return jsonResponse({ error: `Failed to reach FMG: ${err.message}` }, 502);
  }

  if (!loginRes.ok) {
    const err = await readJsonLimited(loginRes, MAX_UPSTREAM_JSON_BYTES).catch(() => ({}));
    // Never relay upstream auth failures as 401 — the frontend treats a 401
    // from this API as an expired rentals session and forces a logout.
    return jsonResponse({ error: err.error || `FMG login failed (${loginRes.status})` }, loginRes.status === 429 ? 429 : 502);
  }

  const setCookie = loginRes.headers.get('Set-Cookie') || '';
  const sessionCookie = setCookie.split(';')[0];
  if (!sessionCookie) return jsonResponse({ error: 'FMG login did not return a session cookie' }, 502);

  const txUrl = `https://florencemaegifts.com/api/tax/transactions?year=${encodeURIComponent(year)}&type=all&limit=5000`;
  let txRes;
  try {
    txRes = await fetch(txUrl, { headers: { Cookie: sessionCookie } });
  } catch (err) {
    return jsonResponse({ error: `Failed to fetch FMG tax data: ${err.message}` }, 502);
  }
  let data;
  try {
    data = await readJsonLimited(txRes, MAX_UPSTREAM_JSON_BYTES);
  } catch (err) {
    data = {};
    if (txRes.ok) return jsonResponse({ error: `FMG returned an invalid or oversized response: ${err.message}` }, 502);
  }

  if (!txRes.ok) {
    return jsonResponse({ error: data.error || `FMG tax fetch failed (${txRes.status})` }, 502);
  }

  const incomeCents = Array.isArray(data.income)
    ? data.income.reduce((s, r) => s + Number(r.amount_cents || 0), 0)
    : 0;
  const expenseCents = Array.isArray(data.expenses)
    ? data.expenses.reduce((s, r) => s + Number(r.amount_cents || 0), 0)
    : 0;

  return jsonResponse({ ok: true, incomeCents, expenseCents, netCents: incomeCents - expenseCents });
}

async function handleFetchEsaiTaxSummary(body) {
  const password = String(body.password || '');
  const year = String(body.year || '').trim();

  if (!password) return jsonResponse({ error: 'ESAI admin password is required' }, 400);
  if (!/^\d{4}$/.test(year)) return jsonResponse({ error: 'Invalid year' }, 400);

  const txUrl = `https://eastern-shore-ai-contact.99redder.workers.dev/api/tax/transactions?year=${encodeURIComponent(year)}&type=all&limit=5000`;
  let txRes;
  try {
    txRes = await fetch(txUrl, { headers: { 'X-Admin-Password': password } });
  } catch (err) {
    return jsonResponse({ error: `Failed to reach ESAI: ${err.message}` }, 502);
  }

  let data;
  try {
    data = await readJsonLimited(txRes, MAX_UPSTREAM_JSON_BYTES);
  } catch (err) {
    data = {};
    if (txRes.ok) return jsonResponse({ error: `ESAI returned an invalid or oversized response: ${err.message}` }, 502);
  }
  if (!txRes.ok) {
    return jsonResponse({ error: data.error || `ESAI tax fetch failed (${txRes.status})` }, txRes.status === 429 ? 429 : 502);
  }

  const incomeCents = Array.isArray(data.income)
    ? data.income.reduce((s, r) => s + Number(r.amount_cents || 0), 0)
    : 0;
  const expenseCents = Array.isArray(data.expenses)
    ? data.expenses.reduce((s, r) => s + Number(r.amount_cents || 0), 0)
    : 0;

  return jsonResponse({ ok: true, incomeCents, expenseCents, netCents: incomeCents - expenseCents });
}

async function isAuthenticated(request, env) {
  const token = getSessionToken(request);
  if (!token || !env.ADMIN_PASSWORD) return false;

  const session = await env.RENTALS.get(`session:${await sha256Hex(token)}`, 'json');
  if (!session || typeof session.passwordVersion !== 'string') return false;
  if (session.userAgentHash) {
    const currentUserAgentHash = await sha256Hex(request.headers.get('User-Agent') || '');
    if (!timingSafeEqualStrings(session.userAgentHash,currentUserAgentHash)) return false;
  }

  const currentVersion = await sessionPasswordVersion(token, env.ADMIN_PASSWORD);
  return timingSafeEqualStrings(session.passwordVersion, currentVersion);
}

async function authBurstAllowed(env, ip) {
  if (!env.AUTH_RATELIMIT) return true;
  try {
    const result = await env.AUTH_RATELIMIT.limit({ key: `login:${ip}` });
    return result.success;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'auth_rate_limit_error', message: error.message }));
    return true;
  }
}

function getSessionToken(request) {
  return getCookie(request, SESSION_COOKIE) || request.headers.get('X-Session') || '';
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sessionPasswordVersion(token, password) {
  return sha256Hex(`${token}\0${password}`);
}

function timingSafeEqualStrings(left, right) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const lengthsMatch = leftBytes.byteLength === rightBytes.byteLength;
  return lengthsMatch
    ? crypto.subtle.timingSafeEqual(leftBytes, rightBytes)
    : !crypto.subtle.timingSafeEqual(leftBytes, leftBytes);
}

async function isPropertySold(env, property) {
  const inv = await env.RENTALS.get(`investment:${property}`, 'json') || {};
  return !!inv?.saleCloseout?.closedAt;
}

// ── Transactions ─────────────────────────────────────────────────────────────

async function handleGetTransactions(env, property) {
  const transactions = await env.RENTALS.get(`transactions:${property}`, 'json') || [];
  return jsonResponse({ transactions });
}

async function handleAddTransaction(env, property, transaction) {
  const result = buildTransaction(property, transaction);
  if (result.error) return result.error;

  const transactions = await env.RENTALS.get(`transactions:${property}`, 'json') || [];
  transactions.push(result.transaction);
  await env.RENTALS.put(`transactions:${property}`, JSON.stringify(transactions));

  return jsonResponse({ transaction: result.transaction });
}

async function handleAddTransactions(env, property, incomingTransactions) {
  if (!Array.isArray(incomingTransactions) || incomingTransactions.length === 0) {
    return jsonResponse({ error: 'Missing transactions array' }, 400);
  }

  const newTransactions = [];
  for (const transaction of incomingTransactions) {
    const result = buildTransaction(property, transaction);
    if (result.error) return result.error;
    newTransactions.push(result.transaction);
  }

  const transactions = await env.RENTALS.get(`transactions:${property}`, 'json') || [];
  transactions.push(...newTransactions);
  await env.RENTALS.put(`transactions:${property}`, JSON.stringify(transactions));

  return jsonResponse({ transactions: newTransactions });
}

function buildTransaction(property, transaction) {
  if (!transaction || typeof transaction !== 'object') {
    return { error: jsonResponse({ error: 'Missing transaction object' }, 400) };
  }

  const { type, category, date, amount, description = '' } = transaction;

  if (!['income', 'expense'].includes(type)) {
    return { error: jsonResponse({ error: 'Invalid type' }, 400) };
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return { error: jsonResponse({ error: 'Invalid category' }, 400) };
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: jsonResponse({ error: 'Invalid date format (expected YYYY-MM-DD)' }, 400) };
  }
  if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
    return { error: jsonResponse({ error: 'Amount must be a positive number' }, 400) };
  }

  const newTransaction = {
    id: crypto.randomUUID(),
    property,
    type,
    category,
    date,
    amount,  // dollars, stored as-is
    description: String(description).trim()
  };

  return { transaction: newTransaction };
}

async function handleDeleteTransaction(env, property, id) {
  if (!id) {
    return jsonResponse({ error: 'Missing transaction id' }, 400);
  }

  const transactions = await env.RENTALS.get(`transactions:${property}`, 'json') || [];
  const filtered = transactions.filter(t => t.id !== id);

  if (filtered.length === transactions.length) {
    return jsonResponse({ error: 'Transaction not found' }, 404);
  }

  await env.RENTALS.put(`transactions:${property}`, JSON.stringify(filtered));
  return jsonResponse({ success: true });
}

// ── Annual Summaries ──────────────────────────────────────────────────────────

async function handleGetSummaries(env, property) {
  const summaries = await env.RENTALS.get(`summaries:${property}`, 'json') || {};
  return jsonResponse({ summaries });
}

async function handleSaveSummary(env, property, year, data) {
  if (!year || typeof year !== 'string' || !/^\d{4}$/.test(year)) {
    return jsonResponse({ error: 'Invalid year (expected 4-digit string)' }, 400);
  }
  if (!data || typeof data !== 'object') {
    return jsonResponse({ error: 'Missing summary data object' }, 400);
  }

  // Sanitize: only keep valid category keys with numeric values
  const sanitized = {};
  for (const code of VALID_CATEGORIES) {
    const val = data[code];
    sanitized[code] = (typeof val === 'number' && isFinite(val)) ? val : 0;
  }
  // Preserve boolean flags
  if (data.primary_residence === true) sanitized.primary_residence = true;

  const summaries = await env.RENTALS.get(`summaries:${property}`, 'json') || {};
  summaries[year] = sanitized;
  await env.RENTALS.put(`summaries:${property}`, JSON.stringify(summaries));

  return jsonResponse({ success: true });
}

async function handleDeleteSummary(env, property, year) {
  if (!year) {
    return jsonResponse({ error: 'Missing year' }, 400);
  }

  const summaries = await env.RENTALS.get(`summaries:${property}`, 'json') || {};
  if (!(year in summaries)) {
    return jsonResponse({ error: 'Year not found' }, 404);
  }

  delete summaries[year];
  await env.RENTALS.put(`summaries:${property}`, JSON.stringify(summaries));
  return jsonResponse({ success: true });
}

// ── Defaults ──────────────────────────────────────────────────────────────────

async function handleGetDefaults(env, property) {
  const defaults = await env.RENTALS.get(`defaults:${property}`, 'json') || {};
  return jsonResponse({ defaults });
}

async function handleSaveDefaults(env, property, newDefaults) {
  if (!newDefaults || typeof newDefaults !== 'object') {
    return jsonResponse({ error: 'Missing defaults object' }, 400);
  }

  // Merge into existing defaults (never clobber)
  const existing = await env.RENTALS.get(`defaults:${property}`, 'json') || {};
  for (const [key, val] of Object.entries(newDefaults)) {
    if (VALID_CATEGORIES.includes(key) && typeof val === 'number' && isFinite(val) && val > 0) {
      existing[key] = val;
    }
  }

  await env.RENTALS.put(`defaults:${property}`, JSON.stringify(existing));
  return jsonResponse({ success: true });
}

// ── Depreciation ──────────────────────────────────────────────────────────────

async function handleGetDepreciation(env, property) {
  const config = await env.RENTALS.get(`depreciation:${property}`, 'json') || null;
  return jsonResponse({ config });
}

async function handleSaveDepreciation(env, property, config) {
  if (!config || typeof config !== 'object') {
    return jsonResponse({ error: 'Missing config object' }, 400);
  }

  const { costBasis, placedInService, purchaseDate } = config;

  if (typeof costBasis !== 'number' || !isFinite(costBasis) || costBasis <= 0) {
    return jsonResponse({ error: 'costBasis must be a positive number' }, 400);
  }
  if (!placedInService || !/^\d{4}-\d{2}-\d{2}$/.test(placedInService)) {
    return jsonResponse({ error: 'placedInService must be YYYY-MM-DD' }, 400);
  }

  const saved = {
    costBasis,
    placedInService,
    purchaseDate: purchaseDate || null
  };

  await env.RENTALS.put(`depreciation:${property}`, JSON.stringify(saved));
  return jsonResponse({ success: true, config: saved });
}

// ── Maintenance Log ───────────────────────────────────────────────────────────

async function handleGetMaintenance(env, property) {
  const entries = await env.RENTALS.get(`maintenance:${property}`, 'json') || [];
  return jsonResponse({ entries });
}

async function handleSaveMaintenance(env, property, entries) {
  if (!Array.isArray(entries)) {
    return jsonResponse({ error: 'entries must be an array' }, 400);
  }
  const saved = entries.map(e => ({
    ...normalizeMaintenanceEntry(e),
    id: e.id || crypto.randomUUID(),
  }));
  await env.RENTALS.put(`maintenance:${property}`, JSON.stringify(saved));
  return jsonResponse({ entries: saved });
}

async function handleSeedMaintenance(env, property) {
  const existing = await env.RENTALS.get(`maintenance:${property}`, 'json') || [];
  if (existing.length) {
    return jsonResponse({ error: 'Maintenance log already has entries' }, 409);
  }

  const seedEntries = await env.RENTALS.get(`maintenance_seed:${property}`, 'json') || [];
  if (!seedEntries.length) {
    return jsonResponse({ error: 'No historical maintenance records found for this property' }, 404);
  }

  const saved = seedEntries.map(e => ({
    ...normalizeMaintenanceEntry(e),
    id: e.id || crypto.randomUUID(),
  }));
  await env.RENTALS.put(`maintenance:${property}`, JSON.stringify(saved));
  return jsonResponse({ entries: saved });
}

function normalizeMaintenanceTaxTreatment(entry) {
  const treatment = String(entry?.taxTreatment || '').trim().toLowerCase();
  if (['repair', 'improvement', 'other'].includes(treatment)) return treatment;
  return entry?.capitalImprovement ? 'improvement' : 'repair';
}

function normalizeMaintenanceEntry(entry) {
  const taxTreatment = normalizeMaintenanceTaxTreatment(entry);
  return {
    id: entry.id || crypto.randomUUID(),
    date: entry.date || '',
    description: String(entry.description || '').trim(),
    cost: typeof entry.cost === 'number' && isFinite(entry.cost) ? entry.cost : 0,
    performedBy: String(entry.performedBy || '').trim(),
    notes: String(entry.notes || '').trim(),
    taxTreatment,
    capitalImprovement: taxTreatment === 'improvement',
  };
}

async function handleAddMaintenanceEntry(env, property, entry) {
  if (!entry || typeof entry !== 'object') {
    return jsonResponse({ error: 'Missing entry object' }, 400);
  }
  const newEntry = normalizeMaintenanceEntry({
    ...entry,
    id: crypto.randomUUID(),
  });
  const entries = await env.RENTALS.get(`maintenance:${property}`, 'json') || [];
  entries.push(newEntry);
  await env.RENTALS.put(`maintenance:${property}`, JSON.stringify(entries));
  return jsonResponse({ entry: newEntry });
}

async function handleUpdateMaintenanceEntry(env, property, id, entry) {
  if (!id) return jsonResponse({ error: 'Missing id' }, 400);
  if (!entry || typeof entry !== 'object') return jsonResponse({ error: 'Missing entry' }, 400);
  const entries = await env.RENTALS.get(`maintenance:${property}`, 'json') || [];
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return jsonResponse({ error: 'Entry not found' }, 404);
  entries[idx] = normalizeMaintenanceEntry({
    ...entries[idx],
    ...entry,
    id,
  });
  await env.RENTALS.put(`maintenance:${property}`, JSON.stringify(entries));
  return jsonResponse({ entry: entries[idx] });
}

async function handleDeleteMaintenanceEntry(env, property, id) {
  if (!id) return jsonResponse({ error: 'Missing id' }, 400);
  const entries = await env.RENTALS.get(`maintenance:${property}`, 'json') || [];
  const filtered = entries.filter(e => e.id !== id);
  if (filtered.length === entries.length) return jsonResponse({ error: 'Entry not found' }, 404);
  await env.RENTALS.put(`maintenance:${property}`, JSON.stringify(filtered));
  return jsonResponse({ success: true });
}

// ── Move-In Purchases ─────────────────────────────────────────────────────────

function requireMoveInPurchaseProperty(property) {
  return property === MOVE_IN_PURCHASE_PROPERTY
    ? null
    : jsonResponse({ error: 'Move-in purchases are only available for 4781MC' }, 400);
}

function normalizeMoveInPurchase(entry) {
  return {
    id: entry.id || crypto.randomUUID(),
    date: typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : '',
    item: String(entry.item || '').trim(),
    estimatedPrice: typeof entry.estimatedPrice === 'number' && isFinite(entry.estimatedPrice) && entry.estimatedPrice >= 0
      ? entry.estimatedPrice
      : 0,
    productLink: normalizeMoveInPurchaseLink(entry.productLink),
    notes: String(entry.notes || '').trim(),
    purchased: !!entry.purchased,
  };
}

function normalizeMoveInPurchaseLink(value) {
  const link = String(value || '').trim();
  return /^https?:\/\//i.test(link) ? link : '';
}

async function handleGetMoveInPurchases(env, property) {
  const propertyError = requireMoveInPurchaseProperty(property);
  if (propertyError) return propertyError;
  const entries = await env.RENTALS.get(`move_in_purchases:${property}`, 'json') || [];
  return jsonResponse({ entries });
}

async function handleSaveMoveInPurchases(env, property, entries) {
  const propertyError = requireMoveInPurchaseProperty(property);
  if (propertyError) return propertyError;
  if (!Array.isArray(entries)) {
    return jsonResponse({ error: 'entries must be an array' }, 400);
  }
  const saved = entries.map(e => normalizeMoveInPurchase({ ...e, id: e.id || crypto.randomUUID() }));
  await env.RENTALS.put(`move_in_purchases:${property}`, JSON.stringify(saved));
  return jsonResponse({ entries: saved });
}

async function handleAddMoveInPurchase(env, property, entry) {
  const propertyError = requireMoveInPurchaseProperty(property);
  if (propertyError) return propertyError;
  if (!entry || typeof entry !== 'object') {
    return jsonResponse({ error: 'Missing entry object' }, 400);
  }
  const newEntry = normalizeMoveInPurchase({ ...entry, id: crypto.randomUUID() });
  if (!newEntry.item) return jsonResponse({ error: 'Item is required' }, 400);
  const entries = await env.RENTALS.get(`move_in_purchases:${property}`, 'json') || [];
  entries.push(newEntry);
  await env.RENTALS.put(`move_in_purchases:${property}`, JSON.stringify(entries));
  return jsonResponse({ entry: newEntry });
}

async function handleUpdateMoveInPurchase(env, property, id, entry) {
  const propertyError = requireMoveInPurchaseProperty(property);
  if (propertyError) return propertyError;
  if (!id) return jsonResponse({ error: 'Missing id' }, 400);
  if (!entry || typeof entry !== 'object') return jsonResponse({ error: 'Missing entry' }, 400);
  const entries = await env.RENTALS.get(`move_in_purchases:${property}`, 'json') || [];
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return jsonResponse({ error: 'Entry not found' }, 404);
  entries[idx] = normalizeMoveInPurchase({
    ...entries[idx],
    ...entry,
    id,
  });
  if (!entries[idx].item) return jsonResponse({ error: 'Item is required' }, 400);
  await env.RENTALS.put(`move_in_purchases:${property}`, JSON.stringify(entries));
  return jsonResponse({ entry: entries[idx] });
}

async function handleDeleteMoveInPurchase(env, property, id) {
  const propertyError = requireMoveInPurchaseProperty(property);
  if (propertyError) return propertyError;
  if (!id) return jsonResponse({ error: 'Missing id' }, 400);
  const entries = await env.RENTALS.get(`move_in_purchases:${property}`, 'json') || [];
  const filtered = entries.filter(e => e.id !== id);
  if (filtered.length === entries.length) return jsonResponse({ error: 'Entry not found' }, 404);
  await env.RENTALS.put(`move_in_purchases:${property}`, JSON.stringify(filtered));
  return jsonResponse({ success: true });
}

// ── Tax Planning ─────────────────────────────────────────────────────────────

async function handleGetTaxPlanning(env, year) {
  if (!year || !/^\d{4}$/.test(String(year))) {
    return jsonResponse({ error: 'Invalid year' }, 400);
  }
  const data = await env.RENTALS.get(`tax_planning:${year}`, 'json') || {};
  return jsonResponse({ data });
}

async function handleSaveTaxPlanning(env, year, data) {
  if (!year || !/^\d{4}$/.test(String(year))) {
    return jsonResponse({ error: 'Invalid year' }, 400);
  }
  if (!data || typeof data !== 'object') {
    return jsonResponse({ error: 'Missing data object' }, 400);
  }
  await env.RENTALS.put(`tax_planning:${year}`, JSON.stringify(data));
  return jsonResponse({ success: true });
}

// ── Monthly Budget ────────────────────────────────────────────────────────────

async function handleGetBudget(env) {
  const data = await env.RENTALS.get('budget', 'json') || {};
  return jsonResponse({ data });
}

async function handleSaveBudget(env, data) {
  if (!data || typeof data !== 'object') {
    return jsonResponse({ error: 'Missing data object' }, 400);
  }
  await env.RENTALS.put('budget', JSON.stringify(data));
  return jsonResponse({ success: true });
}

// ── Cash Flow ────────────────────────────────────────────────────────────────

async function handleGetCashFlow(env, year) {
  if (!year || !/^\d{4}$/.test(String(year))) {
    return jsonResponse({ error: 'Invalid year' }, 400);
  }
  const data = await env.RENTALS.get(`cash_flow:${year}`, 'json') || {};
  return jsonResponse({ data });
}

async function handleSaveCashFlow(env, year, data) {
  if (!year || !/^\d{4}$/.test(String(year))) {
    return jsonResponse({ error: 'Invalid year' }, 400);
  }
  if (!data || typeof data !== 'object') {
    return jsonResponse({ error: 'Missing data object' }, 400);
  }

  const sanitizeItems = items => Array.isArray(items) ? items.map(item => ({
    id: item.id || crypto.randomUUID(),
    date: String(item.date || '').trim().slice(0, 10),
    name: String(item.name || '').trim().slice(0, 160),
    amount: (typeof item.amount === 'number' && isFinite(item.amount) && item.amount >= 0) ? item.amount : 0,
    note: String(item.note || '').trim().slice(0, 300),
  })).filter(item => item.name || item.amount > 0) : [];

  const saved = {
    year: Number(year),
    robinhoodChecking: (typeof data.robinhoodChecking === 'number' && isFinite(data.robinhoodChecking) && data.robinhoodChecking >= 0)
      ? data.robinhoodChecking
      : 0,
    income: sanitizeItems(data.income),
    expenses: sanitizeItems(data.expenses),
  };
  await env.RENTALS.put(`cash_flow:${year}`, JSON.stringify(saved));
  return jsonResponse({ success: true, data: saved });
}

// ── USDA Cost of Food report fetch + parse ────────────────────────────────────
// Fetches the latest monthly "Official USDA Food Plans: Cost of Food at Home"
// PDF and extracts the female 71+ Liberal Plan monthly figure for the Fair
// Share food benchmark. USDA only hosts the most recent month at this URL
// pattern, so we probe backwards from the current month.

const USDA_PDF_URL_BASE = 'https://fns-prod.azureedge.us/sites/default/files/resource-files/cnpp-costfood-3levels-';
const USDA_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

async function handleRefreshUsdaFoodBenchmark() {
  const now = new Date();
  for (let back = 0; back < 15; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const url = `${USDA_PDF_URL_BASE}${USDA_MONTHS[d.getUTCMonth()]}${d.getUTCFullYear()}.pdf`;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/pdf' } });
      if (!res.ok) continue;
      const bytes = await readBytesLimited(res, MAX_USDA_PDF_BYTES);
      if (bytes[0] !== 0x25 || bytes[1] !== 0x50) continue;  // not %PDF (404 page)
      const parsed = await parseUsdaCostOfFoodPdf(bytes);
      if (parsed) return jsonResponse({ ...parsed, url });
    } catch (_) { /* try the previous month */ }
  }
  return jsonResponse({ error: 'Could not locate or parse a recent USDA Cost of Food report' }, 502);
}

async function inflateBytes(bytes) {
  // PDF stream data usually carries a trailing EOL before `endstream`, which
  // DecompressionStream rejects as trailing junk — trim whitespace first, and
  // keep whatever inflated cleanly if an error still fires at the tail.
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d || bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09)) end--;
  const reader = new Blob([bytes.slice(0, end)]).stream()
    .pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (_) { /* partial output is fine for text extraction */ }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Text extraction for the USDA PDF: inflate the FlateDecode streams, build a
// glyph→unicode map from the embedded ToUnicode CMaps, decode the Tj/TJ text
// operators, then read the first (female) "71+ years" row — six currency
// figures whose last is the Liberal Plan monthly cost.
async function parseUsdaCostOfFoodPdf(bytes) {
  const latin = new TextDecoder('latin1').decode(bytes);  // single-byte: indexes match bytes
  const parts = [];
  let idx = 0;
  while (true) {
    const s = latin.indexOf('stream', idx);
    if (s === -1) break;
    if (latin.slice(s - 3, s) === 'end') { idx = s + 6; continue; }
    let start = s + 6;
    if (latin[start] === '\r') start++;
    if (latin[start] === '\n') start++;
    const e = latin.indexOf('endstream', start);
    if (e === -1) break;
    try { parts.push(new TextDecoder('latin1').decode(await inflateBytes(bytes.slice(start, e)))); }
    catch (_) { parts.push(''); }
    idx = e + 9;
  }

  const glyphMap = {};
  for (const p of parts) {
    for (const m of p.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of m[1].matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4,8})>/g)) {
        glyphMap[parseInt(pair[1], 16)] = String.fromCharCode(parseInt(pair[2].slice(0, 4), 16));
      }
    }
    for (const m of p.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const t of m[1].matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4})>/g)) {
        const lo = parseInt(t[1], 16), hi = parseInt(t[2], 16), dst = parseInt(t[3], 16);
        for (let g = lo; g <= hi; g++) glyphMap[g] = String.fromCharCode(dst + (g - lo));
      }
    }
  }

  const decHex = hex => {
    let s = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) s += glyphMap[parseInt(hex.slice(i, i + 4), 16)] ?? '';
    return s;
  };
  const isTextStream = p => {
    if ((p.match(/\bT[jJf]\b|BDC|Tm/g) || []).length < 5) return false;
    const sample = p.slice(0, 2000);
    return ((sample.match(/[\x20-\x7e\r\n]/g) || []).length / sample.length) > 0.9;
  };
  const decodeContent = p => {
    let out = '';
    for (const m of p.matchAll(/<([0-9A-Fa-f]+)>\s*Tj|\(((?:[^()\\]|\\.)*)\)\s*Tj|\[((?:[^\]\\]|\\.)*)\]\s*TJ|(Td|TD|Tm|T\*)/g)) {
      if (m[1]) out += decHex(m[1]);
      else if (m[2] !== undefined) out += m[2].replace(/\\([()\\])/g, '$1');
      else if (m[3] !== undefined) {
        for (const el of m[3].matchAll(/<([0-9A-Fa-f]+)>|\(((?:[^()\\]|\\.)*)\)/g)) {
          out += el[1] ? decHex(el[1]) : el[2].replace(/\\([()\\])/g, '$1');
        }
      } else out += ' ';
    }
    return out;
  };

  const text = parts.filter(isTextStream).map(decodeContent).join(' ').replace(/\s+/g, ' ');
  const title = text.match(/U\.S\.\s*Average,?\s*([A-Z][a-z]+\s+\d{4})/);
  const row = text.match(/71\+\s*years\s*((?:\$[\d,]+\.\d{2}\s*){6})/);  // first hit = Female section
  if (!title || !row) return null;
  const nums = row[1].match(/[\d,]+\.\d{2}/g).map(n => parseFloat(n.replace(/,/g, '')));
  if (nums.length !== 6 || !(nums[5] > 100) || !(nums[5] < 2000)) return null;
  return { reportLabel: title[1].replace(/\s+/g, ' '), liberalMonthly: nums[5] };
}

// ── Mom Budget ───────────────────────────────────────────────────────────────

// ── Fair Share (mirror of the frontend's fsCalc, for the public phone summary) ──
// Which budget expense categories count as shared (split across the household)
// by default. Must match FS_SHARED_CAT_DEFAULTS in index.html.
const FS_SHARED_CAT_DEFAULTS = {
  'Weekly Spending': true,
  'Utilities': true,
  'Services': true,
  'Mortgage': true,
  'Insurance': true,
  'Travel': false,
  'Cars': false,
  'Retirement Savings': false,
  'School Savings': false,
  'Investments': false,
  'Misc Savings': false,
};

function fairShareDefaultParticipants(item, category, householdSize) {
  const name = String(item?.name || '').trim().toLowerCase();
  const isPhone = /\b(phone|phones|cell|cellular|mobile|wireless)\b/.test(name);
  const isCarsCategory = category === 'Cars';
  const isCarInsurance = /\binsurance\b/.test(name)
    && (isCarsCategory || /\b(car|auto|automobile|vehicle)\b/.test(name));
  return (isPhone || isCarsCategory || isCarInsurance)
    ? Math.min(3, householdSize)
    : householdSize;
}

function fairShareItemParticipants(item, category, fairShare, householdSize) {
  const saved = Number(fairShare.participants?.[item.id]);
  if (Number.isFinite(saved) && saved >= 1) {
    return Math.min(householdSize, Math.round(saved));
  }
  return fairShareDefaultParticipants(item, category, householdSize);
}

// Mirror of the frontend fsMortgageCalc/fsMortgageItem — the estimated loan
// principal (owner equity, not a shared cost) is subtracted from the mortgage
// item before the split. Returns { itemId, principal } or null.
function fairShareMortgageExclusion(fs, expenses) {
  const m = fs.mortgage;
  if (!m || !m.enabled) return null;
  const L = Number(m.loanAmount), ratePct = Number(m.ratePct), years = Number(m.termYears);
  if (!(L > 0) || !(ratePct > 0) || !(years > 0)) return null;
  const r = ratePct / 100 / 12;
  const n = Math.round(years * 12);
  const pmt = L * r / (1 - Math.pow(1 + r, -n));
  let k = 1;
  if (typeof m.firstPayment === 'string' && /^\d{4}-\d{2}$/.test(m.firstPayment)) {
    const [fy, fm] = m.firstPayment.split('-').map(Number);
    const [cy, cm] = currentEasternMonthKey().split('-').map(Number);
    k = (cy - fy) * 12 + (cm - fm) + 1;
  }
  k = Math.min(n, Math.max(1, k));
  const grow = Math.pow(1 + r, k - 1);
  const balance = L * grow - pmt * (grow - 1) / r;
  const principal = pmt - balance * r;
  let itemId = typeof m.itemId === 'string' ? m.itemId : '';
  if (!itemId) {
    const items = Array.isArray(expenses['Mortgage']) ? expenses['Mortgage'] : [];
    const match = items.find(i => /mortgage/i.test(String(i.name || '')));
    itemId = match ? match.id : '';
  }
  return itemId ? { itemId, principal } : null;
}

// Mirror of the frontend fsFoodBenchmark — her portion of the mixed weekly
// spending item is the published USDA Cost of Food figure, not a per-capita
// split. Returns { itemId, amount } or null.
function fairShareFoodBenchmark(fs, expenses) {
  const fb = fs.foodBenchmark;
  if (!fb || !fb.enabled || !(Number(fb.amount) > 0)) return null;
  let itemId = typeof fb.itemId === 'string' ? fb.itemId : '';
  if (!itemId) {
    const items = Array.isArray(expenses['Weekly Spending']) ? expenses['Weekly Spending'] : [];
    itemId = items.length ? items[0].id : '';
  }
  return itemId ? { itemId, amount: Number(fb.amount) } : null;
}

// Her monthly Fair Share = the sum of her portion of each shared expense.
function calcFairShareFromBudget(budget) {
  if (!budget || typeof budget !== 'object') return 0;
  const fs = (budget.fairShare && typeof budget.fairShare === 'object') ? budget.fairShare : {};
  const householdSize = (typeof fs.householdSize === 'number' && fs.householdSize >= 1) ? Math.round(fs.householdSize) : 5;
  const roundDollar = (fs.roundDollar !== undefined) ? !!fs.roundDollar : (fs.roundUp !== false);
  const shared = (fs.shared && typeof fs.shared === 'object') ? fs.shared : {};
  const expenses = (budget.expenses && typeof budget.expenses === 'object') ? budget.expenses : {};
  const mAdj = fairShareMortgageExclusion(fs, expenses);
  const fbAdj = fairShareFoodBenchmark(fs, expenses);
  let herShare = 0;
  for (const cat of Object.keys(expenses)) {
    const items = Array.isArray(expenses[cat]) ? expenses[cat] : [];
    for (const item of items) {
      const isShared = Object.prototype.hasOwnProperty.call(shared, item.id)
        ? !!shared[item.id]
        : !!FS_SHARED_CAT_DEFAULTS[cat];
      if (isShared) {
        const participants = fairShareItemParticipants(item, cat, fs, householdSize);
        const amt = Number(item.amount) || 0;
        const effAmt = (mAdj && item.id === mAdj.itemId) ? Math.max(0, amt - mAdj.principal) : amt;
        herShare += (fbAdj && item.id === fbAdj.itemId)
          ? fbAdj.amount
          : effAmt / participants;
      }
    }
  }
  return roundDollar ? Math.round(herShare) : herShare;
}

const MOM_BUDGET_DEFAULT = {
  template: {
    income: [
      { id: 'ss', name: 'Social Security', amount: 2092.50 },
      { id: '401k', name: '401k Distribution', amount: 1000 }
    ],
    fixed: [
      // Household bills wrapped into one auto-synced Fair Share line (she lives with family).
      { id: 'fair-share', name: 'Fair Share (household)', amount: 0, frequency: 'monthly', auto: true, locked: true },
      { id: 'medical', name: 'CoPays / Prescriptions', amount: 140 }
    ],
    variable: { discretionary: 500 },
    variableLocks: {}
  },
  months: {}
};

const MB_VARIABLE_FIXED_BILL_IDS = new Set(['electric', 'water', 'gas-heat']);

async function handleGetMomBudget(env) {
  const data = await env.RENTALS.get('mom_budget', 'json') || {};
  return jsonResponse({ data });
}

async function handleSaveMomBudget(env, data) {
  if (!data || typeof data !== 'object') {
    return jsonResponse({ error: 'Missing data object' }, 400);
  }
  await env.RENTALS.put('mom_budget', JSON.stringify(data));
  return jsonResponse({ success: true });
}

// Public, unauthenticated endpoint for mom-budget-phone.html. Two cheap guards keep
// it from being hammered by bots without adding any friction for the phone:
//   1. Per-IP rate limit (native binding) — caps bursts from a single source.
//   2. ~45s edge cache — a flood is served from Cloudflare's cache instead of
//      re-reading KV and recomputing on every hit. Well within the data's existing
//      eventual-consistency window, and the phone re-fetches on every foreground.
const PUBLIC_SUMMARY_CACHE_SECONDS = 45;

async function handleGetMomBudgetPublicSummary(request, env, requestedMonth) {
  // 1. Per-IP rate limit. Fail-open: if the binding is missing or errors, never take
  //    the endpoint down — the phone must keep working no matter what.
  if (env.PUBLIC_RATELIMIT) {
    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.PUBLIC_RATELIMIT.limit({ key: `pub:${ip}` });
      if (!success) {
        return jsonResponse({ error: 'Too many requests. Please try again in a minute.' }, 429);
      }
    } catch (_) { /* limiter unavailable — fall through and serve normally */ }
  }

  const monthKey = validMonthKey(requestedMonth) ? requestedMonth : currentEasternMonthKey();

  // 2. Edge cache, keyed by month. The real request is a POST (not cacheable), so use
  //    a synthetic GET URL as the cache key.
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = '/__mom_public_summary';
  cacheUrl.search = `?m=${monthKey}`;
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const year = monthKey.slice(0, 4);
  // Compute the Fair Share transfer live from the family budget, the same source
  // the main app uses, rather than relying on a possibly-stale copy in mom_budget.
  const budgetRaw = await env.RENTALS.get('budget', 'json') || {};
  const fairShare = calcFairShareFromBudget(budgetRaw);
  const raw = await env.RENTALS.get('mom_budget', 'json') || {};
  const data = normalizeMomBudget(raw);
  syncMomHouseholdTransfers(data, fairShare);
  const month = calcMomBudgetMonth(data, monthKey);
  const transactions = momBudgetMonthTransactions(data, monthKey);
  const yearSummary = calcMomBudgetYear(data, year);

  const response = new Response(JSON.stringify({
    monthKey,
    monthLabel: monthLabel(monthKey),
    updatedAt: new Date().toISOString(),
    month: {
      overallSpendingRemaining: month.overallSpendingRemaining,
      discretionaryRemaining: month.discretionaryRemaining,
      otherOverages: month.otherOverages,
      discretionarySpent: month.discretionarySpent,
      discretionaryAdjusted: month.discretionaryAdjusted,
      fairShare,
      transactions
    },
    year: yearSummary
  }), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json',
      // Shared-cache (edge) only; the phone fetches with cache:'no-store' so it never
      // serves this from the browser cache. s-maxage drives the 45s edge TTL.
      'Cache-Control': `public, s-maxage=${PUBLIC_SUMMARY_CACHE_SECONDS}, max-age=0, must-revalidate`,
    },
  });

  await cache.put(cacheKey, response.clone());
  return response;
}

function cloneJson(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function validMonthKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value);
}

function currentEasternMonthKey(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}`;
}

function monthLabel(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric'
  });
}

function blankMomBudgetMonth() {
  return { fixedPaid: {}, fixedActual: {}, groceries: [], gas: [], discretionary: [], otherExpenses: [] };
}

function momFixedFrequencyMonths(item) {
  if (item.frequency === 'yearly') return 12;
  if (item.frequency === 'semiannual') return 6;
  return 1;
}

function momFixedPaymentAmount(item) {
  const payment = Number(item.paymentAmount);
  if (Number.isFinite(payment) && payment > 0) return payment;
  return (Number(item.amount) || 0) * momFixedFrequencyMonths(item);
}

function momFixedDueMonths(item) {
  if (item.frequency === 'reserve') return [];
  if (item.frequency === 'monthly') return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const start = Math.min(12, Math.max(1, Number(item.dueMonth) || 1));
  if (item.frequency === 'semiannual') return [start, ((start + 5) % 12) + 1].sort((a, b) => a - b);
  return [start];
}

function momFixedExpectedPayment(item, monthKey) {
  return momFixedDueMonths(item).includes(Number(monthKey.slice(5, 7))) ? momFixedPaymentAmount(item) : 0;
}

function momFixedBillKind(item) {
  return MB_VARIABLE_FIXED_BILL_IDS.has(String(item.id || '').toLowerCase()) ? 'variable' : 'fixed';
}

function normalizeMomBudget(raw) {
  const data = raw && typeof raw === 'object' && Object.keys(raw).length ? cloneJson(raw) : cloneJson(MOM_BUDGET_DEFAULT);
  const defaults = cloneJson(MOM_BUDGET_DEFAULT);
  data.template = data.template || defaults.template;
  data.template.income = Array.isArray(data.template.income) ? data.template.income : defaults.template.income;
  data.template.fixed = Array.isArray(data.template.fixed) ? data.template.fixed : defaults.template.fixed;
  if (!data.template.fixed.some(item => item.id === 'fair-share')) {
    data.template.fixed.unshift(cloneJson(defaults.template.fixed.find(item => item.id === 'fair-share')));
  }
  // The separate monthly family gift was removed (Medicaid 5-year lookback
  // exposure) — drop the old auto-synced line from saved records.
  data.template.fixed = data.template.fixed.filter(item => item.id !== 'family-gift');

  const gasFixedItem = data.template.fixed.find(item => item.id === 'gas' || String(item.name || '').trim().toLowerCase() === 'gas');
  data.template.fixed.forEach(item => {
    const defaultItem = defaults.template.fixed.find(d => d.id === item.id);
    item.frequency = ['reserve', 'monthly', 'semiannual', 'yearly'].includes(item.frequency) ? item.frequency : (defaultItem?.frequency || 'monthly');
    if ((item.id === 'car-repairs' || item.id === 'registration') && !item.scheduleMigrated) {
      item.frequency = 'reserve';
    }
    item.dueMonth = Math.min(12, Math.max(1, Number(item.dueMonth ?? defaultItem?.dueMonth ?? 1) || 1));
    item.paymentAmount = Number(item.paymentAmount ?? defaultItem?.paymentAmount ?? ((Number(item.amount) || 0) * momFixedFrequencyMonths(item))) || 0;
    if (item.frequency === 'reserve') item.paymentAmount = 0;
  });
  data.template.fixed = data.template.fixed.filter(item => item !== gasFixedItem);
  data.template.variable = data.template.variable || defaults.template.variable;
  delete data.template.variable.groceries;  // groceries folded into the Fair Share line — no separate budget
  delete data.template.variable.gas;        // she has no car — gas budget/ledger removed entirely
  data.template.variable.discretionary = Number(data.template.variable.discretionary ?? defaults.template.variable.discretionary) || 0;

  data.months = data.months && typeof data.months === 'object' ? data.months : {};
  Object.entries(data.months).forEach(([monthKey, month]) => {
    month.fixedPaid = month.fixedPaid || {};
    month.fixedActual = month.fixedActual || {};
    if (gasFixedItem) {
      delete month.fixedPaid[gasFixedItem.id];
      if (month.fixedActual) delete month.fixedActual[gasFixedItem.id];
    }
    delete month.fixedPaid['family-gift'];
    delete month.fixedActual['family-gift'];
    month.discretionary = Array.isArray(month.discretionary) ? month.discretionary : [];
    month.otherExpenses = Array.isArray(month.otherExpenses) ? month.otherExpenses : [];
  });
  return data;
}

function syncMomHouseholdTransfers(data, fairShare) {
  const item = data.template.fixed.find(entry => entry.id === 'fair-share');
  if (!item) return;
  item.amount = fairShare;
  item.paymentAmount = fairShare;
  item.frequency = 'monthly';
  item.auto = true;
  item.locked = true;
}

function momBudgetTemplateTotals(data) {
  const t = data.template;
  const income = t.income.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const fixed = t.fixed.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const discretionary = Number(t.variable.discretionary) || 0;
  return { income, fixed, discretionary, planned: fixed + discretionary };
}

function calcMomBudgetMonth(data, monthKey) {
  const t = data.template;
  const m = data.months[monthKey] || blankMomBudgetMonth();
  const base = momBudgetTemplateTotals(data);
  const fixedPaid = t.fixed.reduce((s, item) => {
    if (!m.fixedPaid?.[item.id]) return s;
    const expected = momFixedExpectedPayment(item, monthKey);
    const fallback = expected || (Number(item.amount) || 0);
    if (momFixedBillKind(item) === 'fixed') return s + fallback;
    const actual = Number(m.fixedActual?.[item.id]);
    return s + (Number.isFinite(actual) && actual > 0 ? actual : fallback);
  }, 0);
  const fixedOver = t.fixed.reduce((s, item) => {
    if (!m.fixedPaid?.[item.id]) return s;
    if (momFixedBillKind(item) === 'fixed') return s;
    const expected = momFixedExpectedPayment(item, monthKey);
    const fallback = expected || (Number(item.amount) || 0);
    const actual = Number(m.fixedActual?.[item.id]);
    const paid = Number.isFinite(actual) && actual > 0 ? actual : fallback;
    return s + Math.max(0, paid - fallback);
  }, 0);
  const discretionarySpent = (m.discretionary || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const otherSpent = (m.otherExpenses || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const otherOverages = otherSpent + fixedOver;
  const discretionaryAdjusted = Math.max(0, base.discretionary - otherOverages);
  const budgetSpent = base.fixed + fixedOver + discretionarySpent + otherSpent;
  return {
    ...base,
    fixedPaid,
    fixedOver,
    discretionarySpent,
    otherOverages,
    discretionaryAdjusted,
    discretionaryRemaining: discretionaryAdjusted - discretionarySpent,
    overallSpendingRemaining: base.discretionary
      - discretionarySpent - otherOverages,
    budgetSpent,
    variance: base.planned - budgetSpent
  };
}

function momBudgetMonthTransactions(data, monthKey) {
  const t = data.template;
  const m = data.months[monthKey] || blankMomBudgetMonth();
  const defaultDate = `${monthKey}-01`;
  const entries = [];

  for (const item of t.fixed || []) {
    if (!m.fixedPaid?.[item.id]) continue;
    const expected = momFixedExpectedPayment(item, monthKey);
    const fallback = expected || (Number(item.amount) || 0);
    const actual = Number(m.fixedActual?.[item.id]);
    const amount = momFixedBillKind(item) === 'variable' && Number.isFinite(actual) && actual > 0
      ? actual
      : fallback;
    if (amount > 0) {
      entries.push({
        id: `fixed-${item.id}`,
        date: defaultDate,
        name: item.name || 'Fixed bill',
        amount,
        group: 'Fixed bills'
      });
    }
  }

  for (const entry of m.discretionary || []) {
    const amount = Number(entry.amount) || 0;
    if (amount <= 0) continue;
    entries.push({
      id: entry.id || `discretionary-${entry.date || defaultDate}-${entry.name || entry.description || amount}`,
      date: validDateString(entry.date) ? entry.date : defaultDate,
      name: entry.name || entry.description || 'Discretionary',
      amount,
      group: 'Discretionary'
    });
  }

  for (const entry of m.otherExpenses || []) {
    const amount = Number(entry.amount) || 0;
    if (amount <= 0) continue;
    entries.push({
      id: entry.id || `other-${entry.date || defaultDate}-${entry.name || entry.description || amount}`,
      date: validDateString(entry.date) ? entry.date : defaultDate,
      name: entry.name || entry.description || 'Other expense',
      amount,
      group: 'Other expenses'
    });
  }

  return entries.sort((a, b) => {
    const dateCompare = String(b.date || '').localeCompare(String(a.date || ''));
    if (dateCompare) return dateCompare;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function validDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function momMonthHasActivity(month) {
  return Object.values(month.fixedPaid || {}).some(Boolean)
    || Object.values(month.fixedActual || {}).some(v => Number(v) > 0)
    || (month.discretionary || []).length > 0
    || (month.otherExpenses || []).length > 0;
}

function calcMomBudgetYear(data, year) {
  const months = Object.keys(data.months)
    .filter(k => k.startsWith(`${year}-`) && momMonthHasActivity(data.months[k] || blankMomBudgetMonth()))
    .sort();
  return months.reduce((s, key) => {
    const c = calcMomBudgetMonth(data, key);
    s.months += 1;
    s.planned += c.planned;
    s.actual += c.budgetSpent;
    s.variance += c.variance;
    return s;
  }, { year, months: 0, planned: 0, actual: 0, variance: 0 });
}

// ── Investment Return ─────────────────────────────────────────────────────────

async function handleGetInvestment(env, property) {
  const config = await env.RENTALS.get(`investment:${property}`, 'json') || null;
  return jsonResponse({ config });
}

async function handleGetSaleCloseoutDraft(env, property) {
  const draft = await env.RENTALS.get(`sale_closeout_draft:${property}`, 'json') || {};
  return jsonResponse({ draft });
}

async function handleSaveSaleCloseoutDraft(env, property, raw) {
  const draft = raw && typeof raw === 'object' ? {
    date: typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : '',
    price: Number.isFinite(Number(raw.price)) && Number(raw.price) >= 0 ? Number(raw.price) : 0,
    notes: String(raw.notes || '').trim().slice(0, 1000),
    breakdown: raw.breakdown && typeof raw.breakdown === 'object' ? raw.breakdown : null,
    updatedAt: new Date().toISOString(),
  } : {};
  await env.RENTALS.put(`sale_closeout_draft:${property}`, JSON.stringify(draft));
  return jsonResponse({ success: true, draft });
}

async function handleDeleteSaleCloseoutDraft(env, property) {
  await env.RENTALS.delete(`sale_closeout_draft:${property}`);
  return jsonResponse({ success: true });
}

async function handleSaveInvestment(env, property, config) {
  if (!config || typeof config !== 'object') {
    return jsonResponse({ error: 'Missing config object' }, 400);
  }

  const { purchasePrice, purchaseClosingCosts, saleClosingCostPct, stateCapGainsPct } = config;

  if (typeof purchasePrice !== 'number' || !isFinite(purchasePrice) || purchasePrice < 0) {
    return jsonResponse({ error: 'purchasePrice must be a non-negative number' }, 400);
  }
  if (typeof purchaseClosingCosts !== 'number' || !isFinite(purchaseClosingCosts) || purchaseClosingCosts < 0) {
    return jsonResponse({ error: 'purchaseClosingCosts must be a non-negative number' }, 400);
  }
  if (typeof saleClosingCostPct !== 'number' || !isFinite(saleClosingCostPct) || saleClosingCostPct < 0 || saleClosingCostPct > 20) {
    return jsonResponse({ error: 'saleClosingCostPct must be a number between 0 and 20' }, 400);
  }
  if (typeof stateCapGainsPct !== 'number' || !isFinite(stateCapGainsPct) || stateCapGainsPct < 0 || stateCapGainsPct > 20) {
    return jsonResponse({ error: 'stateCapGainsPct must be a number between 0 and 20' }, 400);
  }

  // Merge into existing sale configuration.
  const existing = await env.RENTALS.get(`investment:${property}`, 'json') || {};
  const saved = {
    ...existing,
    purchasePrice,
    purchaseClosingCosts,
    saleClosingCostPct,
    stateCapGainsPct,
    purchaseDate: (typeof config.purchaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(config.purchaseDate))
      ? config.purchaseDate : (existing.purchaseDate || null),
  };

  await env.RENTALS.put(`investment:${property}`, JSON.stringify(saved));
  return jsonResponse({ success: true, config: saved });
}

async function handleCloseInvestment(env, property, closeout) {
  if (!closeout || typeof closeout !== 'object') {
    return jsonResponse({ error: 'Missing closeout object' }, 400);
  }

  const saleDate = typeof closeout.saleDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(closeout.saleDate)
    ? closeout.saleDate : null;
  if (!saleDate) return jsonResponse({ error: 'saleDate must be YYYY-MM-DD' }, 400);

  const requiredNumbers = [
    'salePrice', 'saleClosingCosts', 'grossAfterClosing', 'totalCapitalInvested',
    'capitalGain', 'federalCapGainsTax', 'stateCapGainsTax', 'depreciationRecaptureTax',
    'netSaleProceeds', 'propertyAppreciation', 'cumNetCashFlow', 'totalReturn', 'roiPct'
  ];
  for (const key of requiredNumbers) {
    if (typeof closeout[key] !== 'number' || !isFinite(closeout[key])) {
      return jsonResponse({ error: `${key} must be a finite number` }, 400);
    }
  }
  if (closeout.salePrice <= 0) return jsonResponse({ error: 'salePrice must be positive' }, 400);
  if (closeout.saleClosingCosts < 0) return jsonResponse({ error: 'saleClosingCosts cannot be negative' }, 400);

  const closingBreakdown = sanitizeSaleClosingBreakdown(closeout.saleClosingBreakdown);
  if (closingBreakdown && Math.abs(closingBreakdown.total - closeout.saleClosingCosts) > 0.01) {
    return jsonResponse({ error: 'saleClosingBreakdown total must equal saleClosingCosts' }, 400);
  }

  const existing = await env.RENTALS.get(`investment:${property}`, 'json') || {};
  const saved = {
    ...existing,
    saleCloseout: {
      saleDate,
      salePrice: closeout.salePrice,
      saleState: typeof closeout.saleState === 'string' ? closeout.saleState.slice(0, 16) : '',
      saleClosingCosts: closeout.saleClosingCosts,
      saleClosingBreakdown: closingBreakdown,
      grossAfterClosing: closeout.grossAfterClosing,
      totalCapitalInvested: closeout.totalCapitalInvested,
      cumulativeImprovements: typeof closeout.cumulativeImprovements === 'number' && isFinite(closeout.cumulativeImprovements) ? closeout.cumulativeImprovements : 0,
      cumulativeDepreciation: typeof closeout.cumulativeDepreciation === 'number' && isFinite(closeout.cumulativeDepreciation) ? closeout.cumulativeDepreciation : 0,
      capitalGain: closeout.capitalGain,
      federalCapGainsTax: closeout.federalCapGainsTax,
      stateCapGainsTax: closeout.stateCapGainsTax,
      stateCapGainsPct: typeof closeout.stateCapGainsPct === 'number' && isFinite(closeout.stateCapGainsPct) ? closeout.stateCapGainsPct : 0,
      depreciationRecaptureTax: closeout.depreciationRecaptureTax,
      mortgagePayoff: typeof closeout.mortgagePayoff === 'number' && isFinite(closeout.mortgagePayoff) ? closeout.mortgagePayoff : 0,
      netSaleProceeds: closeout.netSaleProceeds,
      primaryResidenceExclusion: typeof closeout.primaryResidenceExclusion === 'number' && isFinite(closeout.primaryResidenceExclusion) ? closeout.primaryResidenceExclusion : 0,
      taxableCapitalGain: typeof closeout.taxableCapitalGain === 'number' && isFinite(closeout.taxableCapitalGain) ? closeout.taxableCapitalGain : closeout.capitalGain,
      propertyAppreciation: closeout.propertyAppreciation,
      cumNetCashFlow: closeout.cumNetCashFlow,
      totalReturn: closeout.totalReturn,
      roiPct: closeout.roiPct,
      annualizedROI: typeof closeout.annualizedROI === 'number' && isFinite(closeout.annualizedROI) ? closeout.annualizedROI : null,
      yearsHeld: typeof closeout.yearsHeld === 'number' && isFinite(closeout.yearsHeld) ? closeout.yearsHeld : null,
      notes: String(closeout.notes || '').trim(),
      closedAt: new Date().toISOString(),
    }
  };

  await env.RENTALS.put(`investment:${property}`, JSON.stringify(saved));
  return jsonResponse({ success: true, config: saved });
}

function sanitizeSaleClosingBreakdown(raw) {
  if (!raw || typeof raw !== 'object' || !raw.items || typeof raw.items !== 'object') return null;
  const items = {};
  let total = 0;
  for (const [code, item] of Object.entries(raw.items)) {
    if (!item || typeof item !== 'object') continue;
    const value = Number(item.value);
    if (!isFinite(value) || value < 0) continue;
    items[String(code).slice(0, 64)] = {
      label: String(item.label || code).slice(0, 120),
      value,
      locked: item.locked !== false,
    };
    total += value;
  }
  return {
    saleState: typeof raw.saleState === 'string' ? raw.saleState.slice(0, 16) : '',
    items,
    total: Math.round(total * 100) / 100,
  };
}

// ── Solar ─────────────────────────────────────────────────────────────────────

const VALID_SOLAR_CODES = ['ELECPAID', 'ELECNOSOLAR', 'TRUEUP', 'SREC', 'CREDITS', 'MAINT', 'SYSTEM'];

async function handleGetSolarConfig(env) {
  const config = await env.RENTALS.get('solar:config', 'json') || null;
  return jsonResponse({ config });
}

async function handleSaveSolarConfig(env, config) {
  if (!config || typeof config !== 'object') {
    return jsonResponse({ error: 'Missing config object' }, 400);
  }
  const existing = await env.RENTALS.get('solar:config', 'json') || {};
  const saved = { ...existing, ...config };
  await env.RENTALS.put('solar:config', JSON.stringify(saved));
  return jsonResponse({ success: true, config: saved });
}

async function handleGetSolarEntries(env) {
  const entries = await env.RENTALS.get('solar:entries', 'json') || [];
  return jsonResponse({ entries });
}

async function handleAddSolarEntry(env, entry) {
  if (!entry || typeof entry !== 'object') {
    return jsonResponse({ error: 'Missing entry object' }, 400);
  }
  const { date, description, code, amount } = entry;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ error: 'Invalid date format' }, 400);
  }
  if (!VALID_SOLAR_CODES.includes(code)) {
    return jsonResponse({ error: `Invalid code — must be one of: ${VALID_SOLAR_CODES.join(', ')}` }, 400);
  }
  if (typeof amount !== 'number' || !isFinite(amount) || amount < 0) {
    return jsonResponse({ error: 'Amount must be a non-negative number' }, 400);
  }
  const entries = await env.RENTALS.get('solar:entries', 'json') || [];
  const newEntry = {
    id: crypto.randomUUID(),
    date,
    description: typeof description === 'string' ? description.trim() : '',
    code,
    amount,
  };
  entries.push(newEntry);
  entries.sort((a, b) => a.date.localeCompare(b.date));
  await env.RENTALS.put('solar:entries', JSON.stringify(entries));
  return jsonResponse({ entry: newEntry });
}

async function handleUpdateSolarEntry(env, id, entry) {
  if (!id || !entry || typeof entry !== 'object') {
    return jsonResponse({ error: 'Missing id or entry' }, 400);
  }
  const entries = await env.RENTALS.get('solar:entries', 'json') || [];
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return jsonResponse({ error: 'Entry not found' }, 404);
  const { date, description, code, amount } = entry;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ error: 'Invalid date format' }, 400);
  }
  if (code && !VALID_SOLAR_CODES.includes(code)) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }
  if (typeof amount !== 'number' || !isFinite(amount) || amount < 0) {
    return jsonResponse({ error: 'Amount must be a non-negative number' }, 400);
  }
  entries[idx] = {
    ...entries[idx],
    date: date || entries[idx].date,
    description: typeof description === 'string' ? description.trim() : entries[idx].description,
    code: code || entries[idx].code,
    amount,
  };
  entries.sort((a, b) => a.date.localeCompare(b.date));
  await env.RENTALS.put('solar:entries', JSON.stringify(entries));
  return jsonResponse({ entry: entries.find(e => e.id === id) });
}

async function handleDeleteSolarEntry(env, id) {
  if (!id) return jsonResponse({ error: 'Missing id' }, 400);
  const entries = await env.RENTALS.get('solar:entries', 'json') || [];
  const filtered = entries.filter(e => e.id !== id);
  if (filtered.length === entries.length) {
    return jsonResponse({ error: 'Entry not found' }, 404);
  }
  await env.RENTALS.put('solar:entries', JSON.stringify(filtered));
  return jsonResponse({ success: true });
}

async function handleGetSolarSummaries(env) {
  const summaries = await env.RENTALS.get('solar:summaries', 'json') || {};
  return jsonResponse({ summaries });
}

async function handleSaveSolarSummary(env, year, data) {
  if (!year || !/^\d{4}$/.test(String(year))) {
    return jsonResponse({ error: 'Invalid year' }, 400);
  }
  if (!data || typeof data !== 'object') {
    return jsonResponse({ error: 'Missing data object' }, 400);
  }
  const summaries = await env.RENTALS.get('solar:summaries', 'json') || {};
  summaries[String(year)] = data;
  await env.RENTALS.put('solar:summaries', JSON.stringify(summaries));
  return jsonResponse({ success: true });
}

async function handleDeleteSolarSummary(env, year) {
  if (!year || !/^\d{4}$/.test(String(year))) {
    return jsonResponse({ error: 'Invalid year' }, 400);
  }
  const summaries = await env.RENTALS.get('solar:summaries', 'json') || {};
  delete summaries[String(year)];
  await env.RENTALS.put('solar:summaries', JSON.stringify(summaries));
  return jsonResponse({ success: true });
}

// ── Deductions ────────────────────────────────────────────────────────────────

async function handleGetDeductions(env) {
  const deductions = await env.RENTALS.get('deductions', 'json') || [];
  return jsonResponse({ deductions });
}

async function handleSaveDeductions(env, data) {
  if (!data || !Array.isArray(data)) {
    return jsonResponse({ error: 'data must be an array' }, 400);
  }
  const sanitized = data.map(d => ({
    id: d.id || crypto.randomUUID(),
    date: String(d.date || '').trim(),
    description: String(d.description || '').trim(),
    category: String(d.category || 'Other').trim(),
    amount: (typeof d.amount === 'number' && isFinite(d.amount)) ? d.amount : 0,
    locked: !!d.locked
  }));
  await env.RENTALS.put('deductions', JSON.stringify(sanitized));
  return jsonResponse({ success: true });
}

// ── Savings ───────────────────────────────────────────────────────────────────

async function handleGetSavings(env) {
  const data = await env.RENTALS.get('savings', 'json') || {};
  return jsonResponse({ data });
}

// ── Net Worth ────────────────────────────────────────────────────────────────

const NET_WORTH_KEY = 'net_worth';
const TREASURY_BONDS = [
  { cusip:'912810UA4', coupon:4.625, par:39600, annualInterest:1831.50, maturity:'2054-05-15', term:'30-Year' },
  { cusip:'912810UG1', coupon:4.625, par:14000, annualInterest:647.50, maturity:'2055-02-15', term:'30-Year' },
  { cusip:'912810UK2', coupon:4.750, par:10000, annualInterest:475.00, maturity:'2055-05-15', term:'30-Year' },
  { cusip:'912810TX6', coupon:4.250, par:11000, annualInterest:467.50, maturity:'2054-02-15', term:'30-Year' },
  { cusip:'912810TW8', coupon:4.750, par:9600, annualInterest:456.00, maturity:'2043-11-15', term:'20-Year' },
  { cusip:'912810UB2', coupon:4.625, par:7000, annualInterest:323.75, maturity:'2044-05-15', term:'20-Year' },
  { cusip:'912810TV0', coupon:4.750, par:6800, annualInterest:323.00, maturity:'2053-11-15', term:'30-Year' },
  { cusip:'912810TZ1', coupon:4.500, par:6000, annualInterest:270.00, maturity:'2044-02-15', term:'20-Year' },
  { cusip:'912810UL0', coupon:5.000, par:5000, annualInterest:250.00, maturity:'2045-05-15', term:'20-Year' },
  { cusip:'912810UE6', coupon:4.500, par:5000, annualInterest:225.00, maturity:'2054-11-15', term:'30-Year' },
  { cusip:'912810UJ5', coupon:4.750, par:1000, annualInterest:47.50, maturity:'2045-02-15', term:'20-Year' },
];

function defaultTreasuryPortfolio(saved = {}) {
  const holdings = TREASURY_BONDS.map(bond => {
    const prior = Array.isArray(saved.holdings) ? saved.holdings.find(item => item.cusip === bond.cusip) : null;
    return { ...bond, marketValue:Number.isFinite(Number(prior?.marketValue)) ? Number(prior.marketValue) : bond.par, price:Number.isFinite(Number(prior?.price)) ? Number(prior.price) : 100 };
  });
  return {
    name:'U.S. Treasury Bonds (20 & 30 Year)',
    par:115000,
    annualInterest:5316.75,
    value:holdings.reduce((sum,bond)=>sum+bond.marketValue,0),
    yieldDate:String(saved.yieldDate || ''),
    valuedAt:String(saved.valuedAt || ''),
    source:'U.S. Treasury daily par yield curve estimate',
    holdings,
  };
}

function normalizeNetWorth(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const manualItems = Array.isArray(data.manualItems) ? data.manualItems.slice(0, 500).map(item => ({
    id: String(item.id || crypto.randomUUID()),
    side: item.side === 'liability' ? 'liability' : 'asset',
    category: String(item.category || 'Other').trim().slice(0, 80),
    name: String(item.name || '').trim().slice(0, 160),
    value: Number.isFinite(Number(item.value)) && Number(item.value) >= 0 ? Number(item.value) : 0,
    notes: String(item.notes || '').trim().slice(0, 500),
    metal: item.metal === 'silver' ? 'silver' : (item.metal === 'gold' ? 'gold' : ''),
    weight: Number.isFinite(Number(item.weight)) && Number(item.weight) >= 0 ? Math.min(Number(item.weight),1_000_000) : 0,
    pricePerOunce: Number.isFinite(Number(item.pricePerOunce)) && Number(item.pricePerOunce) >= 0 ? Number(item.pricePerOunce) : 0,
    valuedAt: typeof item.valuedAt === 'string' ? item.valuedAt : '',
    valuationSource: String(item.valuationSource || '').slice(0,120),
  })).filter(item => item.name) : [];
  const vehicles = Array.isArray(data.vehicles) ? data.vehicles.slice(0, 20).map(vehicle => ({
    id: String(vehicle.id || crypto.randomUUID()),
    name: String(vehicle.name || 'Vehicle').trim().slice(0, 160),
    make: String(vehicle.make || '').trim().slice(0, 80),
    model: String(vehicle.model || '').trim().slice(0, 80),
    trim: String(vehicle.trim || '').trim().slice(0, 80),
    year: Math.max(1900, Math.min(new Date().getUTCFullYear() + 1, Math.round(Number(vehicle.year) || 0))),
    mileage: Math.max(0, Math.min(1_000_000, Math.round(Number(vehicle.mileage) || 0))),
    value: Number.isFinite(Number(vehicle.value)) && Number(vehicle.value) >= 0 ? Number(vehicle.value) : 0,
    valuedAt: typeof vehicle.valuedAt === 'string' ? vehicle.valuedAt : '',
    valuationSource: String(vehicle.valuationSource || '').slice(0, 80),
  })).filter(vehicle => vehicle.make && vehicle.model && vehicle.year >= 1900) : [];
  const plaidAccounts = Array.isArray(data.plaidAccounts) ? data.plaidAccounts.slice(0, 200) : [];
  const propertyAssets = Array.isArray(data.propertyAssets) ? data.propertyAssets.slice(0, 20).map(item => ({
    id: String(item.id || '').slice(0, 80),
    name: String(item.name || '').trim().slice(0, 160),
    value: Number.isFinite(Number(item.value)) ? Number(item.value) : 0,
    salePrice: Number.isFinite(Number(item.salePrice)) ? Number(item.salePrice) : 0,
    saleClosingCosts: Number.isFinite(Number(item.saleClosingCosts)) ? Number(item.saleClosingCosts) : 0,
    mortgagePayoff: Number.isFinite(Number(item.mortgagePayoff)) ? Number(item.mortgagePayoff) : 0,
    federalTax: Number.isFinite(Number(item.federalTax)) ? Number(item.federalTax) : 0,
    stateTax: Number.isFinite(Number(item.stateTax)) ? Number(item.stateTax) : 0,
    depreciationRecaptureTax: Number.isFinite(Number(item.depreciationRecaptureTax)) ? Number(item.depreciationRecaptureTax) : 0,
    source: String(item.source || '').slice(0, 100),
  })).filter(item => item.id && item.name) : [];
  const history = Array.isArray(data.history) ? data.history.slice(-730) : [];
  return { manualItems, vehicles, propertyAssets, plaidAccounts, treasuryPortfolio:defaultTreasuryPortfolio(data.treasuryPortfolio), plaidRefreshedAt: data.plaidRefreshedAt || '', history };
}

function netWorthTotals(data) {
  let assets = 0;
  let liabilities = 0;
  const mortgageIncludedInProperty = data.propertyAssets.some(property => property.mortgagePayoff > 0);
  for (const item of data.manualItems) (item.side === 'liability' ? liabilities += item.value : assets += item.value);
  for (const vehicle of data.vehicles) assets += vehicle.value;
  for (const property of data.propertyAssets) assets += property.value;
  assets += Number(data.treasuryPortfolio?.value) || 0;
  for (const account of data.plaidAccounts) {
    const value = Math.max(0, Number(account.value) || 0);
    if (account.side === 'liability') {
      if (!(mortgageIncludedInProperty && account.subtype === 'mortgage')) liabilities += value;
    } else assets += value;
  }
  return { assets, liabilities, netWorth: assets - liabilities };
}

function addNetWorthSnapshot(data) {
  const date = new Date().toISOString().slice(0, 10);
  const totals = netWorthTotals(data);
  const snapshot = { date, ...totals };
  const existing = data.history.findIndex(item => item.date === date);
  if (existing >= 0) data.history[existing] = snapshot;
  else data.history.push(snapshot);
  data.history = data.history.slice(-730);
}

function applyKnownPlaidAccountLabels(data, env) {
  data.plaidAccounts = data.plaidAccounts.map(account => {
    if (account.subtype === 'mortgage') {
      return { ...account, institution:'Navy Federal', name:'Navy Federal Mortgage (731WO)' };
    }
    if (env.PLAID_ACCOUNT_ID && account.id === env.PLAID_ACCOUNT_ID) {
      return { ...account, institution:'Robinhood', name:'Robinhood Joint Checking' };
    }
    return account;
  });
  return data;
}

async function handleGetNetWorth(env) {
  return jsonResponse({ data: applyKnownPlaidAccountLabels(normalizeNetWorth(await env.RENTALS.get(NET_WORTH_KEY, 'json')),env) });
}

async function handleSaveNetWorth(env, incoming) {
  const current = normalizeNetWorth(await env.RENTALS.get(NET_WORTH_KEY, 'json'));
  const submitted = normalizeNetWorth(incoming);
  current.manualItems = submitted.manualItems;
  current.vehicles = submitted.vehicles;
  current.propertyAssets = submitted.propertyAssets;
  try { await valuePreciousMetalItems(current); } catch { /* preserve the last value if the free feed is unavailable */ }
  addNetWorthSnapshot(current);
  await env.RENTALS.put(NET_WORTH_KEY, JSON.stringify(current));
  return jsonResponse({ success: true, data: current });
}

async function getPreciousMetalPrices(metals) {
  const symbols = { gold:'XAU', silver:'XAG' };
  const entries = await Promise.all([...metals].map(async metal => {
    const response = await fetch(`https://api.gold-api.com/price/${symbols[metal]}`, { headers:{ Accept:'application/json' }, cf:{ cacheTtl:300 } });
    const payload = await readJsonLimited(response,100_000);
    const price = Number(payload.price);
    if (!response.ok || !Number.isFinite(price) || price <= 0) throw new Error(`${metal} spot price was unavailable`);
    return [metal,{ price, updatedAt:String(payload.updatedAt || new Date().toISOString()) }];
  }));
  return Object.fromEntries(entries);
}

async function valuePreciousMetalItems(data) {
  const items = data.manualItems.filter(item=>item.side==='asset' && item.category==='Precious Metals' && item.metal && item.weight>0);
  if (!items.length) return false;
  const prices = await getPreciousMetalPrices(new Set(items.map(item=>item.metal)));
  items.forEach(item=>{
    const quote=prices[item.metal];
    item.pricePerOunce=Math.round(quote.price*100)/100;
    item.value=Math.round(item.weight*quote.price*100)/100;
    item.valuedAt=quote.updatedAt;
    item.valuationSource='Gold-API spot price';
  });
  return true;
}

async function refreshPreciousMetals(env) {
  const data=normalizeNetWorth(await env.RENTALS.get(NET_WORTH_KEY,'json'));
  if (!(await valuePreciousMetalItems(data))) return data;
  addNetWorthSnapshot(data);
  await env.RENTALS.put(NET_WORTH_KEY,JSON.stringify(data));
  return data;
}

function treasuryYieldForYears(years, yields) {
  if (years <= 20) return yields.y20;
  if (years >= 30) return yields.y30;
  return yields.y20 + (yields.y30 - yields.y20) * ((years - 20) / 10);
}

function estimateTreasuryBondValue(bond, asOf, yields) {
  const maturity = new Date(`${bond.maturity}T00:00:00Z`);
  const years = Math.max(0, (maturity.getTime() - asOf.getTime()) / (365.25 * 86400000));
  if (!years) return { marketValue:bond.par, price:100 };
  const periods = Math.max(1, Math.round(years * 2));
  const marketYield = treasuryYieldForYears(years, yields) / 100 / 2;
  const couponPayment = bond.par * (bond.coupon / 100) / 2;
  const discount = Math.pow(1 + marketYield, periods);
  const marketValue = couponPayment * (1 - (1 / discount)) / marketYield + bond.par / discount;
  return { marketValue:Math.round(marketValue * 100) / 100, price:Math.round((marketValue / bond.par * 100) * 1000) / 1000 };
}

async function refreshTreasuryPortfolio(env) {
  const year = new Date().getUTCFullYear();
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
  const response = await fetch(url, { headers:{ Accept:'text/csv' }, cf:{ cacheTtl:3600 } });
  if (!response.ok) throw new Error(`Treasury yield request failed (${response.status})`);
  const csv = await readTextLimited(response, 500_000);
  const lines = csv.trim().split(/\r?\n/);
  const headers = lines[0]?.split(',').map(value => value.replaceAll('"','').trim()) || [];
  const values = lines[1]?.split(',').map(value => value.replaceAll('"','').trim()) || [];
  const yieldDate = values[headers.indexOf('Date')] || '';
  const y20 = Number(values[headers.indexOf('20 Yr')]);
  const y30 = Number(values[headers.indexOf('30 Yr')]);
  if (!yieldDate || !Number.isFinite(y20) || !Number.isFinite(y30) || y20 <= 0 || y30 <= 0) throw new Error('Treasury yield data was unavailable');
  const asOf = new Date(`${yieldDate.replace(/(\d{2})\/(\d{2})\/(\d{4})/,'$3-$1-$2')}T00:00:00Z`);
  const holdings = TREASURY_BONDS.map(bond => ({ ...bond, ...estimateTreasuryBondValue(bond,asOf,{y20,y30}) }));
  const data = normalizeNetWorth(await env.RENTALS.get(NET_WORTH_KEY, 'json'));
  data.treasuryPortfolio = {
    name:'U.S. Treasury Bonds (20 & 30 Year)', par:115000, annualInterest:5316.75,
    value:Math.round(holdings.reduce((sum,bond)=>sum+bond.marketValue,0)*100)/100,
    yieldDate, valuedAt:new Date().toISOString(), source:'U.S. Treasury daily par yield curve estimate', holdings,
  };
  addNetWorthSnapshot(data);
  await env.RENTALS.put(NET_WORTH_KEY, JSON.stringify(data));
  return data;
}

function plaidAccessTokens(env) {
  const multiItemTokens = [];
  if (env.PLAID_ACCESS_TOKENS) {
    try {
      let parsed = JSON.parse(env.PLAID_ACCESS_TOKENS);
      // Accept either a JSON array or a JSON-encoded array string so Wrangler
      // secret-bulk input formats cannot silently disable multi-Item refresh.
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      if (Array.isArray(parsed)) multiItemTokens.push(...parsed.filter(token => typeof token === 'string'));
    } catch { /* ignore malformed optional multi-item secret */ }
  }
  // Once the authoritative multi-Item secret exists, do not also query the
  // legacy single token: it may have been rotated and would fail the whole pull.
  if (multiItemTokens.length) return [...new Set(multiItemTokens)];
  return env.PLAID_ACCESS_TOKEN ? [env.PLAID_ACCESS_TOKEN] : [];
}

function plaidItemOwners(env) {
  if (!env.PLAID_ITEM_OWNERS) return {};
  try {
    const parsed=JSON.parse(env.PLAID_ITEM_OWNERS);
    return parsed && typeof parsed==='object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function plaidItemLabels(env) {
  if (!env.PLAID_ITEM_LABELS) return {};
  try {
    const parsed=JSON.parse(env.PLAID_ITEM_LABELS);
    return parsed && typeof parsed==='object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

async function refreshNetWorthPlaid(env) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) throw new Error('Plaid credentials are not configured');
  const tokens = plaidAccessTokens(env);
  if (!tokens.length) throw new Error('No Plaid access token is configured');
  const responses = await Promise.all(tokens.map(async accessToken => {
    const response = await fetch('https://production.plaid.com/accounts/get', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
        'PLAID-SECRET': env.PLAID_SECRET,
        'Plaid-Version': '2020-09-14',
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    const payload = await readJsonLimited(response, MAX_UPSTREAM_JSON_BYTES);
    if (!response.ok) {
      const code = String(payload.error_code || payload.error_type || 'UNKNOWN_ERROR').slice(0, 80);
      console.error(JSON.stringify({ event: 'plaid_net_worth_item_error', status: response.status, code }));
      throw new Error(`Plaid accounts request failed: ${code} (${response.status})`);
    }
    return {
      itemId: String(payload.item?.item_id || ''),
      institutionId: String(payload.item?.institution_id || ''),
      accounts: Array.isArray(payload.accounts) ? payload.accounts : [],
    };
  }));
  const liabilityTypes = new Set(['credit', 'loan']);
  // Confirmed production Item IDs from Plaid CLI. Metadata lookup remains as
  // a fallback for any future institution linked to the app.
  const institutionNames = { ins_54:'Robinhood', ins_15:'Navy Federal', ins_56:'Chase' };
  const institutionIds = [...new Set(responses.map(item => item.institutionId).filter(id => id && !institutionNames[id]))];
  await Promise.all(institutionIds.map(async institutionId => {
    try {
      const response = await fetch('https://production.plaid.com/institutions/get_by_id', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
          'PLAID-SECRET': env.PLAID_SECRET,
          'Plaid-Version': '2020-09-14',
        },
        body: JSON.stringify({ institution_id: institutionId, country_codes: ['US'] }),
      });
      const payload = await readJsonLimited(response, MAX_UPSTREAM_JSON_BYTES);
      const providerName = response.ok ? String(payload.institution?.name || '').trim() : '';
      if (/navy federal/i.test(providerName)) institutionNames[institutionId] = 'Navy Federal';
      else if (/robinhood/i.test(providerName)) institutionNames[institutionId] = 'Robinhood';
      else if (providerName) institutionNames[institutionId] = providerName.slice(0, 80);
    } catch { /* retain the generic Plaid fallback if metadata is unavailable */ }
  }));
  const itemOwners=plaidItemOwners(env);
  const itemLabels=plaidItemLabels(env);
  const accounts = responses.flatMap(({ itemId, institutionId, accounts: itemAccounts }) => {
    return itemAccounts.map(account => {
      const owner=String(itemOwners[itemId] || '').trim().slice(0,40);
      const itemLabel=String(itemLabels[itemId] || '').trim().slice(0,100);
      const institution = account.account_id === env.PLAID_ACCOUNT_ID ? 'Robinhood' : (institutionNames[institutionId] || 'Plaid');
      const accountName = String(account.name || '').trim();
      const officialName = String(account.official_name || '').trim();
      const genericName = /^(checking|savings|credit card|account)$/i.test(accountName);
      const rawName = String((genericName && officialName) ? officialName : (accountName || officialName || 'Account')).trim();
      const alreadyLabeled = rawName.toLowerCase().includes(institution.toLowerCase())
        || (institution === 'Navy Federal' && /nfcu/i.test(rawName));
      let displayName = alreadyLabeled ? rawName : `${institution} ${rawName}`;
      if (institution==='Robinhood' && account.subtype==='checking') displayName='Robinhood Joint Checking';
      if (institution==='Robinhood' && account.subtype==='brokerage' && owner) displayName=`${owner}'s Robinhood Individual Account`;
      if (institution==='Robinhood' && account.subtype==='ira' && owner) displayName=`${owner}'s Robinhood Traditional IRA`;
      if (institution==='Robinhood' && account.subtype==='crypto exchange' && owner) displayName=`${owner}'s Robinhood Crypto`;
      if (itemLabel) displayName=itemLabel;
      displayName = displayName.replace(/\btraditional\b/gi,'Traditional');
      if (institution === 'Navy Federal' && account.subtype === 'mortgage' && !/\(731WO\)/i.test(displayName)) {
        displayName += ' (731WO)';
      }
      return {
        id: String(account.account_id || ''),
        name: displayName.slice(0, 160),
        institution,
        institutionId,
        owner,
        officialName: officialName.slice(0, 200),
        mask: String(account.mask || '').slice(-4),
        type: String(account.type || ''),
        subtype: String(account.subtype || ''),
        side: liabilityTypes.has(account.type) ? 'liability' : 'asset',
        value: Math.max(0, Number(account.balances?.current) || 0),
        available: Number.isFinite(Number(account.balances?.available)) ? Number(account.balances.available) : null,
        currency: String(account.balances?.iso_currency_code || 'USD'),
      };
    });
  }).filter(account => account.id);
  const dedupedAccounts = [];
  const accountPositions = new Map();
  for (const account of accounts) {
    const key = account.mask ? `${account.institutionId}|${account.type}|${account.subtype}|${account.mask}` : `id|${account.id}`;
    const existingPosition = accountPositions.get(key);
    if (existingPosition === undefined) {
      accountPositions.set(key,dedupedAccounts.length);
      dedupedAccounts.push(account);
    } else if (account.id === env.PLAID_ACCOUNT_ID) {
      dedupedAccounts[existingPosition]=account;
    }
  }
  const data = normalizeNetWorth(await env.RENTALS.get(NET_WORTH_KEY, 'json'));
  data.plaidAccounts = dedupedAccounts;
  data.plaidRefreshedAt = new Date().toISOString();
  addNetWorthSnapshot(data);
  await env.RENTALS.put(NET_WORTH_KEY, JSON.stringify(data));
  return data;
}

async function handleRefreshNetWorthPlaid(env) {
  try {
    await refreshNetWorthPlaid(env);
    let data;
    try { data = await refreshTreasuryPortfolio(env); }
    catch { data = normalizeNetWorth(await env.RENTALS.get(NET_WORTH_KEY, 'json')); }
    return jsonResponse({ data });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Plaid refresh failed' }, 502);
  }
}

async function handleValueNetWorthVehicle(env, vehicle) {
  if (!env.CARAPI_TOKEN) return jsonResponse({ error: 'Automatic vehicle valuation is not configured yet' }, 503);
  const make = String(vehicle?.make || '').trim().slice(0, 80);
  const model = String(vehicle?.model || '').trim().slice(0, 80);
  const trim = String(vehicle?.trim || '').trim().slice(0, 80);
  const year = Math.round(Number(vehicle?.year) || 0);
  const mileageMiles = Math.max(0, Math.round(Number(vehicle?.mileage) || 0));
  if (!make || !model || year < 1900 || year > new Date().getUTCFullYear() + 1) {
    return jsonResponse({ error: 'Make, model, and model year are required' }, 400);
  }
  const requestValuation = async modelQuery => {
    const url = new URL('https://api.carapi.dev/v1/vehicle-valuation');
    url.searchParams.set('make', make);
    url.searchParams.set('model', modelQuery);
    url.searchParams.set('year', String(year));
    url.searchParams.set('country', 'US');
    url.searchParams.set('token', env.CARAPI_TOKEN);
    if (mileageMiles) url.searchParams.set('mileage', String(Math.round(mileageMiles * 1.609344)));
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    return { response, payload: await readJsonLimited(response, MAX_UPSTREAM_JSON_BYTES) };
  };
  let { response, payload } = await requestValuation(trim ? `${model} ${trim}` : model);
  let trimMatched = !!trim && response.ok;
  if (trim && response.status === 404) {
    ({ response, payload } = await requestValuation(model));
    trimMatched = false;
  }
  if (!response.ok) return jsonResponse({ error: payload.error || `Vehicle valuation failed (${response.status})` }, response.status === 404 ? 404 : 502);
  const value = Number(payload.valuationPrice);
  if (!Number.isFinite(value) || value < 0) return jsonResponse({ error: 'Vehicle valuation was unavailable' }, 502);
  return jsonResponse({ value, currency: payload.currency || 'USD', valuedAt: new Date().toISOString(), source: trimMatched ? 'CarAPI.dev trim match' : 'CarAPI.dev base model' });
}

async function handleGetVehicleTrims(body) {
  const make = String(body?.make || '').trim().slice(0, 80);
  const model = String(body?.model || '').trim().slice(0, 80);
  const year = Math.round(Number(body?.year) || 0);
  if (!make || !model || year < 1900 || year > new Date().getUTCFullYear() + 1) {
    return jsonResponse({ error: 'Make, model, and model year are required' }, 400);
  }
  const url = new URL('https://carapi.app/api/trims/v2');
  url.searchParams.set('year', String(year));
  url.searchParams.set('make', make);
  url.searchParams.set('model', model);
  url.searchParams.set('limit', '1000');
  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    const payload = await readJsonLimited(response, MAX_UPSTREAM_JSON_BYTES);
    if (!response.ok) return jsonResponse({ error: `Vehicle trim lookup failed (${response.status})` }, 502);
    const trims = [...new Set((Array.isArray(payload.data) ? payload.data : [])
      .map(row => String(row?.trim || row?.submodel || '').trim())
      .filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return jsonResponse({ trims });
  } catch {
    return jsonResponse({ error: 'Vehicle trim lookup is temporarily unavailable' }, 502);
  }
}

// ── Plaid / Robinhood Checking ───────────────────────────────────────────────

const ROBINHOOD_BALANCE_CACHE_KEY = 'plaid:robinhood_checking_balance';
const ROBINHOOD_ACCOUNT_SELECTION_KEY = 'plaid:robinhood_checking_selection';
const ROBINHOOD_BALANCE_CACHE_MS = 5 * 60 * 1000;
const PLAID_FORCE_REFRESH_MIN_MS = 60 * 1000;

async function plaidTokenFingerprint(accessToken) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken));
  return [...new Uint8Array(digest).slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function resolvePlaidTokenForAccount(env, accountId) {
  const tokens = plaidAccessTokens(env);
  if (!tokens.length) throw new Error('No Plaid access token is configured');

  const fingerprints = await Promise.all(tokens.map(plaidTokenFingerprint));
  const saved = await env.RENTALS.get(ROBINHOOD_ACCOUNT_SELECTION_KEY, 'json');
  const savedIndex = fingerprints.indexOf(String(saved?.tokenFingerprint || ''));
  if (savedIndex >= 0 && typeof saved?.accountId === 'string' && saved.accountId) {
    return { accessToken: tokens[savedIndex], accountId: saved.accountId };
  }

  const matches = await Promise.all(tokens.map(async (accessToken, index) => {
    try {
      const response = await fetch('https://production.plaid.com/accounts/get', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
          'PLAID-SECRET': env.PLAID_SECRET,
          'Plaid-Version': '2020-09-14',
        },
        body: JSON.stringify({ access_token: accessToken }),
      });
      const payload = await readJsonLimited(response, MAX_UPSTREAM_JSON_BYTES);
      if (!response.ok) {
        const code = String(payload.error_code || payload.error_type || 'UNKNOWN_ERROR').slice(0, 80);
        console.warn(JSON.stringify({ event: 'plaid_checking_item_lookup_error', status: response.status, code }));
        return false;
      }
      const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
      const exactAccount = accountId ? accounts.find(account => account.account_id === accountId) : null;
      const robinhoodChecking = String(payload.item?.institution_id || '') === 'ins_54'
        ? accounts.find(account => account.subtype === 'checking'
          || (account.type === 'depository' && /checking/i.test(`${account.name || ''} ${account.official_name || ''}`)))
        : null;
      const matchedAccount = exactAccount || robinhoodChecking;
      return matchedAccount
        ? { index, accountId: String(matchedAccount.account_id || ''), exact: !!exactAccount }
        : null;
    } catch (error) {
      console.warn(JSON.stringify({ event: 'plaid_checking_item_lookup_error', message: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  }));
  const matching = matches.filter(Boolean).sort((a, b) => Number(b.exact) - Number(a.exact))[0];
  if (!matching?.accountId) throw new Error('Robinhood checking was not found in the linked Plaid Items');

  await env.RENTALS.put(ROBINHOOD_ACCOUNT_SELECTION_KEY, JSON.stringify({
    tokenFingerprint: fingerprints[matching.index],
    accountId: matching.accountId,
  }));
  return { accessToken: tokens[matching.index], accountId: matching.accountId };
}

async function handleGetRobinhoodBalance(env, forceRefresh, source = 'client') {
  const cached = await env.RENTALS.get(ROBINHOOD_BALANCE_CACHE_KEY, 'json');
  const cachedAt = cached?.refreshedAt ? Date.parse(cached.refreshedAt) : 0;
  const cacheAge = cachedAt > 0 ? Date.now() - cachedAt : Infinity;
  const cacheIsFresh = cacheAge < ROBINHOOD_BALANCE_CACHE_MS;

  if (!forceRefresh && cacheIsFresh) {
    return jsonResponse({ ...cached, source: 'cache', stale: false });
  }

  if (forceRefresh && cacheAge < PLAID_FORCE_REFRESH_MIN_MS) {
    return jsonResponse({
      ...cached,
      source: 'cache',
      stale: false,
      refreshLimited: true,
      retryAfter: Math.ceil((PLAID_FORCE_REFRESH_MIN_MS - cacheAge) / 1000),
    });
  }

  if (forceRefresh && source === 'client' && !(await plaidRefreshAllowed(env))) {
    if (cached) {
      return jsonResponse({ ...cached, source: 'cache', stale: cacheAge >= ROBINHOOD_BALANCE_CACHE_MS, refreshLimited: true });
    }
    return jsonResponse({ error: 'Live balance refresh limit reached. Try again shortly.' }, 429, { 'Retry-After': '60' });
  }

  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET || !plaidAccessTokens(env).length) {
    if (cached) return jsonResponse({ ...cached, source: 'cache', stale: true, warning: 'Live balance is not configured.' });
    return jsonResponse({ error: 'Live Robinhood balance is not configured' }, 503);
  }

  try {
    const selection = await resolvePlaidTokenForAccount(env, env.PLAID_ACCOUNT_ID);
    const response = await fetch('https://production.plaid.com/accounts/balance/get', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
        'PLAID-SECRET': env.PLAID_SECRET,
        'Plaid-Version': '2020-09-14',
      },
      body: JSON.stringify({
        access_token: selection.accessToken,
        options: { account_ids: [selection.accountId] },
      }),
    });

    const data = await readJsonLimited(response, MAX_UPSTREAM_JSON_BYTES);
    if (!response.ok) throw new Error(`Plaid balance request failed (${response.status})`);

    const account = Array.isArray(data.accounts)
      ? data.accounts.find(item => item.account_id === selection.accountId)
      : null;
    if (!account) throw new Error('Configured Robinhood checking account was not returned');

    const current = Number(account.balances?.current);
    const available = Number(account.balances?.available);
    const balance = Number.isFinite(current) ? current : available;
    if (!Number.isFinite(balance)) throw new Error('Robinhood checking balance was unavailable');

    const result = {
      balance,
      current: Number.isFinite(current) ? current : null,
      available: Number.isFinite(available) ? available : null,
      refreshedAt: new Date().toISOString(),
      source: 'live',
      stale: false,
    };

    await Promise.all([
      env.RENTALS.put(ROBINHOOD_BALANCE_CACHE_KEY, JSON.stringify(result)),
      syncRobinhoodCheckingSavings(env, balance),
    ]);
    return jsonResponse(result);
  } catch (error) {
    console.error(JSON.stringify({ event: 'plaid_balance_error', message: error instanceof Error ? error.message : String(error) }));
    if (cached) {
      return jsonResponse({
        ...cached,
        source: 'cache',
        stale: true,
        warning: 'Plaid could not refresh the balance. Showing the last successful value.',
      });
    }
    return jsonResponse({ error: 'Unable to refresh Robinhood checking balance' }, 502);
  }
}

async function plaidRefreshAllowed(env) {
  if (!env.PLAID_RATELIMIT) return true;
  try {
    const { success } = await env.PLAID_RATELIMIT.limit({ key: 'robinhood-balance-refresh' });
    return success;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'plaid_rate_limit_error', message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
}

async function syncRobinhoodCheckingSavings(env, balance) {
  const savings = await env.RENTALS.get('savings', 'json');
  if (!savings || typeof savings !== 'object') return;
  const accounts = savings.accounts && typeof savings.accounts === 'object' ? savings.accounts : {};
  savings.accounts = { ...accounts, robinhoodChecking: balance };
  await env.RENTALS.put('savings', JSON.stringify(savings));
}

async function handleSaveSavings(env, data) {
  if (!data || typeof data !== 'object') {
    return jsonResponse({ error: 'Missing data object' }, 400);
  }

  const accounts = (data.accounts && typeof data.accounts === 'object') ? data.accounts : {};
  const existingSavings = await env.RENTALS.get('savings', 'json') || {};
  const cachedPlaid = await env.RENTALS.get(ROBINHOOD_BALANCE_CACHE_KEY, 'json');
  const plaidChecking = typeof cachedPlaid?.balance === 'number' ? cachedPlaid.balance : NaN;
  const savedChecking = typeof existingSavings?.accounts?.robinhoodChecking === 'number'
    ? existingSavings.accounts.robinhoodChecking
    : NaN;
  const sanitizedAccounts = {
    // Robinhood Checking is server-owned and can only be changed by a successful
    // Plaid balance pull. Ignore all client-supplied checking values.
    robinhoodChecking: Number.isFinite(plaidChecking)
      ? plaidChecking
      : (Number.isFinite(savedChecking) ? savedChecking : 0),
    robinhoodBrokerage: (typeof accounts.robinhoodBrokerage === 'number' && isFinite(accounts.robinhoodBrokerage))
      ? accounts.robinhoodBrokerage
      : ((typeof accounts.ibkr === 'number' && isFinite(accounts.ibkr)) ? accounts.ibkr : 0),
  };

  const obligations = Array.isArray(data.obligations) ? data.obligations.map(o => ({
    id: o.id || crypto.randomUUID(),
    name: String(o.name || '').trim().slice(0, 200),
    amount: (typeof o.amount === 'number' && isFinite(o.amount) && o.amount >= 0) ? o.amount : 0,
    paymentsPerYear: (o.paymentsPerYear === 2) ? 2 : 1,
    kind: o.kind === 'static' ? 'static' : 'recurring',
    note: String(o.note || '').trim().slice(0, 400),
  })) : [];

  const payments = (data.payments && typeof data.payments === 'object') ? {} : {};
  if (data.payments && typeof data.payments === 'object') {
    for (const [year, paid] of Object.entries(data.payments)) {
      if (!/^\d{4}$/.test(year) || !paid || typeof paid !== 'object') continue;
      payments[year] = {};
      for (const [oid, arr] of Object.entries(paid)) {
        if (!Array.isArray(arr)) continue;
        payments[year][String(oid)] = arr.slice(0, 2).map(v => !!v);
      }
    }
  }

  const saved = {
    accounts: sanitizedAccounts,
    obligations,
    payments,
  };

  await env.RENTALS.put('savings', JSON.stringify(saved));
  return jsonResponse({ success: true, data: saved });
}

// ── Helper ────────────────────────────────────────────────────────────────────

class BodyTooLargeError extends Error {}

function validateApiEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'JSON body must be an object';
  if (typeof body.action !== 'string' || !/^[a-z0-9_]{1,64}$/.test(body.action)) return 'Invalid action';
  return validateJsonShape(body, 0);
}

function validateJsonShape(value, depth) {
  if (depth > MAX_API_JSON_DEPTH) return 'JSON body is nested too deeply';
  if (typeof value === 'string') {
    return value.length <= MAX_API_STRING_LENGTH ? '' : 'JSON string value is too long';
  }
  if (value === null || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    if (value.length > MAX_API_ARRAY_ITEMS) return 'JSON array has too many items';
    for (const item of value) {
      const error = validateJsonShape(item, depth + 1);
      if (error) return error;
    }
    return '';
  }

  const keys = Object.keys(value);
  if (keys.length > MAX_API_OBJECT_KEYS) return 'JSON object has too many fields';
  for (const key of keys) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return 'Unsafe JSON field name';
    const error = validateJsonShape(value[key], depth + 1);
    if (error) return error;
  }
  return '';
}

async function readBytesLimited(response, maxBytes) {
  const lengthHeader = response.headers.get('Content-Length');
  if (lengthHeader && Number(lengthHeader) > maxBytes) {
    throw new BodyTooLargeError(`Body is too large (${lengthHeader} bytes)`);
  }
  if (!response.body) throw new Error('Upstream response did not include a readable body');

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) { /* ignore cancel failure */ }
      throw new BodyTooLargeError(`Body exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readTextLimited(response, maxBytes) {
  return new TextDecoder().decode(await readBytesLimited(response, maxBytes));
}

async function readJsonLimited(response, maxBytes) {
  return JSON.parse(await readTextLimited(response, maxBytes));
}

function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return addSecurityHeaders(new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      ...extraHeaders,
    }
  }));
}
