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
  if (action === 'get_budget') return handleGetBudget(env);
  if (action === 'save_budget') return handleSaveBudget(env, body.data);

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

  const { property } = body;

  if (!property || !VALID_PROPERTIES.includes(property)) {
    return jsonResponse({ error: 'Invalid or missing property' }, 400);
  }

  const readOnlyWhenSold = new Set([
    'add_transaction', 'delete_transaction',
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

// ── Helper ────────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}
