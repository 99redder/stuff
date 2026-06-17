// rentals-api — Cloudflare Worker for Rental Property Manager
// All amounts stored and returned in DOLLARS (never cents).
// KV keys: transactions:{property}, summaries:{property}, defaults:{property}, depreciation:{property}

const VALID_PROPERTIES = ['6AL', '95EB', '446BB', '731WO'];

const VALID_CATEGORIES = [
  'rent', 'deposit', 'late_fee', 'other_income',
  'taxes', 'insurance', 'repairs', 'improvements', 'utilities',
  'hoa', 'management', 'auto', 'legal', 'marketing', 'other_expense',
  'mortgage_interest', 'pmi'  // historical summaries only
];

const ALLOWED_ORIGIN = 'https://99redder.github.io';
const SESSION_COOKIE = 'rentals_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_FAILURES = 5;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Password, X-Session',
  'Access-Control-Allow-Credentials': 'true',
  'Vary': 'Origin',
};

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
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
  }
};

async function handleDataApi(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { action } = body;

  // Password check — creates an HttpOnly session cookie on success.
  if (action === 'verify_password') {
    return handleVerifyPassword(request, env, body.password);
  }
  if (action === 'logout') {
    return handleLogout(request, env);
  }
  if (action === 'verify_session') {
    const ok = await isAuthenticated(request, env);
    return jsonResponse({ ok }, ok ? 200 : 401);
  }
  if (action === 'get_mom_budget_public_summary') {
    return handleGetMomBudgetPublicSummary(request, env, body.month);
  }

  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // Non-property actions
  if (action === 'get_tax_planning') return handleGetTaxPlanning(env, body.year);
  if (action === 'save_tax_planning') return handleSaveTaxPlanning(env, body.year, body.data);
  if (action === 'fetch_fmg_tax_summary') return handleFetchFmgTaxSummary(body);
  if (action === 'get_budget') return handleGetBudget(env);
  if (action === 'save_budget') return handleSaveBudget(env, body.data);
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
    'save_maintenance', 'add_maintenance_entry', 'update_maintenance_entry', 'delete_maintenance_entry'
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

    case 'add_maintenance_entry':
      return handleAddMaintenanceEntry(env, property, body.entry);

    case 'update_maintenance_entry':
      return handleUpdateMaintenanceEntry(env, property, body.id, body.entry);

    case 'delete_maintenance_entry':
      return handleDeleteMaintenanceEntry(env, property, body.id);

    case 'get_investment':
      return handleGetInvestment(env, property);

    case 'save_investment':
      return handleSaveInvestment(env, property, body.config);

    case 'close_investment':
      return handleCloseInvestment(env, property, body.closeout);

    case 'fetch_zillow':
      return handleFetchZillow(env, property, body.url);

    default:
      return jsonResponse({ error: 'Invalid action' }, 400);
  }
}

