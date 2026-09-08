// rentals-api — Cloudflare Worker for Rental Property Manager
// All amounts stored and returned in DOLLARS (never cents).
// KV keys: transactions:{property}, summaries:{property}, defaults:{property}, depreciation:{property}

export { MomBudgetStore } from './mom-budget-store.js';

import {
  STOCK_STICKIES_ACCOUNT_IDS,
  aggregateModifiedDietzReturn,
  assessStockStickiesRefreshConsistency,
  anchoredInstitutionPerformance,
  buildStockStickiesCspLedger,
  isRecognizedExternalFlow,
  mergeStockStickiesTransactions,
  modifiedDietzPerformance,
  stockStickiesAccountValues,
} from './performance-calculations.js';

const VALID_PROPERTIES = ['6AL', '95EB', '446BB', '731WO', '4781MC'];
const MOVE_IN_PURCHASE_PROPERTY = '4781MC';

const VALID_CATEGORIES = [
  'rent', 'deposit', 'late_fee', 'other_income',
  'taxes', 'insurance', 'repairs', 'improvements', 'utilities',
  'hoa', 'management', 'auto', 'legal', 'marketing', 'other_expense',
  'mortgage_interest', 'pmi'  // historical summaries only
];

const ALLOWED_ORIGIN = 'https://99redder.github.io';
const STOCK_STICKIES_ORIGINS = new Set([
  'https://stockstickies.com',
  'https://www.stockstickies.com',
  'https://mobile.stockstickies.com',
  'https://stock-stickies-mobile.eastern-shore-ai.chatgpt.site',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);
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
const STOCK_STICKIES_HOLDINGS_CACHE_KEY = 'stock_stickies:plaid:robinhood:holdings';
const STOCK_STICKIES_HOLDINGS_PREVIOUS_CACHE_KEY = 'stock_stickies:plaid:robinhood:holdings:previous';
const STOCK_STICKIES_HOLDINGS_FALLBACK_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const STOCK_STICKIES_INVESTMENTS_REFRESH_KEY = 'stock_stickies:plaid:robinhood:investments-refresh';
const STOCK_STICKIES_INVESTMENTS_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const STOCK_STICKIES_INVESTMENTS_REFRESH_IN_FLIGHT_MS = 90 * 1000;
const STOCK_STICKIES_PERFORMANCE_CONFIG_KEY = 'stock_stickies:plaid:robinhood:performance:config';
const STOCK_STICKIES_PERFORMANCE_SNAPSHOT_PREFIX = 'stock_stickies:plaid:robinhood:performance:snapshots:';
const STOCK_STICKIES_PERFORMANCE_TRANSACTION_PREFIX = 'stock_stickies:plaid:robinhood:performance:transactions:';

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
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/stock-stickies/')) {
      return handleStockStickiesApi(request, env, url, origin);
    }

    // Read-only Net Worth export for the Just In Case emergency app. Authorized
    // by the shared JIC_READ_TOKEN secret, not a session — reached worker-to-
    // worker via a service binding (no Origin header), so it sits ahead of the
    // browser Origin guard below.
    if (url.pathname === '/api/networth/accounts' && request.method === 'GET') {
      return handleNetWorthAccountsExport(request, env);
    }

    if (origin && origin !== ALLOWED_ORIGIN) {
      return jsonResponse({ error: 'Origin not allowed' }, 403);
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return addSecurityHeaders(new Response(null, { status: 204, headers: CORS_HEADERS }));
    }

    if (url.pathname === '/api/data' && request.method === 'POST') {
      return handleDataApi(request, env);
    }

    return jsonResponse({ error: 'Not Found' }, 404);
  },

  async scheduled(controller, env, ctx) {
    // Cloudflare cron expressions run in UTC. Paired triggers cover midnight
    // and 6 AM in both EST and EDT; the Eastern-hour guard prevents duplicates.
    const easternHour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(controller.scheduledTime));
    if (easternHour === '00') {
      ctx.waitUntil(runScheduledStockStickiesHoldingsRefresh(env, controller.scheduledTime));
    }
    if (easternHour === '06') {
      ctx.waitUntil(runScheduledRobinhoodRefresh(env, controller.scheduledTime));
      // Weekly (Mondays, ET): ping IRS + Maryland guidance pages for changes.
      const easternWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(controller.scheduledTime));
      if (easternWeekday === 'Mon') ctx.waitUntil(runTaxUpdateCheck(env).catch(() => {}));
    }
  }
};

async function handleStockStickiesApi(request, env, url, origin) {
  // Installed iOS PWAs can serialize their opaque origin as the literal
  // string "null". These endpoints still require a valid Firebase bearer
  // token, so allow that PWA origin while keeping arbitrary sites blocked.
  const originAllowed = !origin || origin === 'null' || STOCK_STICKIES_ORIGINS.has(origin);
  const corsHeaders = {
    'Access-Control-Allow-Origin': originAllowed && origin ? origin : 'https://www.stockstickies.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin',
  };

  if (!originAllowed) {
    return jsonResponse({ ok: false, error: 'Origin not allowed' }, 403, corsHeaders);
  }
  if (request.method === 'OPTIONS') {
    return addSecurityHeaders(new Response(null, { status: 204, headers: corsHeaders }));
  }

  const authorization = String(request.headers.get('Authorization') || '').trim();
  if (!authorization.startsWith('Bearer ')) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401, corsHeaders);
  }
  try {
    await verifyStockStickiesOwner(authorization.slice(7).trim(), env);
  } catch {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401, corsHeaders);
  }

  if (url.pathname === '/api/stock-stickies/plaid/status' && request.method === 'GET') {
    return handleStockStickiesPlaidStatus(env, corsHeaders);
  }
  if (url.pathname === '/api/stock-stickies/plaid/link-token' && request.method === 'POST') {
    return handleStockStickiesPlaidLinkToken(env, corsHeaders);
  }
  if (url.pathname === '/api/stock-stickies/plaid/holdings' && request.method === 'GET') {
    return handleStockStickiesPlaidHoldings(env, corsHeaders);
  }
  if (url.pathname === '/api/stock-stickies/plaid/refresh' && request.method === 'POST') {
    return handleStockStickiesPlaidRefresh(env, corsHeaders);
  }
  if (url.pathname === '/api/stock-stickies/plaid/performance' && request.method === 'GET') {
    return handleStockStickiesPlaidPerformance(env, corsHeaders);
  }
  if (url.pathname === '/api/stock-stickies/plaid/performance' && request.method === 'POST') {
    return handleSaveStockStickiesPerformanceReconciliation(request, env, corsHeaders);
  }
  return jsonResponse({ ok: false, error: 'Not found' }, 404, corsHeaders);
}

