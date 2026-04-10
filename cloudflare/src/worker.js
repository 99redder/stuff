// rentals-api — Cloudflare Worker for Rental Property Manager
// All amounts stored and returned in DOLLARS (never cents).
// KV keys: transactions:{property}, summaries:{property}, defaults:{property}, depreciation:{property}

const VALID_PROPERTIES = ['6AL', '95EB', '446BB'];

const VALID_CATEGORIES = [
  'rent', 'deposit', 'late_fee', 'other_income',
  'taxes', 'insurance', 'repairs', 'improvements', 'utilities',
  'hoa', 'management', 'auto', 'legal', 'marketing', 'other_expense',
  'mortgage_interest', 'pmi'  // historical summaries only
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Password',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
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

  // Password check — verify_password action handled separately (no auth required)
  if (action === 'verify_password') {
    const { password } = body;
    const stored = env.ADMIN_PASSWORD;
    if (!stored) return jsonResponse({ error: 'Password not configured on server' }, 500);
    const ok = password === stored;
    return jsonResponse({ ok });
  }

  // All other actions require the password header
  const provided = request.headers.get('X-Password') || '';
  const stored   = env.ADMIN_PASSWORD || '';
  if (!stored || provided !== stored) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // Non-property actions
  if (action === 'get_tax_planning') return handleGetTaxPlanning(env, body.year);
  if (action === 'save_tax_planning') return handleSaveTaxPlanning(env, body.year, body.data);

  const { property } = body;

  if (!property || !VALID_PROPERTIES.includes(property)) {
    return jsonResponse({ error: 'Invalid or missing property' }, 400);
  }

  switch (action) {
    case 'get_transactions':
      return handleGetTransactions(env, property);

    case 'add_transaction':
      return handleAddTransaction(env, property, body.transaction);

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

    default:
      return jsonResponse({ error: 'Invalid action' }, 400);
  }
}

// ── Transactions ─────────────────────────────────────────────────────────────

async function handleGetTransactions(env, property) {
  const transactions = await env.RENTALS.get(`transactions:${property}`, 'json') || [];
  return jsonResponse({ transactions });
}

async function handleAddTransaction(env, property, transaction) {
  if (!transaction || typeof transaction !== 'object') {
    return jsonResponse({ error: 'Missing transaction object' }, 400);
  }

  const { type, category, date, amount, description = '' } = transaction;

  if (!['income', 'expense'].includes(type)) {
    return jsonResponse({ error: 'Invalid type' }, 400);
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return jsonResponse({ error: 'Invalid category' }, 400);
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ error: 'Invalid date format (expected YYYY-MM-DD)' }, 400);
  }
  if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
    return jsonResponse({ error: 'Amount must be a positive number' }, 400);
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

  const transactions = await env.RENTALS.get(`transactions:${property}`, 'json') || [];
  transactions.push(newTransaction);
  await env.RENTALS.put(`transactions:${property}`, JSON.stringify(transactions));

  return jsonResponse({ transaction: newTransaction });
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

// ── Helper ────────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}