async function handleVerifyPassword(request, env, password) {
  const stored = env.ADMIN_PASSWORD || '';
  if (!stored) return jsonResponse({ error: 'Password not configured on server' }, 500);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const failKey = `auth_fail:${ip}`;
  const failures = parseInt(await env.RENTALS.get(failKey) || '0', 10) || 0;
  if (failures >= LOGIN_MAX_FAILURES) {
    return jsonResponse({ error: 'Too many failed login attempts. Try again later.' }, 429);
  }

  if (password !== stored) {
    await env.RENTALS.put(failKey, String(failures + 1), { expirationTtl: LOGIN_WINDOW_SECONDS });
    return jsonResponse({ ok: false });
  }

  await env.RENTALS.delete(failKey);
  const token = crypto.randomUUID() + '-' + crypto.randomUUID();
  const sessionKey = `session:${await sha256Hex(token)}`;
  await env.RENTALS.put(sessionKey, JSON.stringify({ createdAt: new Date().toISOString(), ip }), { expirationTtl: SESSION_TTL_SECONDS });

  return jsonResponse({ ok: true, sessionToken: token }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=None`,
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

  const loginRes = await fetch('https://florencemaegifts.com/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  if (!loginRes.ok) {
    const err = await loginRes.json().catch(() => ({}));
    return jsonResponse({ error: err.error || `FMG login failed (${loginRes.status})` }, loginRes.status === 429 ? 429 : 401);
  }

  const setCookie = loginRes.headers.get('Set-Cookie') || '';
  const sessionCookie = setCookie.split(';')[0];
  if (!sessionCookie) return jsonResponse({ error: 'FMG login did not return a session cookie' }, 502);

  const txUrl = `https://florencemaegifts.com/api/tax/transactions?year=${encodeURIComponent(year)}&type=all&limit=5000`;
  const txRes = await fetch(txUrl, { headers: { Cookie: sessionCookie } });
  const data = await txRes.json().catch(() => ({}));

  if (!txRes.ok) {
    return jsonResponse({ error: data.error || `FMG tax fetch failed (${txRes.status})` }, txRes.status === 401 ? 401 : 502);
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
  if (token) {
    const session = await env.RENTALS.get(`session:${await sha256Hex(token)}`);
    if (session) return true;
  }

  // Temporary backwards-compatible fallback; remove after session-cookie auth is confirmed live.
  const provided = request.headers.get('X-Password') || '';
  const stored = env.ADMIN_PASSWORD || '';
  return !!stored && provided === stored;
}

function getSessionToken(request) {
  return request.headers.get('X-Session') || getCookie(request, SESSION_COOKIE);
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
    id: e.id || crypto.randomUUID(),
    date: e.date || '',
    description: String(e.description || '').trim(),
    cost: typeof e.cost === 'number' && isFinite(e.cost) ? e.cost : 0,
    performedBy: String(e.performedBy || '').trim(),
    notes: String(e.notes || '').trim()
  }));
  await env.RENTALS.put(`maintenance:${property}`, JSON.stringify(saved));
  return jsonResponse({ entries: saved });
}