async function runScheduledRobinhoodRefresh(env, scheduledTime) {
  const checkingResp = await handleGetRobinhoodBalance(env, true, 'scheduled', ROBINHOOD_ACCOUNTS.checking);
  const brokerageResp = await handleGetRobinhoodBalance(env, true, 'scheduled', ROBINHOOD_ACCOUNTS.brokerage);
  console.log(JSON.stringify({
    event: 'scheduled_robinhood_balance_refresh',
    scheduledTime: new Date(scheduledTime).toISOString(),
    checkingStatus: checkingResp.status,
    checkingOk: checkingResp.ok,
    brokerageStatus: brokerageResp.status,
    brokerageOk: brokerageResp.ok,
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
  const easternYear = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
  }).format(new Date(scheduledTime));
  const businessResult = await refreshBusinessIncome(env, easternYear);
  console.log(JSON.stringify({
    event: 'scheduled_business_income_refresh',
    year: easternYear,
    fmg: businessResult.fmg.ok,
    esai: businessResult.esai.ok,
  }));
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
    return handleVerifyPassword(request, env, body.password, body.rememberDevice === true, body.code);
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
  if (action === 'fetch_fmg_tax_summary') return handleFetchFmgTaxSummary(env, body.year);
  if (action === 'fetch_esai_tax_summary') return handleFetchEsaiTaxSummary(env, body.year);
  if (action === 'refresh_business_income') return handleRefreshBusinessIncome(env, body.year);
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

  // Mom Moving Checklist — global
  if (action === 'get_mom_checklist')  return handleGetMomChecklist(env);
  if (action === 'save_mom_checklist') return handleSaveMomChecklist(env, body.data);

  // Tax guidance update check — global
  if (action === 'check_tax_updates')      return jsonResponse(await runTaxUpdateCheck(env));
  if (action === 'acknowledge_tax_update') return jsonResponse(await acknowledgeTaxUpdate(env));
  if (action === 'get_tax_update_check')   return jsonResponse((await env.RENTALS.get(TAX_UPDATE_KEY, 'json')) || { checkedAt: null, hasChanges: false, acknowledged: {}, sources: [] });

  // Savings — global
  if (action === 'get_savings')  return handleGetSavings(env);
  if (action === 'save_savings') return handleSaveSavings(env, body.data);

  // Health — global (workouts, diet/calories, weight loss, rewards)
  if (action === 'get_health')  return handleGetHealth(env);
  if (action === 'save_health') return handleSaveHealth(env, body.data);
  if (action === 'get_robinhood_balance') return handleGetRobinhoodBalance(env, body.refresh === true, 'client', ROBINHOOD_ACCOUNTS.checking);
  if (action === 'get_robinhood_brokerage_balance') return handleGetRobinhoodBalance(env, body.refresh === true, 'client', ROBINHOOD_ACCOUNTS.brokerage);
  if (action === 'get_net_worth') return handleGetNetWorth(env);
  if (action === 'save_net_worth') return handleSaveNetWorth(env, body.data);
  if (action === 'refresh_net_worth_plaid') return handleRefreshNetWorthPlaid(env, body.forceLive === true);
  if (action === 'create_plaid_link_token') return handleCreatePlaidLinkToken(env, body.itemId, body.institution, body.accountSelection);
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
    'save_move_in_purchases', 'add_move_in_purchase', 'update_move_in_purchase', 'delete_move_in_purchase',
    'save_move_in_categories',
    'save_later_list', 'add_later_item', 'update_later_item', 'delete_later_item',
    'save_later_categories', 'move_purchase_item'
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

    case 'get_move_in_categories':
      return handleGetMoveInCategories(env, property);

    case 'save_move_in_categories':
      return handleSaveMoveInCategories(env, property, body.categories);

    case 'get_later_list':
      return handleGetLaterList(env, property);

    case 'save_later_list':
      return handleSaveLaterList(env, property, body.entries);

    case 'add_later_item':
      return handleAddLaterItem(env, property, body.entry);

    case 'update_later_item':
      return handleUpdateLaterItem(env, property, body.id, body.entry);

    case 'delete_later_item':
      return handleDeleteLaterItem(env, property, body.id);

    case 'get_later_categories':
      return handleGetLaterCategories(env, property);

    case 'save_later_categories':
      return handleSaveLaterCategories(env, property, body.categories);

    case 'move_purchase_item':
      return handleMovePurchaseItem(env, property, body.id, body.source);

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

async function handleVerifyPassword(request, env, password, rememberDevice = false, code = '') {
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

  // Second factor — enforced only when the TOTP_SECRET Worker secret is set.
  // A wrong/missing code after a correct password still counts toward the
  // lockout so the 6-digit code can't be brute-forced with a known password.
  const totpSecret = String(env.TOTP_SECRET || '').trim();
  if (totpSecret) {
    if (!(await verifyTotp(totpSecret, code))) {
      await env.RENTALS.put(failKey, String(failures + 1), { expirationTtl: LOGIN_WINDOW_SECONDS });
      return jsonResponse({ ok: false, totpRequired: true, error: 'Invalid authenticator code' });
    }
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

const BUSINESS_TAX_SOURCES = {
  fmg: {
    label: 'FMG',
    url: 'https://florencemaegifts.com/api/tax/summary',
    secret: 'FMG_TAX_READ_TOKEN',
  },
  esai: {
    label: 'Eastern Shore AI',
    url: 'https://eastern-shore-ai-contact.99redder.workers.dev/api/tax/summary',
    secret: 'ESAI_TAX_READ_TOKEN',
    serviceBinding: 'ESAI_API',
  },
};

async function fetchBusinessTaxSummary(env, sourceKey, year) {
  const source = BUSINESS_TAX_SOURCES[sourceKey];
  if (!source || !/^\d{4}$/.test(String(year || ''))) throw new Error('Invalid business tax request');
  const token = String(env[source.secret] || '').trim();
  if (!token) throw new Error(`${source.label} read-only tax integration is not configured`);

  let response;
  try {
    const request = new Request(`${source.url}?year=${encodeURIComponent(year)}`, {
      headers: { 'X-Tax-Read-Token': token, Accept: 'application/json' },
    });
    const service = source.serviceBinding ? env[source.serviceBinding] : null;
    response = service ? await service.fetch(request) : await fetch(request);
  } catch (error) {
    throw new Error(`Failed to reach ${source.label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const payload = await readJsonLimited(response, MAX_UPSTREAM_JSON_BYTES).catch(() => ({}));
  if (!response.ok) throw new Error(`${source.label} read-only tax request failed (${response.status})`);

  const incomeCents = Number(payload.incomeCents);
  const expenseCents = Number(payload.expenseCents);
  const netCents = Number(payload.netCents);
  if (![incomeCents, expenseCents, netCents].every(Number.isFinite)) {
    throw new Error(`${source.label} returned an invalid tax summary`);
  }
  const ownerRetirementContributionCents = sourceKey === 'fmg'
    ? Number(payload.ownerRetirementContributionCents)
    : 0;
  if (!Number.isFinite(ownerRetirementContributionCents)) {
    throw new Error(`${source.label} returned an invalid owner-retirement total`);
  }
  return { ok: true, incomeCents, expenseCents, netCents, ownerRetirementContributionCents, fetchedAt: new Date().toISOString() };
}

async function refreshBusinessIncome(env, year) {
  const validYear = String(year || '');
  if (!/^\d{4}$/.test(validYear)) {
    return { fmg: { ok: false, error: 'Invalid year' }, esai: { ok: false, error: 'Invalid year' } };
  }
  const [fmgSettled, esaiSettled] = await Promise.allSettled([
    fetchBusinessTaxSummary(env, 'fmg', validYear),
    fetchBusinessTaxSummary(env, 'esai', validYear),
  ]);
  const result = {
    fmg: fmgSettled.status === 'fulfilled' ? fmgSettled.value : { ok: false, error: fmgSettled.reason instanceof Error ? fmgSettled.reason.message : 'FMG refresh failed' },
    esai: esaiSettled.status === 'fulfilled' ? esaiSettled.value : { ok: false, error: esaiSettled.reason instanceof Error ? esaiSettled.reason.message : 'Eastern Shore AI refresh failed' },
  };

  if (result.fmg.ok || result.esai.ok) {
    const data = await env.RENTALS.get(`tax_planning:${validYear}`, 'json') || {};
    if (result.fmg.ok) {
      data.fmg = result.fmg.netCents / 100;
      data.fmg_solo_401k = result.fmg.ownerRetirementContributionCents / 100;
      data.fmg_fetched_at = result.fmg.fetchedAt;
    }
    if (result.esai.ok) {
      data.esai = result.esai.netCents / 100;
      data.esai_fetched_at = result.esai.fetchedAt;
    }
    await env.RENTALS.put(`tax_planning:${validYear}`, JSON.stringify(data));
  }
  return result;
}

async function handleRefreshBusinessIncome(env, year) {
  if (!/^\d{4}$/.test(String(year || ''))) return jsonResponse({ error: 'Invalid year' }, 400);
  return jsonResponse({ results: await refreshBusinessIncome(env, String(year)) });
}

async function handleFetchFmgTaxSummary(env, year) {
  if (!/^\d{4}$/.test(String(year || ''))) return jsonResponse({ error: 'Invalid year' }, 400);
  try { return jsonResponse(await fetchBusinessTaxSummary(env, 'fmg', String(year))); }
  catch (error) { return jsonResponse({ error: error instanceof Error ? error.message : 'FMG refresh failed' }, 502); }
}

async function handleFetchEsaiTaxSummary(env, year) {
  if (!/^\d{4}$/.test(String(year || ''))) return jsonResponse({ error: 'Invalid year' }, 400);
  try { return jsonResponse(await fetchBusinessTaxSummary(env, 'esai', String(year))); }
  catch (error) { return jsonResponse({ error: error instanceof Error ? error.message : 'Eastern Shore AI refresh failed' }, 502); }
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

// ── TOTP (RFC 6238) — optional second factor ──────────────────────────────────
// Verifies a 6-digit time-based code against the base32 TOTP_SECRET. Standard
// params (6 digits / 30-second step / HMAC-SHA1) so any authenticator app works
// — Microsoft Authenticator, Google Authenticator, 1Password, Authy. Accepts
// the adjacent windows (±1 step) to tolerate device clock drift. No deps: uses
// crypto.subtle, which supports HMAC-SHA1 on Workers.
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_SKEW_STEPS = 1;

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue; // ignore stray separators (spaces, dashes)
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

async function totpCodeForStep(secretBytes, step) {
  const counter = new ArrayBuffer(8);
  const view = new DataView(counter);
  // 64-bit big-endian counter (high word first).
  view.setUint32(0, Math.floor(step / 0x1_0000_0000));
  view.setUint32(4, step >>> 0);
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = sig[sig.length - 1] & 0x0f;
  const binary = ((sig[offset] & 0x7f) << 24)
    | ((sig[offset + 1] & 0xff) << 16)
    | ((sig[offset + 2] & 0xff) << 8)
    | (sig[offset + 3] & 0xff);
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

async function verifyTotp(secret, code, now = Date.now()) {
  const cleanCode = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleanCode)) return false;
  const secretBytes = base32Decode(secret);
  if (secretBytes.length === 0) return false;
  const currentStep = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  let match = false;
  // Check every window (no early return) so the work is constant regardless of
  // which step matches.
  for (let offset = -TOTP_SKEW_STEPS; offset <= TOTP_SKEW_STEPS; offset++) {
    const expected = await totpCodeForStep(secretBytes, currentStep + offset);
    if (timingSafeEqualStrings(expected, cleanCode)) match = true;
  }
  return match;
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
    category: String(entry.category || '').trim(),
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

const MOVE_IN_CATEGORIES_DEFAULT = ['Living Room', 'Basement', 'Craft Room', 'Office', 'Kitchen / Dining Room', 'Ellie', 'Mom', 'Other'];

function normalizeMoveInCategories(list) {
  if (!Array.isArray(list)) return MOVE_IN_CATEGORIES_DEFAULT.slice();
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 100) break;
  }
  return out.length ? out : MOVE_IN_CATEGORIES_DEFAULT.slice();
}

async function handleGetMoveInCategories(env, property) {
  const propertyError = requireMoveInPurchaseProperty(property);
  if (propertyError) return propertyError;
  const stored = await env.RENTALS.get(`move_in_categories:${property}`, 'json');
  const categories = Array.isArray(stored) && stored.length ? stored : MOVE_IN_CATEGORIES_DEFAULT.slice();
  return jsonResponse({ categories });
}

async function handleSaveMoveInCategories(env, property, categories) {
  const propertyError = requireMoveInPurchaseProperty(property);
  if (propertyError) return propertyError;
  const saved = normalizeMoveInCategories(categories);
  await env.RENTALS.put(`move_in_categories:${property}`, JSON.stringify(saved));
  return jsonResponse({ categories: saved });
}

// ── Later List ─────────────────────────────────────────────────────────────────
// Same setup as Move-In Purchases; separate KV records for post-move-in purchases.

const LATER_LIST_PROPERTY = '4781MC';

function requireLaterListProperty(property) {
  return property === LATER_LIST_PROPERTY
    ? null
    : jsonResponse({ error: 'The later list is only available for 4781MC' }, 400);
}

async function handleGetLaterList(env, property) {
  const propertyError = requireLaterListProperty(property);
  if (propertyError) return propertyError;
  const entries = await env.RENTALS.get(`later_list:${property}`, 'json') || [];
  return jsonResponse({ entries });
}

async function handleSaveLaterList(env, property, entries) {
  const propertyError = requireLaterListProperty(property);
  if (propertyError) return propertyError;
  if (!Array.isArray(entries)) {
    return jsonResponse({ error: 'entries must be an array' }, 400);
  }
  const saved = entries.map(e => normalizeMoveInPurchase({ ...e, id: e.id || crypto.randomUUID() }));
  await env.RENTALS.put(`later_list:${property}`, JSON.stringify(saved));
  return jsonResponse({ entries: saved });
}

async function handleAddLaterItem(env, property, entry) {
  const propertyError = requireLaterListProperty(property);
  if (propertyError) return propertyError;
  if (!entry || typeof entry !== 'object') {
    return jsonResponse({ error: 'Missing entry object' }, 400);
  }
  const newEntry = normalizeMoveInPurchase({ ...entry, id: crypto.randomUUID() });
  if (!newEntry.item) return jsonResponse({ error: 'Item is required' }, 400);
  const entries = await env.RENTALS.get(`later_list:${property}`, 'json') || [];
  entries.push(newEntry);
  await env.RENTALS.put(`later_list:${property}`, JSON.stringify(entries));
  return jsonResponse({ entry: newEntry });
}

async function handleUpdateLaterItem(env, property, id, entry) {
  const propertyError = requireLaterListProperty(property);
  if (propertyError) return propertyError;
  if (!id) return jsonResponse({ error: 'Missing id' }, 400);
  if (!entry || typeof entry !== 'object') return jsonResponse({ error: 'Missing entry' }, 400);
  const entries = await env.RENTALS.get(`later_list:${property}`, 'json') || [];
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return jsonResponse({ error: 'Entry not found' }, 404);
  entries[idx] = normalizeMoveInPurchase({
    ...entries[idx],
    ...entry,
    id,
  });
  if (!entries[idx].item) return jsonResponse({ error: 'Item is required' }, 400);
  await env.RENTALS.put(`later_list:${property}`, JSON.stringify(entries));
  return jsonResponse({ entry: entries[idx] });
}

async function handleDeleteLaterItem(env, property, id) {
  const propertyError = requireLaterListProperty(property);
  if (propertyError) return propertyError;
  if (!id) return jsonResponse({ error: 'Missing id' }, 400);
  const entries = await env.RENTALS.get(`later_list:${property}`, 'json') || [];
  const filtered = entries.filter(e => e.id !== id);
  if (filtered.length === entries.length) return jsonResponse({ error: 'Entry not found' }, 404);
  await env.RENTALS.put(`later_list:${property}`, JSON.stringify(filtered));
  return jsonResponse({ success: true });
}

async function handleMovePurchaseItem(env, property, id, source) {
  const propertyError = requireMoveInPurchaseProperty(property);
  if (propertyError) return propertyError;
  if (!id) return jsonResponse({ error: 'Missing id' }, 400);
  if (source !== 'move-in' && source !== 'later') {
    return jsonResponse({ error: 'Source must be move-in or later' }, 400);
  }

  const sourceKey = source === 'move-in'
    ? `move_in_purchases:${property}`
    : `later_list:${property}`;
  const destinationKey = source === 'move-in'
    ? `later_list:${property}`
    : `move_in_purchases:${property}`;
  const sourceEntries = await env.RENTALS.get(sourceKey, 'json') || [];
  const sourceIndex = sourceEntries.findIndex(e => e.id === id);
  if (sourceIndex === -1) return jsonResponse({ error: 'Entry not found' }, 404);

  const entry = normalizeMoveInPurchase({ ...sourceEntries[sourceIndex], id });
  const destinationEntries = await env.RENTALS.get(destinationKey, 'json') || [];
  if (destinationEntries.some(e => e.id === id)) {
    return jsonResponse({ error: 'Entry already exists in the destination list' }, 409);
  }

  // Write the destination first so an interrupted move cannot lose the item.
  destinationEntries.push(entry);
  await env.RENTALS.put(destinationKey, JSON.stringify(destinationEntries));
  sourceEntries.splice(sourceIndex, 1);
  await env.RENTALS.put(sourceKey, JSON.stringify(sourceEntries));
  return jsonResponse({ success: true, entry });
}

async function handleGetLaterCategories(env, property) {
  const propertyError = requireLaterListProperty(property);
  if (propertyError) return propertyError;
  const stored = await env.RENTALS.get(`later_categories:${property}`, 'json');
  if (Array.isArray(stored) && stored.length) return jsonResponse({ categories: stored });
  // Until the Later List has its own categories, mirror the current Move-In
  // Purchases categories (falling back to the shared default when those are unset).
  const moveIn = await env.RENTALS.get(`move_in_categories:${property}`, 'json');
  const categories = Array.isArray(moveIn) && moveIn.length ? moveIn : MOVE_IN_CATEGORIES_DEFAULT.slice();
  return jsonResponse({ categories });
}

async function handleSaveLaterCategories(env, property, categories) {
  const propertyError = requireLaterListProperty(property);
  if (propertyError) return propertyError;
  const saved = normalizeMoveInCategories(categories);
  await env.RENTALS.put(`later_categories:${property}`, JSON.stringify(saved));
  return jsonResponse({ categories: saved });
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

  const sanitizeItems = (items, type) => Array.isArray(items) ? items.map(item => ({
    id: item.id || crypto.randomUUID(),
    date: String(item.date || '').trim().slice(0, 10),
    name: String(item.name || '').trim().slice(0, 160),
    amount: (typeof item.amount === 'number' && isFinite(item.amount) && item.amount >= 0) ? item.amount : 0,
    note: String(item.note || '').trim().slice(0, 300),
    expected: type === 'income' && item.expected === true,
  })).filter(item => item.name || item.amount > 0) : [];
  const sanitizeDismissed = arr => Array.isArray(arr)
    ? [...new Set(arr.filter(x => typeof x === 'string').map(x => x.slice(0, 80)))].slice(0, 100)
    : [];
  const sanitizeScenario = s => ({
    income: sanitizeItems(s?.income, 'income'),
    expenses: sanitizeItems(s?.expenses, 'expenses'),
    dismissedAuto: sanitizeDismissed(s?.dismissedAuto),
  });

  // Cash Flow now has one canonical plan. During migration, preserve the former
  // primary/sell scenario and flatten it into the stored record.
  const rawScenarios = (data.scenarios && typeof data.scenarios === 'object') ? data.scenarios : null;
  const primary = sanitizeScenario(rawScenarios ? rawScenarios.sell : data);

  const saved = {
    year: Number(year),
    robinhoodChecking: (typeof data.robinhoodChecking === 'number' && isFinite(data.robinhoodChecking) && data.robinhoodChecking >= 0)
      ? data.robinhoodChecking
      : 0,
    income: primary.income,
    expenses: primary.expenses,
    dismissedAuto: primary.dismissedAuto,
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

// Mirror of the frontend fsHousingBenchmark — her housing share is her portion of
// the home's real carrying cost (maintenance/capital reserve + property tax /
// insurance / HOA + the shared utility bills pulled from the budget's Utilities
// category), decoupled from the mortgage. The folded utility ids are returned so
// the caller can exclude them from the normal per-item split (no double counting).
// Returns { itemId, monthlyCost, utilityItemIds } or null.
function fairShareHousingBenchmark(fs, expenses, shared) {
  const h = fs.housingBenchmark;
  if (!h || !h.enabled) return null;
  const utilAll = Array.isArray(expenses['Utilities']) ? expenses['Utilities'] : [];
  const utilItems = utilAll.filter(it => Object.prototype.hasOwnProperty.call(shared, it.id)
    ? !!shared[it.id]
    : !!FS_SHARED_CAT_DEFAULTS['Utilities']);
  const utilities = utilItems.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const utilityItemIds = utilItems.map(it => it.id);
  const homeValue = Number(h.homeValue) || 0;
  const reservePct = Number(h.reservePct) || 0;
  const reserve = (homeValue > 0 && reservePct > 0) ? (reservePct / 100 * homeValue) / 12 : 0;
  const monthlyCost = reserve + (Number(h.propertyTax) || 0) + (Number(h.insurance) || 0)
    + (Number(h.hoa) || 0) + utilities;
  if (!(monthlyCost > 0)) return null;
  let itemId = typeof h.itemId === 'string' ? h.itemId : '';
  if (!itemId) {
    const items = Array.isArray(expenses['Mortgage']) ? expenses['Mortgage'] : [];
    const match = items.find(i => /mortgage/i.test(String(i.name || ''))) || items[0];
    itemId = match ? match.id : '';
  }
  return itemId ? { itemId, monthlyCost, utilityItemIds } : null;
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
  const hAdj = fairShareHousingBenchmark(fs, expenses, shared);
  let herShare = 0;
  for (const cat of Object.keys(expenses)) {
    const items = Array.isArray(expenses[cat]) ? expenses[cat] : [];
    for (const item of items) {
      const isShared = Object.prototype.hasOwnProperty.call(shared, item.id)
        ? !!shared[item.id]
        : !!FS_SHARED_CAT_DEFAULTS[cat];
      if (isShared) {
        // Utility items folded into the housing carrying cost aren't split again here.
        if (hAdj && hAdj.utilityItemIds.includes(item.id)) continue;
        const participants = fairShareItemParticipants(item, cat, fs, householdSize);
        const amt = Number(item.amount) || 0;
        if (hAdj && item.id === hAdj.itemId) {
          // Housing benchmark supersedes the mortgage exclusion on the same item.
          herShare += hAdj.monthlyCost / participants;
        } else if (fbAdj && item.id === fbAdj.itemId) {
          herShare += fbAdj.amount;
        } else {
          const effAmt = (mAdj && item.id === mAdj.itemId) ? Math.max(0, amt - mAdj.principal) : amt;
          herShare += effAmt / participants;
        }
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
  const data = await env.MOM_BUDGET_STORE.getByName('mom_budget').getBudget();
  return jsonResponse({ data });
}

async function handleSaveMomBudget(env, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return jsonResponse({ error: 'Missing data object' }, 400);
  }
  await env.MOM_BUDGET_STORE.getByName('mom_budget').saveBudget(data);
  return jsonResponse({ success: true });
}

// Public, read-only endpoint for mom-budget-phone.html. Keep the per-IP burst
// guard, but never cache spending balances: every poll must see completed saves.

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

  const year = monthKey.slice(0, 4);
  // Compute the Fair Share transfer live from the family budget, the same source
  // the main app uses, rather than relying on a possibly-stale copy in mom_budget.
  const [budgetRaw, raw] = await Promise.all([
    env.RENTALS.get('budget', 'json'),
    env.MOM_BUDGET_STORE.getByName('mom_budget').getBudget(),
  ]);
  const fairShare = calcFairShareFromBudget(budgetRaw || {});
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
    },
  });

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

  // New-build settings (deposit paid, mortgage at settlement, settled flag).
  // Cash to close is not stored here — it is read from the cash flow record.
  if (config.construction && typeof config.construction === 'object') {
    const c = config.construction;
    const money = value => (Number.isFinite(Number(value)) && Number(value) >= 0) ? Number(value) : 0;
    saved.construction = {
      deposit: money(c.deposit),
      loanAmount: money(c.loanAmount),
      prepaidCosts: money(c.prepaidCosts),
      settlementNote: String(c.settlementNote || '').slice(0, 200),
      settled: c.settled === true,
    };
  } else if (existing.construction) {
    saved.construction = existing.construction;
  }

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
    // Allow negative line values: proration credits paid to the seller are a
    // credit that reduces net closing costs. The overall total is still
    // guarded against going negative by the caller.
    if (!isFinite(value)) continue;
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

// ── Mom Moving Checklist ──────────────────────────────────────────────────────
// Single global KV record `mom_checklist` — an array of
// { id, text, note, done }. Full-overwrite save, mirroring deductions.
async function handleGetMomChecklist(env) {
  const items = await env.RENTALS.get('mom_checklist', 'json') || [];
  return jsonResponse({ items });
}

async function handleSaveMomChecklist(env, data) {
  if (!data || !Array.isArray(data)) {
    return jsonResponse({ error: 'data must be an array' }, 400);
  }
  const sanitized = data.map(i => ({
    id: i.id || crypto.randomUUID(),
    text: String(i.text || '').trim().slice(0, 500),
    note: String(i.note || '').trim().slice(0, 1000),
    done: !!i.done
  })).filter(i => i.text);
  await env.RENTALS.put('mom_checklist', JSON.stringify(sanitized));
  return jsonResponse({ success: true, items: sanitized });
}

// ── Tax guidance update check ─────────────────────────────────────────────────
// Pings the authoritative IRS + Maryland forms/guidance pages server-side (the
// browser CSP can't) and reports status + Last-Modified so the user knows when
// new guidance/forms drop. Change detection compares to the last stored check.
// It NEVER edits the app's tax constants — that stays a human review step.
const TAX_UPDATE_KEY = 'tax_update_check';
const TAX_UPDATE_SOURCES = [
  { label: 'IRS — About Form 1040', url: 'https://www.irs.gov/forms-pubs/about-form-1040' },
  { label: 'IRS — Forms & Instructions (latest revisions)', url: 'https://www.irs.gov/forms-instructions' },
  { label: "IRS — Newsroom (what's new)", url: 'https://www.irs.gov/newsroom' },
  { label: "Maryland — What's New this filing season", url: 'https://www.marylandtaxes.gov/new-tax-year-update.php' },
  { label: 'Maryland — Individual forms & instructions', url: 'https://www.marylandtaxes.gov/individual/income/income-forms-index.php' },
  { label: 'Maryland — Local income tax rates', url: 'https://www.marylandtaxes.gov/individual/income/tax-info/tax-rates.php' },
];

async function fetchTaxSource(src) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(src.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RentalsTaxCheck/1.0)', 'Accept': 'text/html' },
    });
    const lastModified = res.headers.get('last-modified') || '';
    let title = '';
    let contentUpdated = '';
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      const html = (await res.text()).slice(0, 400000);
      const tm = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
      if (tm) title = tm[1].replace(/\s+/g, ' ').trim();
      // The page's own content-revision date (IRS: "Page Last Reviewed or
      // Updated: 28-Jun-2026"). This is the real change signal — the HTTP
      // Last-Modified header is CDN churn and produces false positives.
      const pm = html.match(/Page Last Reviewed or Updated:[\s\S]{0,120}?(\d{1,2}-[A-Za-z]{3}-\d{4})/i)
        || html.match(/Last Updated:[\s\S]{0,60}?(\d{1,2}-[A-Za-z]{3}-\d{4})/i);
      if (pm) contentUpdated = pm[1];
    }
    // Change detection uses the content date if we found one, else the title —
    // never the volatile HTTP Last-Modified.
    const signature = contentUpdated || title || '';
    return { label: src.label, url: src.url, ok: res.ok, status: res.status, lastModified, title, contentUpdated, signature };
  } catch (e) {
    return { label: src.label, url: src.url, ok: false, status: 0, error: (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function runTaxUpdateCheck(env) {
  const prev = await env.RENTALS.get(TAX_UPDATE_KEY, 'json');
  // The change baseline is the last ACKNOWLEDGED signature per source, NOT the
  // previous check. This is deliberate: comparing to the previous check made a
  // real change auto-clear after the next weekly run (whether or not the user
  // reviewed it), and it re-nagged every time a noisy index page (e.g. IRS
  // "Page Last Reviewed or Updated") ticked its date. With an acknowledged
  // baseline, a detected change stays flagged until the user acknowledges it,
  // and once acknowledged it stays quiet until the page actually changes again.
  const acknowledged = (prev && prev.acknowledged && typeof prev.acknowledged === 'object') ? { ...prev.acknowledged } : {};
  const firstRun = !prev || !prev.checkedAt;
  const sources = await Promise.all(TAX_UPDATE_SOURCES.map(fetchTaxSource));
  let hasChanges = false;
  for (const s of sources) {
    const ackSig = acknowledged[s.url];
    if (firstRun || ackSig === undefined) {
      // First check overall, or a source we've never seen (newly added, or the
      // one-time upgrade from the old record shape that had no acknowledged
      // baseline): adopt the current signature as the baseline so we never
      // false-positive on it. Real changes from here on will flag.
      if (s.signature) acknowledged[s.url] = s.signature;
      s.changed = false;
    } else {
      // Flag only when the current signature differs from the acknowledged one,
      // and both are non-empty (ignores CDN Last-Modified churn and transient
      // fetch failures that yield no signature).
      s.changed = !!(s.signature && ackSig && ackSig !== s.signature);
    }
    if (s.changed) hasChanges = true;
  }
  const record = { checkedAt: new Date().toISOString(), previousCheckedAt: prev ? (prev.checkedAt || null) : null, hasChanges, acknowledged, sources };
  await env.RENTALS.put(TAX_UPDATE_KEY, JSON.stringify(record));
  return record;
}

// Records the current source signatures as the acknowledged baseline and clears
// the change flag. Called by the app's "Acknowledge" control so the dismissal
// persists server-side (across devices) and the same date never re-nags.
async function acknowledgeTaxUpdate(env) {
  const rec = await env.RENTALS.get(TAX_UPDATE_KEY, 'json');
  if (!rec) return { checkedAt: null, hasChanges: false, acknowledged: {}, sources: [] };
  const acknowledged = { ...(rec.acknowledged || {}) };
  if (Array.isArray(rec.sources)) {
    for (const s of rec.sources) {
      if (s && s.url && s.signature) acknowledged[s.url] = s.signature;
      if (s) s.changed = false;
    }
  }
  const record = { ...rec, acknowledged, hasChanges: false, acknowledgedAt: new Date().toISOString() };
  await env.RENTALS.put(TAX_UPDATE_KEY, JSON.stringify(record));
  return record;
}

// ── Savings ───────────────────────────────────────────────────────────────────

async function handleGetSavings(env) {
  const data = await env.RENTALS.get('savings', 'json') || {};
  return jsonResponse({ data });
}

// ── Health ───────────────────────────────────────────────────────────────────
// Single global KV record `health` holding the whole tracker (profile/targets,
// food database, workout + meal plan templates, reward schedule, per-day logs,
// weekly weigh-ins). The frontend owns the shape; the save is a full overwrite
// with a top-level whitelist so stray keys don't accumulate.
async function handleGetHealth(env) {
  const data = await env.RENTALS.get('health', 'json') || {};
  return jsonResponse({ data });
}

async function handleSaveHealth(env, data) {
  if (!data || typeof data !== 'object') {
    return jsonResponse({ error: 'Missing data object' }, 400);
  }
  const clean = {};
  for (const key of ['profile', 'foods', 'workoutPlan', 'mealPlan', 'rewardSchedule', 'days', 'weighIns']) {
    if (data[key] !== undefined) clean[key] = data[key];
  }
  await env.RENTALS.put('health', JSON.stringify(clean));
  return jsonResponse({ success: true, data: clean });
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
    // Signed LT gain + recapture amount, so the read-only PWA can mirror the
    // combined sale-tax netting (normalizeNetWorth strips unknown keys).
    taxableGain: Number.isFinite(Number(item.taxableGain)) ? Number(item.taxableGain) : 0,
    depreciationRecapture: Number.isFinite(Number(item.depreciationRecapture)) ? Number(item.depreciationRecapture) : 0,
    stateCapGainsPct: Number.isFinite(Number(item.stateCapGainsPct)) ? Number(item.stateCapGainsPct) : 0,
    // New builds still under construction are carried at the deposit paid.
    preconstruction: item.preconstruction === true,
    deposit: Number.isFinite(Number(item.deposit)) ? Number(item.deposit) : 0,
    cashToClose: Number.isFinite(Number(item.cashToClose)) ? Number(item.cashToClose) : 0,
    loanAmount: Number.isFinite(Number(item.loanAmount)) ? Number(item.loanAmount) : 0,
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

// Read-only export of Net Worth accounts for the Just In Case emergency app.
// Authorized by the shared JIC_READ_TOKEN secret (constant-time compared).
// This never mutates state and returns assets only — see buildNetWorthAccountExport.
async function handleNetWorthAccountsExport(request, env) {
  const expected = String(env.JIC_READ_TOKEN || '').trim();
  const provided = String(request.headers.get('X-Read-Token') || '').trim();
  if (!expected || !provided || !timingSafeEqualStrings(provided, expected)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  const data = applyKnownPlaidAccountLabels(
    normalizeNetWorth(await env.RENTALS.get(NET_WORTH_KEY, 'json')),
    env,
  );
  return jsonResponse({ accounts: buildNetWorthAccountExport(data), refreshedAt: data.plaidRefreshedAt || '' });
}

// Flattens the Net Worth record into asset "accounts" the Just In Case money
// list can display. Assets only — liabilities (mortgages, manual debts) are
// excluded because that view is "where the money IS". Each entry carries a
// stable `key` so the consumer can namespace ids and de-dupe deterministically.
function buildNetWorthAccountExport(data) {
  const accounts = [];
  const plaidType = (subtype) => {
    const s = String(subtype || '').toLowerCase();
    if (['checking', 'savings', 'cash management', 'money market', 'cd'].includes(s)) return 'Bank';
    if (['ira', 'roth', '401k', '403b', 'retirement', 'pension'].includes(s)) return 'Retirement';
    if (s === 'crypto') return 'Crypto';
    return 'Investment';
  };
  for (const a of data.plaidAccounts || []) {
    if (a.side === 'liability') continue;
    accounts.push({
      key: `plaid:${a.id}`,
      name: a.name || a.institution || 'Linked account',
      type: plaidType(a.subtype),
      balance: Math.max(0, Number(a.value) || 0),
      institution: a.institution || '',
      mask: a.mask || '',
    });
  }
  const t = data.treasuryPortfolio;
  if (t && Number(t.value) > 0) {
    accounts.push({ key: 'treasury', name: t.name || 'U.S. Treasury Bonds', type: 'Investment', balance: Number(t.value) || 0, institution: 'U.S. Treasury', mask: '' });
  }
  for (const m of data.manualItems || []) {
    if (m.side === 'liability') continue;
    accounts.push({ key: `manual:${m.id}`, name: m.name, type: m.category || 'Other', balance: Number(m.value) || 0, institution: '', mask: '' });
  }
  for (const v of data.vehicles || []) {
    accounts.push({ key: `vehicle:${v.id}`, name: v.name || `${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim() || 'Vehicle', type: 'Vehicle', balance: Number(v.value) || 0, institution: '', mask: '' });
  }
  for (const p of data.propertyAssets || []) {
    accounts.push({ key: `property:${p.id}`, name: p.name, type: 'Property', balance: Number(p.value) || 0, institution: '', mask: '' });
  }
  return accounts.filter(a => a.name);
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

async function verifyStockStickiesOwner(token, env) {
  const projectId = String(env.STOCK_STICKIES_FIREBASE_PROJECT_ID || '').trim();
  const ownerUid = String(env.STOCK_STICKIES_OWNER_UID || '').trim();
  if (!projectId || !ownerUid || !token) throw new Error('Firebase auth is not configured');

  const segments = token.split('.');
  if (segments.length !== 3) throw new Error('Invalid token');
  const header = JSON.parse(decodeBase64UrlText(segments[0]));
  const claims = JSON.parse(decodeBase64UrlText(segments[1]));
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Invalid token header');

  const keysResponse = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
    { cf: { cacheEverything: true, cacheTtl: 3600 } }
  );
  if (!keysResponse.ok) throw new Error('Unable to load signing keys');
  const keySet = await readJsonLimited(keysResponse, 256_000);
  const signingKey = Array.isArray(keySet.keys)
    ? keySet.keys.find(candidate => candidate.kid === header.kid)
    : null;
  if (!signingKey) throw new Error('Unknown signing key');

  const key = await crypto.subtle.importKey(
    'jwk',
    signingKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const validSignature = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    decodeBase64UrlBytes(segments[2]),
    new TextEncoder().encode(`${segments[0]}.${segments[1]}`)
  );
  if (!validSignature) throw new Error('Invalid signature');

  const now = Math.floor(Date.now() / 1000);
  if (
    claims.aud !== projectId ||
    claims.iss !== `https://securetoken.google.com/${projectId}` ||
    claims.sub !== ownerUid ||
    typeof claims.exp !== 'number' ||
    claims.exp <= now ||
    typeof claims.iat !== 'number' ||
    claims.iat > now + 300
  ) {
    throw new Error('Token claims are not authorized');
  }
  return claims;
}

function decodeBase64UrlText(value) {
  return new TextDecoder().decode(decodeBase64UrlBytes(value));
}

function decodeBase64UrlBytes(value) {
  const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const decoded = atob(padded);
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

async function findRobinhoodPlaidItem(env) {
  for (const accessToken of plaidAccessTokens(env)) {
    try {
      const { ok, payload } = await plaidPost(env, '/item/get', { access_token: accessToken });
      if (ok && String(payload.item?.institution_id || '') === 'ins_54') {
        return { accessToken, item: payload.item || {} };
      }
    } catch { /* try the next linked Item */ }
  }
  throw new Error('The linked Robinhood account was not found.');
}

function stockStickiesAccountId(account) {
  const label = `${account?.name || ''} ${account?.official_name || ''} ${account?.subtype || ''}`.toLowerCase();
  if (/\broth\b/.test(label)) return 'roth';
  if (/\btraditional\b/.test(label) || (/\bira\b/.test(label) && !/\broth\b/.test(label))) return 'traditional';
  // Robinhood reports crypto in a separate investment account. It is still part
  // of the owner's taxable portfolio, so Stock Stickies groups it with Individual.
  if (/\bcrypto(?:currency)?\b/.test(label)) return 'individual';
  if (account?.subtype === 'brokerage' || /\bindividual\b|\bbrokerage\b/.test(label)) return 'individual';
  return '';
}

function easternDateKey(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function stockStickiesPerformanceYear(date = new Date()) {
  return Number(easternDateKey(date).slice(0, 4));
}

async function recordStockStickiesPerformanceSnapshot(env, snapshot) {
  const date = easternDateKey();
  const year = date.slice(0, 4);
  const key = `${STOCK_STICKIES_PERFORMANCE_SNAPSHOT_PREFIX}${year}`;
  const stored = await env.RENTALS.get(key, 'json');
  const snapshots = stored?.snapshots && typeof stored.snapshots === 'object'
    ? stored.snapshots
    : {};
  const accounts = stockStickiesAccountValues(snapshot);
  snapshots[date] = {
    date,
    fetchedAt: String(snapshot?.fetchedAt || new Date().toISOString()),
    accounts,
    total: STOCK_STICKIES_ACCOUNT_IDS.reduce((sum, id) => sum + accounts[id], 0),
  };
  const ordered = Object.fromEntries(
    Object.entries(snapshots)
      .filter(([snapshotDate]) => snapshotDate.startsWith(`${year}-`))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-370)
  );
  await env.RENTALS.put(key, JSON.stringify({
    year: Number(year),
    updatedAt: new Date().toISOString(),
    snapshots: ordered,
  }));
  return ordered[date];
}

function normalizeStockStickiesInvestmentTransactions(payload) {
  const accountMap = new Map(
    (Array.isArray(payload?.accounts) ? payload.accounts : [])
      .map(account => [String(account?.account_id || ''), stockStickiesAccountId(account)])
  );
  const securityMap = new Map(
    (Array.isArray(payload?.securities) ? payload.securities : [])
      .map(security => [String(security?.security_id || ''), security])
  );
  return (Array.isArray(payload?.investment_transactions) ? payload.investment_transactions : [])
    .map(transaction => {
      const stockStickiesAccount = accountMap.get(String(transaction?.account_id || ''));
      if (!STOCK_STICKIES_ACCOUNT_IDS.includes(stockStickiesAccount)) return null;
      const amount = Number(transaction?.amount);
      if (!Number.isFinite(amount)) return null;
      const securityId = transaction?.security_id == null
        ? null
        : String(transaction.security_id).slice(0, 160);
      const security = securityMap.get(String(securityId || '')) || {};
      const optionContract = security?.option_contract && typeof security.option_contract === 'object'
        ? {
            contractType: String(security.option_contract.contract_type || '').toLowerCase().slice(0, 20),
            expirationDate: security.option_contract.expiration_date
              ? String(security.option_contract.expiration_date).slice(0, 10)
              : null,
            strikePrice: Number.isFinite(Number(security.option_contract.strike_price))
              ? Number(security.option_contract.strike_price)
              : null,
            underlyingSecurityTicker: String(
              security.option_contract.underlying_security_ticker || ''
            ).toUpperCase().slice(0, 32),
          }
        : null;
      return {
        id: String(transaction?.investment_transaction_id || '').slice(0, 160),
        accountId: String(transaction?.account_id || '').slice(0, 160),
        stockStickiesAccount,
        securityId,
        date: String(transaction?.date || '').slice(0, 10),
        transactionDatetime: transaction?.transaction_datetime
          ? String(transaction.transaction_datetime).slice(0, 40)
          : null,
        name: String(transaction?.name || '').slice(0, 240),
        amount,
        fees: Number.isFinite(Number(transaction?.fees)) ? Number(transaction.fees) : null,
        quantity: Number.isFinite(Number(transaction?.quantity)) ? Number(transaction.quantity) : null,
        price: Number.isFinite(Number(transaction?.price)) ? Number(transaction.price) : null,
        type: String(transaction?.type || '').toLowerCase().slice(0, 40),
        subtype: String(transaction?.subtype || '').toLowerCase().slice(0, 80),
        ticker: String(security?.ticker_symbol || '').trim().toUpperCase().slice(0, 32),
        securityType: String(security?.type || '').toLowerCase().slice(0, 80),
        securitySubtype: String(security?.subtype || '').toLowerCase().slice(0, 80),
        optionContract,
        isoCurrencyCode: String(
          transaction?.iso_currency_code || security?.iso_currency_code || ''
        ).slice(0, 8),
        unofficialCurrencyCode: String(
          transaction?.unofficial_currency_code || security?.unofficial_currency_code || ''
        ).slice(0, 32),
        cancelTransactionId: transaction?.cancel_transaction_id == null
          ? null
          : String(transaction.cancel_transaction_id).slice(0, 160),
      };
    })
    .filter(Boolean);
}

async function refreshStockStickiesInvestmentTransactions(env, year) {
  const { accessToken } = await findRobinhoodPlaidItem(env);
  // Include the prior year so a put opened in December and closed/assigned in
  // the requested year retains its opening premium and lot history.
  const startDate = `${year - 1}-01-01`;
  const endDate = easternDateKey();
  const transactionsById = new Map();
  const currentKey = `${STOCK_STICKIES_PERFORMANCE_TRANSACTION_PREFIX}${year}`;
  const [currentArchive, priorYearArchive] = await Promise.all([
    env.RENTALS.get(currentKey, 'json'),
    env.RENTALS.get(`${STOCK_STICKIES_PERFORMANCE_TRANSACTION_PREFIX}${year - 1}`, 'json'),
  ]);
  // Plaid transaction history is bounded. Preserve only older put lifecycle
  // records; current-year external flows and trades always come from the fresh
  // extraction so stale records cannot alter account performance.
  for (const archive of [priorYearArchive, currentArchive]) {
    for (const transaction of Array.isArray(archive?.transactions) ? archive.transactions : []) {
      const contractType = String(transaction?.optionContract?.contractType || '').toLowerCase();
      const isPutLifecycle = contractType === 'put' || /\bput\b/i.test(String(transaction?.name || ''));
      if (!isPutLifecycle) continue;
      const key = transaction.id ||
        `${transaction.accountId}:${transaction.date}:${transaction.type}:${transaction.amount}:archive`;
      transactionsById.set(key, transaction);
    }
  }
  let plaidHistoryTruncated = false;
  // Robinhood can generate thousands of cash-sweep investment transactions.
  // Query bounded windows so Plaid's result set does not crowd older option
  // lifecycle events out of an otherwise valid multi-year request.
  let windowStartMs = Date.parse(`${startDate}T12:00:00Z`);
  const endMs = Date.parse(`${endDate}T12:00:00Z`);
  while (windowStartMs <= endMs) {
    const windowEndMs = Math.min(endMs, windowStartMs + (179 * 86_400_000));
    const windowStart = new Date(windowStartMs).toISOString().slice(0, 10);
    const windowEnd = new Date(windowEndMs).toISOString().slice(0, 10);
    let offset = 0;
    let windowTotal = 0;
    do {
      const { ok, status, payload } = await plaidPost(env, '/investments/transactions/get', {
        access_token: accessToken,
        start_date: windowStart,
        end_date: windowEnd,
        options: { count: 250, offset },
      });
      if (!ok) {
        const code = String(payload.error_code || payload.error_type || 'UNKNOWN_ERROR').slice(0, 80);
        const error = new Error('Robinhood investment activity could not be loaded.');
        error.code = code;
        error.status = status;
        throw error;
      }
      const page = normalizeStockStickiesInvestmentTransactions(payload);
      for (const transaction of page) {
        const key = transaction.id ||
          `${transaction.accountId}:${transaction.date}:${transaction.type}:${transaction.amount}:${offset}`;
        transactionsById.set(key, transaction);
      }
      windowTotal = Number(payload.total_investment_transactions) || 0;
      offset += 250;
    } while (offset < windowTotal && offset < 10_000);
    plaidHistoryTruncated ||= windowTotal > 10_000;
    windowStartMs = windowEndMs + 86_400_000;
  }

  const allTransactions = [...transactionsById.values()];
  const canceledTransactionIds = new Set(
    allTransactions
      .filter(transaction => transaction.type === 'cancel' && transaction.cancelTransactionId)
      .map(transaction => transaction.cancelTransactionId)
  );
  const retainedHistoryDates = allTransactions
    .map(transaction => String(transaction?.date || ''))
    .filter(Boolean)
    .sort();
  const data = {
    schemaVersion: 3,
    year,
    historyStartDate: retainedHistoryDates[0] || startDate,
    fetchedAt: new Date().toISOString(),
    transactions: allTransactions
      .filter(transaction =>
        transaction.type !== 'cancel' &&
        !canceledTransactionIds.has(transaction.id)
      )
      .sort((left, right) => right.date.localeCompare(left.date))
      .slice(0, 10_000),
    truncated: plaidHistoryTruncated || allTransactions.length > 10_000,
  };
  await env.RENTALS.put(
    currentKey,
    JSON.stringify(data)
  );
  return data;
}

async function getStockStickiesInvestmentTransactions(env, year, force = false) {
  const key = `${STOCK_STICKIES_PERFORMANCE_TRANSACTION_PREFIX}${year}`;
  const cached = await env.RENTALS.get(key, 'json');
  const fetchedDate = cached?.fetchedAt ? easternDateKey(new Date(cached.fetchedAt)) : '';
  if (
    !force &&
    Number(cached?.schemaVersion) >= 3 &&
    fetchedDate === easternDateKey()
  ) return { data: cached, warning: '' };
  try {
    return { data: await refreshStockStickiesInvestmentTransactions(env, year), warning: '' };
  } catch (error) {
    console.error(JSON.stringify({
      event: 'stock_stickies_investment_transactions_refresh_error',
      year,
      status: Number(error?.status) || 0,
      code: String(error?.code || 'UNKNOWN_ERROR').slice(0, 80),
      message: error instanceof Error ? error.message : String(error),
      usingCachedTransactions: Boolean(cached),
    }));
    if (cached) {
      return {
        data: cached,
        warning: 'Investment activity could not be refreshed; the last successful transaction snapshot is being used.',
      };
    }
    return {
      data: null,
      warning: error instanceof Error ? error.message : 'Investment activity is unavailable.',
    };
  }
}

function normalizeConfiguredStockStickiesExternalFlows(config, year) {
  const configured = config?.manualExternalFlows?.[String(year)];
  if (!Array.isArray(configured)) return [];
  return configured
    .map((transaction, index) => {
      const stockStickiesAccount = String(transaction?.account || '');
      const subtype = String(transaction?.subtype || '').toLowerCase();
      const date = String(transaction?.date || '').slice(0, 10);
      const externalFlow = Number(transaction?.flow);
      if (
        !STOCK_STICKIES_ACCOUNT_IDS.includes(stockStickiesAccount) ||
        !isRecognizedExternalFlow({ subtype }) ||
        !date.startsWith(`${year}-`) ||
        !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) ||
        !Number.isFinite(externalFlow)
      ) return null;
      return {
        id: String(transaction?.id || `manual:${year}:${stockStickiesAccount}:${date}:${index}`).slice(0, 160),
        accountId: `manual:${stockStickiesAccount}`,
        stockStickiesAccount,
        securityId: null,
        date,
        transactionDatetime: null,
        name: String(transaction?.source || 'Manual reconciliation').slice(0, 240),
        // Keep the normalized records compatible with Plaid's investor-opposite sign convention.
        amount: -externalFlow,
        fees: null,
        type: 'transfer',
        subtype,
        cancelTransactionId: null,
        source: 'manual-reconciliation',
      };
    })
    .filter(Boolean);
}

function configuredStockStickiesPerformanceAnchor(config, year, account) {
  const configured = config?.performanceReconciliations?.[String(year)]?.[account];
  if (!configured || typeof configured !== 'object') return null;
  const reportedGain = Number(configured.reportedGain);
  const reportedRealizedGain = Number(configured.reportedRealizedGain);
  const anchorValue = Number(configured.anchorValue);
  const asOf = String(configured.asOf || '').slice(0, 10);
  if (
    !Number.isFinite(reportedGain) ||
    !Number.isFinite(anchorValue) ||
    !Number.isFinite(Date.parse(`${asOf}T12:00:00Z`))
  ) return null;
  return {
    reportedGain,
    reportedRealizedGain: Number.isFinite(reportedRealizedGain)
      ? reportedRealizedGain
      : null,
    anchorValue,
    asOf,
    source: String(configured.source || 'institution-reported').slice(0, 120),
  };
}

async function buildStockStickiesPerformance(env, year, snapshot, options = {}) {
  const config = await env.RENTALS.get(STOCK_STICKIES_PERFORMANCE_CONFIG_KEY, 'json');
  const snapshotStore = await env.RENTALS.get(
    `${STOCK_STICKIES_PERFORMANCE_SNAPSHOT_PREFIX}${year}`,
    'json'
  );
  const snapshots = snapshotStore?.snapshots && typeof snapshotStore.snapshots === 'object'
    ? snapshotStore.snapshots
    : {};
  const dates = Object.keys(snapshots).sort();
  const endDate = easternDateKey();
  const latestSnapshot = dates.length ? snapshots[dates[dates.length - 1]] : null;
  const currentValues = snapshot
    ? stockStickiesAccountValues(snapshot)
    : (latestSnapshot?.accounts || Object.fromEntries(
      STOCK_STICKIES_ACCOUNT_IDS.map(id => [id, 0])
    ));
  const transactionResult = await getStockStickiesInvestmentTransactions(
    env,
    year,
    options.forceTransactions === true
  );
  const allTransactions = Array.isArray(transactionResult.data?.transactions)
    ? transactionResult.data.transactions
    : [];
  const ytdTransactions = allTransactions.filter(transaction =>
    String(transaction?.date || '').startsWith(`${year}-`)
  );
  const cashFlowCoverageThrough = config?.cashFlowCoverageThrough?.[String(year)] || {};
  const manualExternalFlows = normalizeConfiguredStockStickiesExternalFlows(config, year);
  const performanceTransactions = mergeStockStickiesTransactions(
    ytdTransactions,
    manualExternalFlows,
    cashFlowCoverageThrough
  );
  const previousSnapshot = options.previousSnapshot ||
    await env.RENTALS.get(STOCK_STICKIES_HOLDINGS_PREVIOUS_CACHE_KEY, 'json');
  const refreshConsistency = snapshot
    ? assessStockStickiesRefreshConsistency(previousSnapshot, snapshot, performanceTransactions)
    : { status: 'not-comparable', provisionalAccounts: [], discrepancies: [] };
  const cspLedger = buildStockStickiesCspLedger(
    allTransactions,
    snapshot?.positions,
    year,
    endDate,
    {
      excludedTransactionIds:
        config?.excludedCspTransactionIds?.[String(year)] || [],
      reviewedResolvedContracts:
        config?.cspLedgerReconciliations?.[String(year)]?.reviewedResolvedContracts || [],
      closedWithoutPnlContracts:
        config?.cspLedgerReconciliations?.[String(year)]?.closedWithoutPnlContracts || [],
      accountReconciliations:
        config?.cspLedgerReconciliations?.[String(year)]?.accounts || {},
    }
  );
  const openingValues = config?.openingValues?.[String(year)] || {};
  const cashFlowCoverage = config?.cashFlowCoverage?.[String(year)] || {};
  const accounts = {};
  for (const id of STOCK_STICKIES_ACCOUNT_IDS) {
    const rawOpening = openingValues[id];
    const openingValue = rawOpening === null || rawOpening === undefined || rawOpening === ''
      ? null
      : Number(rawOpening);
    const transactions = performanceTransactions.filter(
      transaction => transaction.stockStickiesAccount === id
    );
    const coverageSource = String(cashFlowCoverage[id] || 'plaid');
    const hasCompleteCashFlowHistory = coverageSource !== 'incomplete';
    const calculation = transactionResult.data && Number.isFinite(openingValue) && hasCompleteCashFlowHistory
      ? modifiedDietzPerformance(openingValue, Number(currentValues[id] || 0), transactions, year, endDate)
      : null;
    const performanceAnchor = configuredStockStickiesPerformanceAnchor(config, year, id);
    const anchoredCalculation = performanceAnchor && hasCompleteCashFlowHistory
      ? anchoredInstitutionPerformance(
          performanceAnchor.reportedGain,
          performanceAnchor.anchorValue,
          Number(currentValues[id] || 0),
          transactions,
          performanceAnchor.asOf,
          endDate
        )
      : null;
    const gain = anchoredCalculation?.gain ?? calculation?.gain ?? null;
    accounts[id] = {
      openingValue: Number.isFinite(openingValue) ? openingValue : null,
      currentValue: Number(currentValues[id] || 0),
      gain,
      returnPercent: anchoredCalculation && Number.isFinite(calculation?.weightedCapital)
        ? (gain / calculation.weightedCapital) * 100
        : calculation?.returnPercent ?? null,
      weightedCapital: calculation?.weightedCapital ?? null,
      netExternalFlow: calculation?.netExternalFlow ?? null,
      externalFlowCount: calculation?.externalFlowCount ?? 0,
      transactionCount: transactions.length,
      csp: cspLedger.accounts[id],
      cashFlowCoverage: coverageSource,
      cashFlowCoverageThrough: cashFlowCoverageThrough[id] || null,
      methodology: anchoredCalculation ? 'institution-reported-anchor' : 'modified-dietz',
      reconciliationAsOf: anchoredCalculation ? performanceAnchor.asOf : null,
      reconciliationSource: anchoredCalculation ? performanceAnchor.source : null,
      reportedRealizedGain: anchoredCalculation ? performanceAnchor.reportedRealizedGain : null,
      reportedRealizedGainAsOf: anchoredCalculation &&
        Number.isFinite(performanceAnchor.reportedRealizedGain)
        ? performanceAnchor.asOf
        : null,
      impliedUnrealizedAndOtherGain: anchoredCalculation &&
        endDate === performanceAnchor.asOf &&
        Number.isFinite(performanceAnchor.reportedRealizedGain)
        ? gain - performanceAnchor.reportedRealizedGain
        : null,
      valueChangeAfterReconciliation: anchoredCalculation?.valueChangeAfterAnchor ?? null,
      netExternalFlowAfterReconciliation:
        anchoredCalculation?.netExternalFlowAfterAnchor ?? null,
      status: !Number.isFinite(openingValue)
        ? 'needs-opening-value'
        : (!transactionResult.data
            ? 'transactions-unavailable'
            : (!hasCompleteCashFlowHistory
                ? 'cash-flow-history-incomplete'
                : (refreshConsistency.provisionalAccounts.includes(id)
                    ? 'provisional-external-flow'
                    : 'ready'))),
    };
  }
  const totalOpening = STOCK_STICKIES_ACCOUNT_IDS.reduce(
    (sum, id) => sum + (Number(accounts[id].openingValue) || 0),
    0
  );
  const allOpeningValuesPresent = STOCK_STICKIES_ACCOUNT_IDS.every(
    id => Number.isFinite(accounts[id].openingValue)
  );
  const totalCurrent = STOCK_STICKIES_ACCOUNT_IDS.reduce(
    (sum, id) => sum + accounts[id].currentValue,
    0
  );
  const incompleteCashFlowAccounts = STOCK_STICKIES_ACCOUNT_IDS.filter(
    id => accounts[id].status === 'cash-flow-history-incomplete'
  );
  const totalCalculation = allOpeningValuesPresent && transactionResult.data && !incompleteCashFlowAccounts.length
    ? modifiedDietzPerformance(totalOpening, totalCurrent, performanceTransactions, year, endDate)
    : null;
  const allAccountGainsPresent = STOCK_STICKIES_ACCOUNT_IDS.every(
    id => Number.isFinite(accounts[id].gain)
  );
  const hasInstitutionReportedAccount = STOCK_STICKIES_ACCOUNT_IDS.some(
    id => accounts[id].methodology === 'institution-reported-anchor'
  );
  const reconciledTotalGain = allAccountGainsPresent
    ? STOCK_STICKIES_ACCOUNT_IDS.reduce((sum, id) => sum + accounts[id].gain, 0)
    : null;
  const totalWeightedCapital = STOCK_STICKIES_ACCOUNT_IDS.every(
    id => Number.isFinite(accounts[id].weightedCapital) && accounts[id].weightedCapital > 0
  )
    ? STOCK_STICKIES_ACCOUNT_IDS.reduce(
        (sum, id) => sum + accounts[id].weightedCapital,
        0
      )
    : null;
  const reconciledTotalReturnPercent = aggregateModifiedDietzReturn(
    STOCK_STICKIES_ACCOUNT_IDS.map(id => accounts[id])
  );
  const warnings = [transactionResult.warning].filter(Boolean);
  if (incompleteCashFlowAccounts.length) {
    warnings.push(
      `YTD performance is hidden for ${incompleteCashFlowAccounts.join(', ')} because Plaid did not provide ` +
      'the account’s 2026 deposits and withdrawals. A balance change alone is not investment performance.'
    );
  }
  const manualCoverageAccounts = STOCK_STICKIES_ACCOUNT_IDS.filter(
    id => String(accounts[id].cashFlowCoverage).startsWith('manual')
  );
  if (manualCoverageAccounts.length) {
    warnings.push(
      `External cash flows for ${manualCoverageAccounts.join(', ')} were reconciled from ` +
      `institution exports${manualCoverageAccounts.map(id => accounts[id].cashFlowCoverageThrough)
        .filter(Boolean).length ? ` through ${manualCoverageAccounts.map(id =>
          accounts[id].cashFlowCoverageThrough
        ).filter(Boolean).sort().slice(-1)[0]}` : ''}.`
    );
  }
  const unclassifiedTransferCount = allTransactions.filter(transaction =>
    transaction.type === 'transfer' &&
    !isRecognizedExternalFlow(transaction)
  ).length;
  if (unclassifiedTransferCount) {
    warnings.push(
      `${unclassifiedTransferCount} transfer transaction${unclassifiedTransferCount === 1 ? '' : 's'} ` +
      'were excluded from external cash flows because Plaid did not identify them as contributions, deposits, distributions, or withdrawals.'
    );
  }
  if (transactionResult.data?.truncated) {
    warnings.push('The investment activity history exceeded the 10,000-transaction safety limit.');
  }
  if (cspLedger.unmatchedTransactionCount) {
    warnings.push(
      `${cspLedger.unmatchedTransactionCount} put-option transaction` +
      `${cspLedger.unmatchedTransactionCount === 1 ? '' : 's'} could not be matched to a ` +
      'short-put lifecycle and were excluded from CSP P&L.'
    );
  }
  if (cspLedger.pendingResolutionCount) {
    const pendingContracts = cspLedger.contracts
      .filter(contract => contract.status === 'pending-resolution')
      .map(contract => `${contract.underlyingTicker || contract.ticker || 'unknown'} ${contract.strikePrice || ''}`.trim())
      .join(', ');
    warnings.push(
      `${cspLedger.pendingResolutionCount} short-put lifecycle${cspLedger.pendingResolutionCount === 1 ? '' : 's'} ` +
      `(${pendingContracts}) disappeared from current holdings before Plaid supplied a closing, expiration, or assignment transaction. ` +
      'They are excluded from open-contract, collateral, and unrealized CSP P&L totals until resolved.'
    );
  }
  if (cspLedger.closedPnlUnavailableCount) {
    const confirmedClosedContracts = cspLedger.contracts
      .filter(contract => contract.status === 'closed-pnl-unavailable')
      .map(contract => `${contract.underlyingTicker || contract.ticker || 'unknown'} ${contract.strikePrice || ''}`.trim())
      .join(', ');
    warnings.push(
      `${cspLedger.closedPnlUnavailableCount} short-put lifecycle` +
      `${cspLedger.closedPnlUnavailableCount === 1 ? '' : 's'} (${confirmedClosedContracts}) ` +
      'were confirmed closed, but Plaid has not supplied their closing costs. They have zero open-contract ' +
      'and collateral exposure; affected CSP realized and total P&L remain incomplete.'
    );
  }
  if (cspLedger.appliedReconciliations.length) {
    warnings.push(
      `Historical CSP totals include ${cspLedger.appliedReconciliations.length} reviewed ledger ` +
      `reconciliation${cspLedger.appliedReconciliations.length === 1 ? '' : 's'} for option events ` +
      'that are no longer available from Plaid.'
    );
  }
  if (refreshConsistency.status === 'provisional') {
    warnings.push(
      `YTD performance is temporarily hidden for ${refreshConsistency.provisionalAccounts.join(', ')} because ` +
      'brokerage cash and account value changed without a matching deposit or withdrawal transaction. ' +
      'Plaid may still be publishing the investment activity.'
    );
  }
  return {
    year,
    asOf: endDate,
    methodology: hasInstitutionReportedAccount
      ? 'account-sum-with-institution-anchor'
      : 'modified-dietz',
    reconciled: allOpeningValuesPresent,
    accounts,
    total: {
      openingValue: allOpeningValuesPresent ? totalOpening : null,
      currentValue: totalCurrent,
      gain: reconciledTotalGain ?? totalCalculation?.gain ?? null,
      returnPercent: reconciledTotalReturnPercent ?? totalCalculation?.returnPercent ?? null,
      weightedCapital: totalWeightedCapital,
      netExternalFlow: totalCalculation?.netExternalFlow ?? null,
      externalFlowCount: totalCalculation?.externalFlowCount ?? 0,
      transactionCount: performanceTransactions.length,
      status: !allOpeningValuesPresent
        ? 'needs-opening-value'
        : (!transactionResult.data
            ? 'transactions-unavailable'
            : (incompleteCashFlowAccounts.length
                ? 'cash-flow-history-incomplete'
                : (refreshConsistency.provisionalAccounts.length
                    ? 'provisional-external-flow'
                    : 'ready'))),
    },
    snapshotCount: dates.length,
    firstSnapshotDate: dates[0] || null,
    lastSnapshotDate: dates.length ? dates[dates.length - 1] : null,
    transactionsAsOf: transactionResult.data?.fetchedAt || null,
    transactionHistoryStartDate: transactionResult.data?.historyStartDate || `${year}-01-01`,
    returnMethodology: 'modified-dietz',
    refreshConsistency,
    cspLedger,
    warnings,
  };
}

async function handleStockStickiesPlaidStatus(env, corsHeaders) {
  try {
    const { item } = await findRobinhoodPlaidItem(env);
    const products = Array.isArray(item.products) ? item.products : [];
    const billedProducts = Array.isArray(item.billed_products) ? item.billed_products : [];
    const availableProducts = Array.isArray(item.available_products) ? item.available_products : [];
    return jsonResponse({
      ok: true,
      connected: true,
      investmentsEnabled: products.includes('investments') || billedProducts.includes('investments'),
      investmentsAvailable: availableProducts.includes('investments'),
      itemId: String(item.item_id || ''),
      institution: 'Robinhood',
      updateType: String(item.update_type || ''),
      itemError: item.error ? {
        code: String(item.error.error_code || item.error.error_type || 'UNKNOWN_ERROR').slice(0, 80),
        message: String(item.error.display_message || item.error.error_message || '').slice(0, 240),
      } : null,
    }, 200, corsHeaders);
  } catch (error) {
    return jsonResponse({
      ok: false,
      connected: false,
      error: error instanceof Error ? error.message : 'Unable to inspect the Robinhood connection.',
    }, 502, corsHeaders);
  }
}

async function handleStockStickiesPlaidLinkToken(env, corsHeaders) {
  try {
    const { accessToken } = await findRobinhoodPlaidItem(env);
    const body = {
      client_name: "Red's STUFF",
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: 'rentals-owner' },
      access_token: accessToken,
      additional_consented_products: ['investments'],
    };
    if (env.PLAID_REDIRECT_URI) body.redirect_uri = env.PLAID_REDIRECT_URI;
    const { ok, status, payload } = await plaidPost(env, '/link/token/create', body);
    if (!ok) {
      const code = String(payload.error_code || payload.error_type || 'UNKNOWN_ERROR').slice(0, 80);
      console.error(JSON.stringify({ event: 'stock_stickies_plaid_link_token_error', status, code }));
      return jsonResponse({ ok: false, error: 'Robinhood consent could not be started.', code }, 502, corsHeaders);
    }
    return jsonResponse({
      ok: true,
      linkToken: String(payload.link_token || ''),
      expiration: String(payload.expiration || ''),
    }, 200, corsHeaders);
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to start Robinhood consent.',
    }, 502, corsHeaders);
  }
}

function normalizeStockStickiesHoldings(payload, fetchedAt = new Date().toISOString()) {
  const accounts = (Array.isArray(payload.accounts) ? payload.accounts : [])
    .filter(account => account?.type === 'investment')
    .map(account => ({
      accountId: String(account.account_id || ''),
      name: String(account.name || '').slice(0, 120),
      officialName: String(account.official_name || '').slice(0, 160),
      subtype: String(account.subtype || '').slice(0, 80),
      stockStickiesAccount: stockStickiesAccountId(account),
      currentBalance: account?.balances?.current !== null
        && account?.balances?.current !== undefined
        && account?.balances?.current !== ''
        && Number.isFinite(Number(account.balances.current))
        ? Number(account.balances.current)
        : null,
      availableBalance: account?.balances?.available !== null
        && account?.balances?.available !== undefined
        && account?.balances?.available !== ''
        && Number.isFinite(Number(account.balances.available))
        ? Number(account.balances.available)
        : null,
      isoCurrencyCode: String(account?.balances?.iso_currency_code || '').slice(0, 8),
    }));
  const accountMap = new Map(accounts.map(account => [account.accountId, account]));
  const securityMap = new Map(
    (Array.isArray(payload.securities) ? payload.securities : [])
      .map(security => [String(security.security_id || ''), security])
  );
  const positions = (Array.isArray(payload.holdings) ? payload.holdings : [])
    .slice(0, 500)
    .map(holding => {
      const securityId = String(holding.security_id || '');
      const security = securityMap.get(securityId) || {};
      const account = accountMap.get(String(holding.account_id || ''));
      const isCrypto =
        String(account?.subtype || '').toLowerCase().includes('crypto') ||
        String(security.type || '').toLowerCase().includes('crypto') ||
        String(security.subtype || '').toLowerCase().includes('crypto') ||
        Boolean(holding.unofficial_currency_code || security.unofficial_currency_code);
      const hasInstitutionPrice =
        holding.institution_price !== null &&
        holding.institution_price !== undefined &&
        holding.institution_price !== '' &&
        Number.isFinite(Number(holding.institution_price));
      const hasClosePrice =
        security.close_price !== null &&
        security.close_price !== undefined &&
        security.close_price !== '' &&
        Number.isFinite(Number(security.close_price));
      const institutionPrice = hasInstitutionPrice
        ? Number(holding.institution_price)
        : (hasClosePrice ? Number(security.close_price) : null);
      const hasCostBasis =
        holding.cost_basis !== null &&
        holding.cost_basis !== undefined &&
        holding.cost_basis !== '' &&
        Number.isFinite(Number(holding.cost_basis));
      const rawTaxLots = Array.isArray(holding.tax_lots) ? holding.tax_lots : [];
      const taxLots = rawTaxLots
        .slice(0, 100)
        .map(lot => {
          const nullableNumber = value =>
            value !== null &&
            value !== undefined &&
            value !== '' &&
            Number.isFinite(Number(value))
              ? Number(value)
              : null;
          const positionType = String(lot?.position_type || '').toUpperCase();
          return {
            institutionLotId: lot?.institution_lot_id == null
              ? null
              : String(lot.institution_lot_id).slice(0, 160),
            acquiredAt: lot?.original_purchase_datetime
              ? String(lot.original_purchase_datetime).slice(0, 40)
              : null,
            quantity: nullableNumber(lot?.quantity),
            purchasePrice: nullableNumber(lot?.purchase_price),
            costBasis: nullableNumber(lot?.cost_basis),
            currentValue: nullableNumber(lot?.current_value),
            positionType: positionType === 'LONG' || positionType === 'SHORT'
              ? positionType
              : null,
          };
        });
      return {
        accountId: String(holding.account_id || ''),
        accountName: account?.officialName || account?.name || '',
        accountSubtype: account?.subtype || '',
        stockStickiesAccount: account?.stockStickiesAccount || '',
        securityId,
        ticker: String(security.ticker_symbol || '').trim().toUpperCase().slice(0, 32),
        name: String(security.name || '').slice(0, 200),
        type: String(security.type || '').slice(0, 80),
        subtype: String(security.subtype || '').slice(0, 80),
        quantity: Number.isFinite(Number(holding.quantity)) ? Number(holding.quantity) : null,
        institutionPrice,
        institutionValue: Number.isFinite(Number(holding.institution_value)) ? Number(holding.institution_value) : null,
        costBasis: hasCostBasis ? Number(holding.cost_basis) : null,
        taxLotCount: rawTaxLots.length,
        taxLotsTruncated: rawTaxLots.length > taxLots.length,
        taxLots,
        priceAsOf:
          holding.institution_price_datetime ||
          holding.institution_price_as_of ||
          security.update_datetime ||
          security.close_price_as_of ||
          null,
        isCashEquivalent: security.is_cash_equivalent === true,
        optionContract: security.option_contract || null,
        isCrypto,
        unofficialCurrencyCode: String(
          holding.unofficial_currency_code || security.unofficial_currency_code || ''
        ).slice(0, 32),
      };
    })
    .filter(position => position.quantity !== null && position.quantity !== 0);

  return {
    ok: true,
    institution: 'Robinhood',
    fetchedAt,
    accounts,
    positions,
    cryptoPositionCount: positions.filter(position => position.isCrypto).length,
  };
}

async function refreshStockStickiesHoldingsSnapshot(env) {
  const { accessToken } = await findRobinhoodPlaidItem(env);
  const { ok, status, payload } = await plaidPost(env, '/investments/holdings/get', {
    access_token: accessToken,
  });
  if (!ok) {
    const code = String(payload.error_code || payload.error_type || 'UNKNOWN_ERROR').slice(0, 80);
    const error = new Error(
      code === 'ADDITIONAL_CONSENT_REQUIRED' || code === 'PRODUCT_NOT_ENABLED'
        ? 'Robinhood needs permission to share investment positions.'
        : 'Robinhood positions could not be loaded.'
    );
    error.code = code;
    error.status = status;
    error.needsConsent = code === 'ADDITIONAL_CONSENT_REQUIRED' || code === 'PRODUCT_NOT_ENABLED';
    throw error;
  }
  const snapshot = normalizeStockStickiesHoldings(payload);
  const previousSnapshot = await env.RENTALS.get(STOCK_STICKIES_HOLDINGS_CACHE_KEY, 'json');
  if (previousSnapshot?.fetchedAt && previousSnapshot.fetchedAt !== snapshot.fetchedAt) {
    await env.RENTALS.put(
      STOCK_STICKIES_HOLDINGS_PREVIOUS_CACHE_KEY,
      JSON.stringify(previousSnapshot)
    );
  }
  await env.RENTALS.put(STOCK_STICKIES_HOLDINGS_CACHE_KEY, JSON.stringify(snapshot));
  await recordStockStickiesPerformanceSnapshot(env, snapshot);
  return snapshot;
}

function stockStickiesPositionQuantityFingerprint(snapshot) {
  return JSON.stringify(
    (Array.isArray(snapshot?.positions) ? snapshot.positions : [])
      .map(position => ({
        accountId: String(position.accountId || ''),
        securityId: String(position.securityId || ''),
        ticker: String(position.ticker || ''),
        quantity: Number.isFinite(Number(position.quantity)) ? Number(position.quantity) : null,
      }))
      .sort((a, b) =>
        `${a.accountId}:${a.securityId}:${a.ticker}`.localeCompare(
          `${b.accountId}:${b.securityId}:${b.ticker}`
        ))
  );
}

function stockStickiesLatestInstitutionTimestamp(snapshot) {
  const timestamps = (Array.isArray(snapshot?.positions) ? snapshot.positions : [])
    .map(position => Date.parse(String(position.priceAsOf || '')))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

async function handleStockStickiesPlaidRefresh(env, corsHeaders) {
  const startedAt = new Date();
  const previousRefresh = await env.RENTALS.get(STOCK_STICKIES_INVESTMENTS_REFRESH_KEY, 'json');
  const previousStartedMs = Date.parse(String(previousRefresh?.startedAt || ''));
  const previousCompletedMs = Date.parse(String(previousRefresh?.completedAt || ''));
  const inFlightAgeMs = Number.isFinite(previousStartedMs)
    ? startedAt.getTime() - previousStartedMs
    : Infinity;
  const completedAgeMs = Number.isFinite(previousCompletedMs)
    ? startedAt.getTime() - previousCompletedMs
    : Infinity;

  if (previousRefresh?.status === 'refreshing' && inFlightAgeMs >= 0 &&
      inFlightAgeMs < STOCK_STICKIES_INVESTMENTS_REFRESH_IN_FLIGHT_MS) {
    return jsonResponse({
      ok: false,
      code: 'REFRESH_IN_PROGRESS',
      error: 'A Robinhood position refresh is already in progress. Try again shortly.',
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((STOCK_STICKIES_INVESTMENTS_REFRESH_IN_FLIGHT_MS - inFlightAgeMs) / 1000)
      ),
    }, 409, corsHeaders);
  }

  if (previousRefresh?.status === 'completed' && completedAgeMs >= 0 &&
      completedAgeMs < STOCK_STICKIES_INVESTMENTS_REFRESH_COOLDOWN_MS) {
    return jsonResponse({
      ok: false,
      code: 'REFRESH_COOLDOWN',
      error: 'Robinhood was refreshed less than five minutes ago. Please wait before requesting another paid refresh.',
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((STOCK_STICKIES_INVESTMENTS_REFRESH_COOLDOWN_MS - completedAgeMs) / 1000)
      ),
    }, 429, corsHeaders);
  }

  const previousSnapshot = await env.RENTALS.get(STOCK_STICKIES_HOLDINGS_CACHE_KEY, 'json');
  await env.RENTALS.put(STOCK_STICKIES_INVESTMENTS_REFRESH_KEY, JSON.stringify({
    status: 'refreshing',
    startedAt: startedAt.toISOString(),
  }), { expirationTtl: 24 * 60 * 60 });

  try {
    const { accessToken, item } = await findRobinhoodPlaidItem(env);
    const { ok, status, payload } = await plaidPost(env, '/investments/refresh', {
      access_token: accessToken,
    });
    if (!ok) {
      const code = String(payload.error_code || payload.error_type || 'UNKNOWN_ERROR').slice(0, 80);
      const requestId = String(payload.request_id || '').slice(0, 120);
      const error = new Error(
        code === 'PRODUCT_NOT_SUPPORTED'
          ? 'Robinhood does not support Plaid’s on-demand Investments Refresh for this connection.'
          : code === 'PRODUCT_NOT_ENABLED'
            ? 'Plaid Investments Refresh is not enabled for this production connection.'
            : code === 'ITEM_LOGIN_REQUIRED'
              ? 'Robinhood must be reconnected before positions can be refreshed.'
              : 'Plaid could not complete a fresh Robinhood position extraction.'
      );
      error.code = code;
      error.status = status;
      error.requestId = requestId;
      throw error;
    }

    const snapshot = await refreshStockStickiesHoldingsSnapshot(env);
    const performance = await buildStockStickiesPerformance(
      env,
      stockStickiesPerformanceYear(),
      snapshot,
      { forceTransactions: true }
    );
    const completedAt = new Date();
    const refresh = {
      requested: true,
      status: 'completed',
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      requestId: String(payload.request_id || '').slice(0, 120),
      itemId: String(item.item_id || ''),
      positionsChanged:
        stockStickiesPositionQuantityFingerprint(previousSnapshot) !==
        stockStickiesPositionQuantityFingerprint(snapshot),
      previousSnapshotFetchedAt: previousSnapshot?.fetchedAt || null,
      institutionDataAsOf: stockStickiesLatestInstitutionTimestamp(snapshot),
      cooldownSeconds: Math.round(STOCK_STICKIES_INVESTMENTS_REFRESH_COOLDOWN_MS / 1000),
    };
    await env.RENTALS.put(
      STOCK_STICKIES_INVESTMENTS_REFRESH_KEY,
      JSON.stringify(refresh),
      { expirationTtl: 24 * 60 * 60 }
    );
    return jsonResponse({ ...snapshot, performance, refresh, source: 'on-demand-refresh' }, 200, corsHeaders);
  } catch (error) {
    const failedAt = new Date().toISOString();
    await env.RENTALS.put(STOCK_STICKIES_INVESTMENTS_REFRESH_KEY, JSON.stringify({
      status: 'failed',
      startedAt: startedAt.toISOString(),
      failedAt,
      code: String(error?.code || 'UNKNOWN_ERROR').slice(0, 80),
      requestId: String(error?.requestId || '').slice(0, 120),
    }), { expirationTtl: 24 * 60 * 60 });
    console.error(JSON.stringify({
      event: 'stock_stickies_plaid_refresh_error',
      status: Number(error?.status) || 0,
      code: String(error?.code || 'UNKNOWN_ERROR').slice(0, 80),
      requestId: String(error?.requestId || '').slice(0, 120),
    }));
    return jsonResponse({
      ok: false,
      error: error instanceof Error
        ? error.message
        : 'Robinhood positions could not be refreshed.',
      code: String(error?.code || 'UNKNOWN_ERROR').slice(0, 80),
      requestId: String(error?.requestId || '').slice(0, 120),
      needsConsent: error?.code === 'ITEM_LOGIN_REQUIRED',
    }, error?.code === 'ITEM_LOGIN_REQUIRED'
      ? 409
      : error?.code === 'PLAID_UPSTREAM_TIMEOUT'
        ? 504
        : 502, corsHeaders);
  }
}