async function handleAddMaintenanceEntry(env, property, entry) {
  if (!entry || typeof entry !== 'object') {
    return jsonResponse({ error: 'Missing entry object' }, 400);
  }
  const newEntry = {
    id: crypto.randomUUID(),
    date: entry.date || '',
    description: String(entry.description || '').trim(),
    cost: typeof entry.cost === 'number' && isFinite(entry.cost) ? entry.cost : 0,
    performedBy: String(entry.performedBy || '').trim(),
    notes: String(entry.notes || '').trim(),
    capitalImprovement: !!entry.capitalImprovement,
  };
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
  entries[idx] = {
    id,
    date: entry.date || entries[idx].date,
    description: String(entry.description || '').trim(),
    cost: typeof entry.cost === 'number' && isFinite(entry.cost) ? entry.cost : entries[idx].cost,
    performedBy: String(entry.performedBy || '').trim(),
    notes: String(entry.notes || '').trim(),
    capitalImprovement: 'capitalImprovement' in entry ? !!entry.capitalImprovement : !!entries[idx].capitalImprovement,
  };
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

// ── Mom Budget ───────────────────────────────────────────────────────────────

const MOM_BUDGET_DEFAULT = {
  template: {
    income: [
      { id: 'ss', name: 'Social Security', amount: 2092.50 },
      { id: '401k', name: '401k Distribution', amount: 1000 }
    ],
    fixed: [
      // Household bills wrapped into one auto-synced Fair Share line (she lives with family).
      { id: 'fair-share', name: 'Fair Share (household)', amount: 0, frequency: 'monthly', auto: true, locked: true },
      { id: 'cell', name: 'Cell Phone', amount: 125 },
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
  const raw = await env.RENTALS.get('mom_budget', 'json') || {};
  const data = normalizeMomBudget(raw);
  const month = calcMomBudgetMonth(data, monthKey);
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
      discretionaryAdjusted: month.discretionaryAdjusted
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
    month.discretionary = Array.isArray(month.discretionary) ? month.discretionary : [];
    month.otherExpenses = Array.isArray(month.otherExpenses) ? month.otherExpenses : [];
  });
  return data;
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

  // Merge into existing — preserve zillowEstimate/zillowFetchedAt unless manually overridden
  const existing = await env.RENTALS.get(`investment:${property}`, 'json') || {};
  const saved = {
    ...existing,
    purchasePrice,
    purchaseClosingCosts,
    saleClosingCostPct,
    stateCapGainsPct,
    zillowUrl: typeof config.zillowUrl === 'string' ? config.zillowUrl.trim() : (existing.zillowUrl || ''),
    purchaseDate: (typeof config.purchaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(config.purchaseDate))
      ? config.purchaseDate : (existing.purchaseDate || null),
  };

  // Allow manual Zillow estimate override
  if (typeof config.zillowEstimate === 'number' && isFinite(config.zillowEstimate) && config.zillowEstimate > 0) {
    saved.zillowEstimate  = config.zillowEstimate;
    saved.zillowFetchedAt = typeof config.zillowFetchedAt === 'string' ? config.zillowFetchedAt : new Date().toISOString();
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

async function handleFetchZillow(env, property, url) {
  if (!url || typeof url !== 'string' || !url.includes('zillow.com')) {
    return jsonResponse({ error: 'Invalid Zillow URL' }, 400);
  }

  let html;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      }
    });

    if (!response.ok) {
      return jsonResponse({ error: `Zillow returned HTTP ${response.status}. Try entering the estimate manually.` }, 422);
    }

    html = await response.text();
  } catch (err) {
    return jsonResponse({ error: `Failed to reach Zillow: ${err.message}` }, 502);
  }

  // Attempt extraction — multiple patterns for resilience
  let zestimate = null;

  // Pattern 1: "zestimate":{"amount":XXXXXX}
  const m1 = html.match(/"zestimate"\s*:\s*\{\s*"amount"\s*:\s*(\d+)/);
  if (m1) zestimate = parseInt(m1[1], 10);

  // Pattern 2: "zestimate":XXXXXX (direct number, 5–7 digits)
  if (!zestimate) {
    const m2 = html.match(/"zestimate"\s*:\s*(\d{5,7})\b/);
    if (m2) zestimate = parseInt(m2[1], 10);
  }

  // Pattern 3: __NEXT_DATA__ script tag
  if (!zestimate) {
    try {
      const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (ndMatch) {
        const nd = JSON.parse(ndMatch[1]);
        const gdpCache = nd?.props?.pageProps?.componentProps?.gdpClientCache;
        if (gdpCache) {
          const gc = JSON.parse(gdpCache);
          const firstKey = Object.keys(gc)[0];
          zestimate = gc?.[firstKey]?.property?.zestimate?.amount
            || gc?.[firstKey]?.zestimate?.amount
            || null;
        }
      }
    } catch (_) {
      // parse failure — continue to error below
    }
  }

  if (!zestimate) {
    return jsonResponse({
      error: 'Could not find Zestimate on page. Zillow may be blocking automated access — enter the estimate manually.'
    }, 422);
  }

  // Persist result into investment config
  const existing = await env.RENTALS.get(`investment:${property}`, 'json') || {};
  existing.zillowEstimate = zestimate;
  existing.zillowFetchedAt = new Date().toISOString();
  existing.zillowUrl = url;
  await env.RENTALS.put(`investment:${property}`, JSON.stringify(existing));

  return jsonResponse({ zestimate, fetchedAt: existing.zillowFetchedAt });
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

async function handleSaveSavings(env, data) {
  if (!data || typeof data !== 'object') {
    return jsonResponse({ error: 'Missing data object' }, 400);
  }

  const accounts = (data.accounts && typeof data.accounts === 'object') ? data.accounts : {};
  const sanitizedAccounts = {
    robinhood: (typeof accounts.robinhood === 'number' && isFinite(accounts.robinhood)) ? accounts.robinhood : 0,
    ibkr:      (typeof accounts.ibkr      === 'number' && isFinite(accounts.ibkr))      ? accounts.ibkr      : 0,
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