async function runScheduledStockStickiesHoldingsRefresh(env, scheduledTime) {
  try {
    const snapshot = await refreshStockStickiesHoldingsSnapshot(env);
    const performance = await buildStockStickiesPerformance(
      env,
      stockStickiesPerformanceYear(new Date(scheduledTime)),
      snapshot
    );
    console.log(JSON.stringify({
      event: 'scheduled_stock_stickies_holdings_refresh',
      scheduledTime: new Date(scheduledTime).toISOString(),
      fetchedAt: snapshot.fetchedAt,
      positionCount: snapshot.positions.length,
      cryptoPositionCount: snapshot.cryptoPositionCount,
      performanceSnapshotCount: performance.snapshotCount,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'scheduled_stock_stickies_holdings_refresh_error',
      scheduledTime: new Date(scheduledTime).toISOString(),
      code: String(error?.code || 'UNKNOWN_ERROR').slice(0, 80),
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function handleStockStickiesPlaidHoldings(env, corsHeaders) {
  try {
    const snapshot = await refreshStockStickiesHoldingsSnapshot(env);
    const performance = await buildStockStickiesPerformance(
      env,
      stockStickiesPerformanceYear(),
      snapshot
    );
    return jsonResponse({ ...snapshot, performance, source: 'live' }, 200, corsHeaders);
  } catch (error) {
    const code = String(error?.code || 'UNKNOWN_ERROR').slice(0, 80);
    const needsConsent = error?.needsConsent === true;
    console.error(JSON.stringify({
      event: 'stock_stickies_plaid_holdings_error',
      status: Number(error?.status) || 0,
      code,
    }));

    if (!needsConsent) {
      const cached = await env.RENTALS.get(STOCK_STICKIES_HOLDINGS_CACHE_KEY, 'json');
      const fetchedAtMs = Date.parse(String(cached?.fetchedAt || ''));
      const cacheAgeMs = Number.isFinite(fetchedAtMs) ? Date.now() - fetchedAtMs : Infinity;
      if (cached?.ok === true && cacheAgeMs >= 0 && cacheAgeMs <= STOCK_STICKIES_HOLDINGS_FALLBACK_MAX_AGE_MS) {
        const performance = await buildStockStickiesPerformance(
          env,
          stockStickiesPerformanceYear(),
          cached
        );
        return jsonResponse({
          ...cached,
          performance,
          source: 'nightly-cache',
          stale: true,
        }, 200, corsHeaders);
      }
    }

    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to load Robinhood positions.',
      code,
      needsConsent,
    }, needsConsent ? 409 : 502, corsHeaders);
  }
}

async function handleStockStickiesPlaidPerformance(env, corsHeaders) {
  try {
    let snapshot = await env.RENTALS.get(STOCK_STICKIES_HOLDINGS_CACHE_KEY, 'json');
    if (!snapshot) snapshot = await refreshStockStickiesHoldingsSnapshot(env);
    const performance = await buildStockStickiesPerformance(
      env,
      stockStickiesPerformanceYear(),
      snapshot
    );
    return jsonResponse({ ok: true, performance }, 200, corsHeaders);
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'YTD performance could not be loaded.',
    }, 502, corsHeaders);
  }
}

async function handleSaveStockStickiesPerformanceReconciliation(request, env, corsHeaders) {
  let body;
  try {
    body = await readJsonLimited(request, MAX_API_REQUEST_BYTES);
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body.' }, 400, corsHeaders);
  }
  const year = Number(body?.year);
  if (!Number.isInteger(year) || year < 2020 || year > stockStickiesPerformanceYear()) {
    return jsonResponse({ ok: false, error: 'Invalid performance year.' }, 400, corsHeaders);
  }
  const submitted = body?.openingValues;
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
    return jsonResponse({ ok: false, error: 'Opening account values are required.' }, 400, corsHeaders);
  }
  const openingValues = {};
  for (const id of STOCK_STICKIES_ACCOUNT_IDS) {
    const value = submitted[id];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
      return jsonResponse({
        ok: false,
        error: `A valid non-negative opening value is required for ${id}.`,
      }, 400, corsHeaders);
    }
    openingValues[id] = Math.round(value * 100) / 100;
  }
  const config = await env.RENTALS.get(STOCK_STICKIES_PERFORMANCE_CONFIG_KEY, 'json') || {};
  const nextConfig = {
    ...config,
    version: 2,
    updatedAt: new Date().toISOString(),
    openingValues: {
      ...(config.openingValues || {}),
      [String(year)]: openingValues,
    },
  };
  await env.RENTALS.put(STOCK_STICKIES_PERFORMANCE_CONFIG_KEY, JSON.stringify(nextConfig));
  let snapshot = await env.RENTALS.get(STOCK_STICKIES_HOLDINGS_CACHE_KEY, 'json');
  if (!snapshot) snapshot = await refreshStockStickiesHoldingsSnapshot(env);
  const performance = await buildStockStickiesPerformance(env, year, snapshot, {
    forceTransactions: true,
  });
  return jsonResponse({ ok: true, performance }, 200, corsHeaders);
}

// Bank-connection failures we can describe in plain language. Anything that
// needs the user to sign in again is flagged so the UI can say so.
const BANK_SYNC_RECONNECT_CODES = new Set([
  'ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'ITEM_LOCKED',
  'INVALID_CREDENTIALS', 'INVALID_MFA', 'INVALID_UPDATED_USERNAME',
]);
const OPTIONAL_INVESTMENT_REFRESH_CODES = new Set(['PRODUCT_NOT_SUPPORTED', 'PRODUCT_NOT_ENABLED']);
const BANK_SYNC_REASONS = {
  ITEM_LOGIN_REQUIRED: 'the saved sign-in has expired',
  PENDING_EXPIRATION: 'the saved sign-in is about to expire',
  ITEM_LOCKED: 'the account is locked at the bank',
  INVALID_CREDENTIALS: 'the saved sign-in is no longer valid',
  INVALID_MFA: 'the bank is asking for additional verification',
  INVALID_UPDATED_USERNAME: 'the username at the bank has changed',
  INSTITUTION_DOWN: 'the bank is temporarily unavailable',
  INSTITUTION_NOT_RESPONDING: 'the bank is temporarily unavailable',
  INSTITUTION_NO_LONGER_SUPPORTED: 'this bank is no longer supported',
  RATE_LIMIT_EXCEEDED: 'it was refreshed too many times just now',
  PRODUCT_NOT_SUPPORTED: 'live investment refresh is not supported by this institution',
  PRODUCT_NOT_ENABLED: 'live investment refresh is not enabled for this connection',
  LIVE_BALANCE_UNAVAILABLE: 'a live balance could not be retrieved',
};

// Confirmed production Item IDs. Metadata lookup remains the fallback for any
// future institution linked to the app.
const KNOWN_INSTITUTION_NAMES = { ins_54: 'Robinhood', ins_15: 'Navy Federal', ins_56: 'Chase' };

async function plaidPost(env, path, body) {
  const response = await fetch(`https://production.plaid.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
      'PLAID-SECRET': env.PLAID_SECRET,
      'Plaid-Version': '2020-09-14',
    },
    body: JSON.stringify(body),
  });
  let payload;
  try {
    payload = await readJsonLimited(response, MAX_UPSTREAM_JSON_BYTES);
  } catch {
    const upstreamError = new Error(
      response.status === 524
        ? 'Plaid took too long to complete the Robinhood refresh. No Stock Stickies positions were changed. Wait a few minutes, then try again.'
        : `Plaid returned an unreadable response (${response.status}).`
    );
    upstreamError.code = response.status === 524
      ? 'PLAID_UPSTREAM_TIMEOUT'
      : 'PLAID_INVALID_RESPONSE';
    upstreamError.status = response.status || 502;
    throw upstreamError;
  }
  return { ok: response.ok, status: response.status, payload };
}

// Identifies the bank behind a failed connection. /accounts/get fails outright
// for a broken Item, but /item/get still responds, so use it to recover both the
// institution name and the item id the reconnect flow needs.
async function resolveLinkedAccountInfo(env, accessToken, itemId) {
  const labels = plaidItemLabels(env);
  const info = { label: String(labels[itemId] || '').trim(), itemId: itemId || '' };
  try {
    const { ok, payload } = await plaidPost(env, '/item/get', { access_token: accessToken });
    if (!ok) return info;
    info.itemId = String(payload.item?.item_id || '') || info.itemId;
    const labelled = String(labels[info.itemId] || '').trim();
    if (labelled) { info.label = labelled; return info; }
    if (info.label) return info;
    const institutionId = String(payload.item?.institution_id || '');
    if (!institutionId) return info;
    if (KNOWN_INSTITUTION_NAMES[institutionId]) { info.label = KNOWN_INSTITUTION_NAMES[institutionId]; return info; }
    const meta = await plaidPost(env, '/institutions/get_by_id', {
      institution_id: institutionId,
      country_codes: ['US'],
    });
    if (meta.ok) info.label = String(meta.payload.institution?.name || '').trim().slice(0, 80);
    return info;
  } catch {
    return info;
  }
}

function bankSyncWarning(failure, info) {
  const label = String(info?.label || '').trim() || 'A linked account';
  const reason = BANK_SYNC_REASONS[failure.code] || 'the bank connection returned an error';
  const needsReconnect = BANK_SYNC_RECONNECT_CODES.has(failure.code);
  return {
    label: label.slice(0, 100),
    itemId: String(info?.itemId || ''),
    reason,
    needsReconnect,
    message: needsReconnect
      ? `${label} needs to be reconnected — ${reason}.`
      : `${label} could not be updated — ${reason}.`,
  };
}

// Update mode repairs the existing access token in place, so tokens can stay in
// Worker secrets — we just need to find which one owns the failing Item.
async function findPlaidAccessTokenForItem(env, itemId) {
  if (!itemId) return '';
  for (const accessToken of plaidAccessTokens(env)) {
    try {
      const { ok, payload } = await plaidPost(env, '/item/get', { access_token: accessToken });
      if (ok && String(payload.item?.item_id || '') === itemId) return accessToken;
    } catch { /* try the next token */ }
  }
  return '';
}

async function handleCreatePlaidLinkToken(env, itemId, institution, accountSelection) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    return jsonResponse({ error: 'Account syncing is not set up yet.' }, 400);
  }
  // `institution: 'robinhood'` targets the linked Robinhood Item directly (used to
  // re-authorize and pick up a newly opened account, e.g. a custodial account);
  // otherwise find the token that owns the given itemId (the reconnect flow).
  let accessToken = '';
  if (String(institution || '').toLowerCase() === 'robinhood') {
    try { accessToken = (await findRobinhoodPlaidItem(env)).accessToken; } catch { accessToken = ''; }
  } else {
    accessToken = await findPlaidAccessTokenForItem(env, String(itemId || '').slice(0, 100));
  }
  if (!accessToken) return jsonResponse({ error: 'That account connection was not found.' }, 404);
  const body = {
    client_name: "Red's STUFF",
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: 'rentals-owner' },
    access_token: accessToken, // presence of access_token = update mode
  };
  // Account-selection update mode lets the user add/remove which accounts are
  // shared — needed to grant access to a newly opened account.
  if (accountSelection) body.update = { account_selection_enabled: true };
  // Required by OAuth institutions; must also be registered in the Plaid dashboard.
  if (env.PLAID_REDIRECT_URI) body.redirect_uri = env.PLAID_REDIRECT_URI;
  const { ok, status, payload } = await plaidPost(env, '/link/token/create', body);
  if (!ok) {
    const code = String(payload.error_code || payload.error_type || 'UNKNOWN_ERROR').slice(0, 80);
    console.error(JSON.stringify({ event: 'plaid_link_token_error', status, code }));
    const needsRedirect = code === 'INVALID_FIELD' || code === 'INVALID_REDIRECT_URI';
    return jsonResponse({
      error: needsRedirect
        ? 'Reconnect could not start: this bank requires an OAuth redirect URI to be registered first.'
        : 'Reconnect could not start. Please try again in a moment.',
    }, 502);
  }
  return jsonResponse({ linkToken: String(payload.link_token || ''), expiration: String(payload.expiration || '') });
}

function mergePlaidAccountsById(baseAccounts, refreshedAccounts) {
  const refreshedById = new Map(
    (Array.isArray(refreshedAccounts) ? refreshedAccounts : [])
      .filter(account => account?.account_id)
      .map(account => [String(account.account_id), account])
  );
  return (Array.isArray(baseAccounts) ? baseAccounts : []).map(account =>
    refreshedById.get(String(account?.account_id || '')) || account
  );
}

async function fetchNetWorthPlaidItem(env, accessToken, forceLive) {
  const baseline = await plaidPost(env, '/accounts/get', { access_token: accessToken });
  if (!baseline.ok) {
    return {
      failure: {
        code: String(baseline.payload.error_code || baseline.payload.error_type || 'UNKNOWN_ERROR').slice(0, 80),
        itemId: String(baseline.payload.item_id || ''),
        accessToken,
      },
    };
  }

  const itemId = String(baseline.payload.item?.item_id || '');
  const institutionId = String(baseline.payload.item?.institution_id || '');
  let accounts = Array.isArray(baseline.payload.accounts) ? baseline.payload.accounts : [];
  const partialFailures = [];
  const informationalFailures = [];
  if (!forceLive) return { itemId, institutionId, accounts, partialFailures, informationalFailures };

  const balanceAccountIds = accounts
    .filter(account => account?.type !== 'investment')
    .map(account => String(account.account_id || ''))
    .filter(Boolean);
  if (balanceAccountIds.length) {
    try {
      const liveBalances = await plaidPost(env, '/accounts/balance/get', {
        access_token: accessToken,
        options: { account_ids: balanceAccountIds },
      });
      if (liveBalances.ok) {
        accounts = mergePlaidAccountsById(accounts, liveBalances.payload.accounts);
      } else {
        partialFailures.push({
          code: String(liveBalances.payload.error_code || liveBalances.payload.error_type || 'LIVE_BALANCE_UNAVAILABLE').slice(0, 80),
          itemId,
          accessToken,
        });
      }
    } catch (error) {
      partialFailures.push({
        code: String(error?.code || 'LIVE_BALANCE_UNAVAILABLE').slice(0, 80),
        itemId,
        accessToken,
      });
    }
  }

  const investmentAccountIds = accounts
    .filter(account => account?.type === 'investment')
    .map(account => String(account.account_id || ''))
    .filter(Boolean);
  if (investmentAccountIds.length) {
    let investmentRefreshFailure = null;
    try {
      const investmentRefresh = await plaidPost(env, '/investments/refresh', { access_token: accessToken });
      if (!investmentRefresh.ok) {
        investmentRefreshFailure = {
          code: String(investmentRefresh.payload.error_code || investmentRefresh.payload.error_type || 'LIVE_BALANCE_UNAVAILABLE').slice(0, 80),
          itemId,
          accessToken,
        };
      }
    } catch (error) {
      investmentRefreshFailure = {
        code: String(error?.code || 'LIVE_BALANCE_UNAVAILABLE').slice(0, 80),
        itemId,
        accessToken,
      };
    }

    try {
      const holdings = await plaidPost(env, '/investments/holdings/get', {
        access_token: accessToken,
        options: { account_ids: investmentAccountIds },
      });
      if (holdings.ok) {
        accounts = mergePlaidAccountsById(accounts, holdings.payload.accounts);
        if (investmentRefreshFailure) {
          (OPTIONAL_INVESTMENT_REFRESH_CODES.has(investmentRefreshFailure.code)
            ? informationalFailures
            : partialFailures).push(investmentRefreshFailure);
        }
      } else {
        if (investmentRefreshFailure) partialFailures.push(investmentRefreshFailure);
        partialFailures.push({
          code: String(holdings.payload.error_code || holdings.payload.error_type || 'LIVE_BALANCE_UNAVAILABLE').slice(0, 80),
          itemId,
          accessToken,
        });
      }
    } catch (error) {
      if (investmentRefreshFailure) partialFailures.push(investmentRefreshFailure);
      partialFailures.push({
        code: String(error?.code || 'LIVE_BALANCE_UNAVAILABLE').slice(0, 80),
        itemId,
        accessToken,
      });
    }
  }

  return { itemId, institutionId, accounts, partialFailures, informationalFailures };
}

async function refreshNetWorthPlaid(env, forceLive = false) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) throw new Error('Account syncing is not set up yet.');
  const tokens = plaidAccessTokens(env);
  if (!tokens.length) throw new Error('No bank accounts are linked yet.');
  // One broken connection must not wipe out every other institution, so each
  // item is settled independently and failures are reported as warnings.
  const settled = await Promise.all(tokens.map(async accessToken => {
    try {
      const result = await fetchNetWorthPlaidItem(env, accessToken, forceLive);
      if (result.failure) {
        console.error(JSON.stringify({
          event: 'plaid_net_worth_item_error',
          code: result.failure.code,
          itemId: result.failure.itemId,
        }));
      }
      return result;
    } catch (error) {
      console.error(JSON.stringify({
        event: 'plaid_net_worth_item_error',
        message: error instanceof Error ? error.message : String(error),
      }));
      return { failure: { code: 'REQUEST_FAILED', itemId: '', accessToken } };
    }
  }));
  const responses = settled.filter(entry => !entry.failure);
  const failures = settled.filter(entry => entry.failure).map(entry => entry.failure);
  const partialFailures = responses.flatMap(entry => entry.partialFailures || []);
  const warningFailures = [...failures, ...partialFailures]
    .filter((failure, index, list) => list.findIndex(other =>
      other.itemId === failure.itemId && other.code === failure.code) === index);
  const syncWarnings = await Promise.all(warningFailures.map(async failure =>
    bankSyncWarning(failure, await resolveLinkedAccountInfo(env, failure.accessToken, failure.itemId))));
  const informationalFailures = responses.flatMap(entry => entry.informationalFailures || [])
    .filter((failure, index, list) => list.findIndex(other =>
      other.itemId === failure.itemId && other.code === failure.code) === index);
  const refreshNotes = await Promise.all(informationalFailures.map(async failure => {
    const info = await resolveLinkedAccountInfo(env, failure.accessToken, failure.itemId);
    const label = String(info?.label || '').trim() || 'A linked account';
    return {
      label: label.slice(0, 100),
      message: `${label} investment balances were loaded from the latest available holdings data; instant investment refresh is not enabled for this connection.`,
    };
  }));
  if (!responses.length) {
    throw new Error(syncWarnings.map(w => w.message).join(' ') || 'Account balances could not be refreshed.');
  }
  const liabilityTypes = new Set(['credit', 'loan']);
  const institutionNames = { ...KNOWN_INSTITUTION_NAMES };
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
      // Catch-all so any other Robinhood account (Roth IRA, future types) still
      // gets the owner prefix. Joint accounts stay unprefixed.
      if (institution==='Robinhood' && owner && !/\bjoint\b/i.test(displayName) && !displayName.startsWith(`${owner}'s`)) {
        displayName = `${owner}'s ${displayName}`;
      }
      if (itemLabel) displayName=itemLabel;
      displayName = displayName.replace(/\btraditional\b/gi,'Traditional');
      if (institution === 'Navy Federal' && account.subtype === 'mortgage' && !/\(731WO\)/i.test(displayName)) {
        displayName += ' (731WO)';
      }
      // Gordon's Robinhood custodial (UTMA) account — explicit friendly name so it
      // doesn't render as "Chris's Robinhood UTMA". Set last so nothing re-prefixes it.
      if (institution === 'Robinhood' && /\butma\b|custodial/i.test(rawName)) {
        displayName = "Gordie's Custodial Brokerage Account";
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
  // When some connections failed, keep their last known accounts so a single
  // expired login doesn't silently drop balances out of net worth.
  let nextAccounts = dedupedAccounts;
  if (failures.length) {
    const freshIds = new Set(dedupedAccounts.map(account => account.id));
    const retained = (data.plaidAccounts || []).filter(account => account.id && !freshIds.has(account.id));
    nextAccounts = dedupedAccounts.concat(retained);
  }
  data.plaidAccounts = nextAccounts;
  data.plaidRefreshedAt = new Date().toISOString();
  addNetWorthSnapshot(data);
  await env.RENTALS.put(NET_WORTH_KEY, JSON.stringify(data));
  return { data, syncWarnings, refreshNotes };
}

async function handleRefreshNetWorthPlaid(env, forceLive = false) {
  try {
    if (forceLive && !(await plaidRefreshAllowed(env, 'net-worth-live-refresh'))) {
      return jsonResponse({ error: 'Accounts were refreshed too recently. Wait a minute and try again.' }, 429, { 'Retry-After': '60' });
    }
    const { syncWarnings, refreshNotes } = await refreshNetWorthPlaid(env, forceLive);
    let data;
    try { data = await refreshTreasuryPortfolio(env); }
    catch { data = normalizeNetWorth(await env.RENTALS.get(NET_WORTH_KEY, 'json')); }
    // normalizeNetWorth drops unknown keys, so attach warnings to the response.
    if (syncWarnings.length) data.syncWarnings = syncWarnings;
    if (refreshNotes.length) data.refreshNotes = refreshNotes;
    return jsonResponse({ data });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Account balances could not be refreshed.' }, 502);
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

const ROBINHOOD_BALANCE_CACHE_MS = 5 * 60 * 1000;
const PLAID_FORCE_REFRESH_MIN_MS = 60 * 1000;

// Robinhood balances pulled live from Plaid and mirrored into the Savings tab
// account fields. Each descriptor identifies its account inside the linked
// Robinhood (ins_54) Item and owns its own cache/selection KV keys, so pulling
// one balance never clobbers the other.
const ROBINHOOD_ACCOUNTS = {
  checking: {
    kind: 'checking',
    label: 'Robinhood checking',
    savingsField: 'robinhoodChecking',
    cacheKey: 'plaid:robinhood_checking_balance',
    selectionKey: 'plaid:robinhood_checking_selection',
    envAccountId: 'PLAID_ACCOUNT_ID',
    match: (account) => account.subtype === 'checking'
      || (account.type === 'depository' && /checking/i.test(`${account.name || ''} ${account.official_name || ''}`)),
  },
  brokerage: {
    kind: 'brokerage',
    label: 'Robinhood brokerage',
    savingsField: 'robinhoodBrokerage',
    cacheKey: 'plaid:robinhood_brokerage_balance',
    selectionKey: 'plaid:robinhood_brokerage_selection',
    envAccountId: 'PLAID_BROKERAGE_ACCOUNT_ID',
    // "Chris's Robinhood Individual Account" — the taxable brokerage account.
    match: (account) => account.subtype === 'brokerage'
      || (account.type === 'investment' && /individual/i.test(`${account.name || ''} ${account.official_name || ''}`)),
  },
};

async function plaidTokenFingerprint(accessToken) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken));
  return [...new Uint8Array(digest).slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function resolvePlaidTokenForAccount(env, descriptor) {
  const tokens = plaidAccessTokens(env);
  if (!tokens.length) throw new Error('No bank accounts are linked yet.');
  const preferredAccountId = descriptor.envAccountId ? env[descriptor.envAccountId] : null;

  const fingerprints = await Promise.all(tokens.map(plaidTokenFingerprint));
  const saved = await env.RENTALS.get(descriptor.selectionKey, 'json');
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
        console.warn(JSON.stringify({ event: 'plaid_item_lookup_error', kind: descriptor.kind, status: response.status, code }));
        return false;
      }
      const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
      const exactAccount = preferredAccountId ? accounts.find(account => account.account_id === preferredAccountId) : null;
      const typedAccount = String(payload.item?.institution_id || '') === 'ins_54'
        ? accounts.find(descriptor.match)
        : null;
      const matchedAccount = exactAccount || typedAccount;
      return matchedAccount
        ? { index, accountId: String(matchedAccount.account_id || ''), exact: !!exactAccount }
        : null;
    } catch (error) {
      console.warn(JSON.stringify({ event: 'plaid_item_lookup_error', kind: descriptor.kind, message: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  }));
  const matching = matches.filter(Boolean).sort((a, b) => Number(b.exact) - Number(a.exact))[0];
  if (!matching?.accountId) throw new Error(`${descriptor.label} was not found in the linked accounts.`);

  await env.RENTALS.put(descriptor.selectionKey, JSON.stringify({
    tokenFingerprint: fingerprints[matching.index],
    accountId: matching.accountId,
  }));
  return { accessToken: tokens[matching.index], accountId: matching.accountId };
}

// Returns the Plaid account object for the selected account. Prefers the
// real-time /accounts/balance/get endpoint, but Robinhood's investment accounts
// (brokerage/IRA) reject that call with a 400, so it falls back to /accounts/get
// (cached balances — the same source the Net Worth view reads successfully).
async function fetchPlaidAccountBalance(env, selection) {
  const headers = {
    'Content-Type': 'application/json',
    'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
    'PLAID-SECRET': env.PLAID_SECRET,
    'Plaid-Version': '2020-09-14',
  };
  const attempts = [
    { url: 'https://production.plaid.com/accounts/balance/get', body: { access_token: selection.accessToken, options: { account_ids: [selection.accountId] } } },
    { url: 'https://production.plaid.com/accounts/get', body: { access_token: selection.accessToken } },
  ];
  let lastError = 'unknown';
  let lastCode = '';
  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, { method: 'POST', headers, body: JSON.stringify(attempt.body) });
      const data = await readJsonLimited(response, MAX_UPSTREAM_JSON_BYTES);
      if (!response.ok) {
        lastCode = String(data.error_code || '').slice(0, 80);
        lastError = lastCode || String(data.error_type || response.status).slice(0, 80);
        continue;
      }
      const account = Array.isArray(data.accounts)
        ? data.accounts.find(item => item.account_id === selection.accountId)
        : null;
      if (account) return account;
      lastError = 'account_not_returned';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  const err = new Error(`Balance request failed (${lastError})`);
  err.plaidCode = lastCode;
  throw err;
}

// When a balance pull fails because the bank login expired, build the same
// reconnect payload the Net Worth banner uses so any Plaid-consuming view can
// prompt the user (and open the in-app reconnect flow) with a working itemId.
async function buildBalanceReconnectInfo(env, code, selection) {
  if (!BANK_SYNC_RECONNECT_CODES.has(code) || !selection?.accessToken) return {};
  const info = await resolveLinkedAccountInfo(env, selection.accessToken, '');
  const warning = bankSyncWarning({ code }, info);
  if (!warning.needsReconnect || !warning.itemId) return {};
  return {
    needsReconnect: true,
    itemId: warning.itemId,
    reconnectLabel: warning.label,
    reconnectMessage: warning.message,
  };
}

async function handleGetRobinhoodBalance(env, forceRefresh, source = 'client', descriptor = ROBINHOOD_ACCOUNTS.checking) {
  const cached = await env.RENTALS.get(descriptor.cacheKey, 'json');
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

  if (forceRefresh && source === 'client' && !(await plaidRefreshAllowed(env, `robinhood-balance-refresh-${descriptor.kind}`))) {
    if (cached) {
      return jsonResponse({ ...cached, source: 'cache', stale: cacheAge >= ROBINHOOD_BALANCE_CACHE_MS, refreshLimited: true });
    }
    return jsonResponse({ error: 'Live balance refresh limit reached. Try again shortly.' }, 429, { 'Retry-After': '60' });
  }

  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET || !plaidAccessTokens(env).length) {
    if (cached) return jsonResponse({ ...cached, source: 'cache', stale: true, warning: 'Live balance is not configured.' });
    return jsonResponse({ error: 'Live Robinhood balance is not configured' }, 503);
  }

  let selection = null;
  try {
    selection = await resolvePlaidTokenForAccount(env, descriptor);
    const account = await fetchPlaidAccountBalance(env, selection);

    const current = Number(account.balances?.current);
    const available = Number(account.balances?.available);
    const balance = Number.isFinite(current) ? current : available;
    if (!Number.isFinite(balance)) throw new Error(`${descriptor.label} balance was unavailable`);

    const result = {
      balance,
      current: Number.isFinite(current) ? current : null,
      available: Number.isFinite(available) ? available : null,
      refreshedAt: new Date().toISOString(),
      source: 'live',
      stale: false,
    };

    await Promise.all([
      env.RENTALS.put(descriptor.cacheKey, JSON.stringify(result)),
      syncRobinhoodSavingsField(env, descriptor.savingsField, balance),
    ]);
    return jsonResponse(result);
  } catch (error) {
    const code = error && error.plaidCode ? String(error.plaidCode) : '';
    console.error(JSON.stringify({ event: 'plaid_balance_error', kind: descriptor.kind, code, message: error instanceof Error ? error.message : String(error) }));
    const reconnect = await buildBalanceReconnectInfo(env, code, selection);
    if (cached) {
      return jsonResponse({
        ...cached,
        source: 'cache',
        stale: true,
        warning: 'Plaid could not refresh the balance. Showing the last successful value.',
        ...reconnect,
      });
    }
    return jsonResponse({ error: `Unable to refresh ${descriptor.label} balance`, ...reconnect }, 502);
  }
}

async function plaidRefreshAllowed(env, key = 'robinhood-balance-refresh') {
  if (!env.PLAID_RATELIMIT) return true;
  try {
    const { success } = await env.PLAID_RATELIMIT.limit({ key });
    return success;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'plaid_rate_limit_error', message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
}

async function syncRobinhoodSavingsField(env, field, balance) {
  const savings = await env.RENTALS.get('savings', 'json');
  if (!savings || typeof savings !== 'object') return;
  const accounts = savings.accounts && typeof savings.accounts === 'object' ? savings.accounts : {};
  savings.accounts = { ...accounts, [field]: balance };
  await env.RENTALS.put('savings', JSON.stringify(savings));
}

async function handleSaveSavings(env, data) {
  if (!data || typeof data !== 'object') {
    return jsonResponse({ error: 'Missing data object' }, 400);
  }

  const existingSavings = await env.RENTALS.get('savings', 'json') || {};
  const cachedChecking = await env.RENTALS.get(ROBINHOOD_ACCOUNTS.checking.cacheKey, 'json');
  const cachedBrokerage = await env.RENTALS.get(ROBINHOOD_ACCOUNTS.brokerage.cacheKey, 'json');
  const plaidChecking = typeof cachedChecking?.balance === 'number' ? cachedChecking.balance : NaN;
  const plaidBrokerage = typeof cachedBrokerage?.balance === 'number' ? cachedBrokerage.balance : NaN;
  const savedChecking = typeof existingSavings?.accounts?.robinhoodChecking === 'number'
    ? existingSavings.accounts.robinhoodChecking
    : NaN;
  const savedBrokerage = typeof existingSavings?.accounts?.robinhoodBrokerage === 'number'
    ? existingSavings.accounts.robinhoodBrokerage
    : NaN;
  const sanitizedAccounts = {
    // Robinhood Checking and Brokerage are both server-owned and can only be
    // changed by a successful Plaid balance pull. Ignore client-supplied values,
    // falling back to the last saved balance until the first live pull lands.
    robinhoodChecking: Number.isFinite(plaidChecking)
      ? plaidChecking
      : (Number.isFinite(savedChecking) ? savedChecking : 0),
    robinhoodBrokerage: Number.isFinite(plaidBrokerage)
      ? plaidBrokerage
      : (Number.isFinite(savedBrokerage) ? savedBrokerage : 0),
  };

  const obligations = Array.isArray(data.obligations) ? data.obligations.map(o => ({
    id: o.id || crypto.randomUUID(),
    name: String(o.name || '').trim().slice(0, 200),
    amount: (typeof o.amount === 'number' && isFinite(o.amount) && o.amount >= 0) ? o.amount : 0,
    paymentsPerYear: (o.paymentsPerYear === 2) ? 2 : 1,
    kind: o.kind === 'static' ? 'static' : 'recurring',
    critical: o.critical === true,
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
