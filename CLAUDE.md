# Rental Property Manager — CLAUDE.md

Developer reference for AI agents working on this project.

---

## What This Is

A single-page property management app for tracking rental income, expenses, and depreciation across three rental properties (**6AL**, **95EB**, **446BB**) plus one primary residence (**731WO**).

Deployed as:
- **Frontend**: GitHub Pages — static `index.html` served from `https://99redder.github.io/rentals/`
- **API**: Cloudflare Worker — `https://rentals-api.99redder.workers.dev`

There is no build step. The entire frontend is one self-contained `index.html` (HTML + CSS + JS). Do not introduce bundlers, frameworks, or separate JS/CSS files unless explicitly asked.

---

## File Structure

```
rentals/
├── index.html                  # Entire frontend — all HTML, CSS, and JS
├── .gitignore                  # Excludes node_modules, .DS_Store, .wrangler/
├── package.json                # Root — only has wrangler as a dev dep
├── package-lock.json
└── cloudflare/
    ├── wrangler.toml           # Worker config — name, KV binding, compat date
    ├── package.json            # cloudflare/ — wrangler dev/deploy scripts
    └── src/
        └── worker.js           # Cloudflare Worker — all API logic
```

---

## Navigating `index.html`

`index.html` is one large self-contained file (~5000+ lines). Use these search anchors:

- **CSS sections** — search `/* ──` (e.g. `/* ── Reset & Variables`, `/* ── Print Styles`)
- **HTML sections** — search `<!-- ──` (e.g. `<!-- ── Delete Confirmation Modal`)
- **JS sections** — search `// ──` (e.g. `// ── View: Monthly Budget`, `// ── State`)

A full table of contents is in the `NAVIGATION GUIDE` block comment at the very top of `<script>` (just after `'use strict';`). Read that first when orienting to a new area.

---

## Frontend Architecture (`index.html`)

### Navigation (two-tier)
```
Property tabs:  [6AL]  [95EB]  [446BB]  [731WO]
View tabs:      [Current Year]  [Tax Summary]  [Investment Return]  [Historical]  [Maintenance]  [All Properties]
Header buttons: [Monthly Budget]  [☀️ Solar]  [Tax Planning]
```
- Property tabs are hidden when **All Properties**, **Monthly Budget**, **Solar**, or **Tax Planning** views are active.
- **731WO** is a primary residence — only shows Investment Return and Maintenance views (`PRIMARY_PROPERTIES` / `PRIMARY_VIEWS` constants).
- Switching property tabs reloads the current view for the new property.

### Views
| View | Key | Description |
|---|---|---|
| Current Year | `current-year` | YTD stat cards + transaction list with Edit/Delete |
| Tax Summary | `tax-summary` | Current-year category totals, print-ready |
| Investment Return | `investment-return` | IRR, equity, Zillow estimate, purchase config |
| Historical | `historical` | Annual summary table + Depreciation Schedule card |
| Maintenance | `maintenance` | Per-property maintenance log with improvement tracking |
| All Properties | `portfolio` | Combined stats + per-property breakdown + multi-year history |
| Monthly Budget | `budget` | Global monthly income/expense planner with property worksheets |
| Solar ROI | `solar` | Solar panel ROI tracking + billing cycle calculator |
| Tax Planning | `tax-planning` | Projected federal/MD/VA tax liability with live inputs |

### State Model
```javascript
const state = {
  currentProperty: '6AL',       // active property tab
  currentView: 'current-year',  // active view
  password: '',                  // set at login, sent as X-Password header on every API call
  data: {
    '6AL':   { transactions: null, summaries: null, defaults: null, depreciation: null, maintenance: null, investment: null },
    '95EB':  { transactions: null, summaries: null, defaults: null, depreciation: null, maintenance: null, investment: null },
    '446BB': { transactions: null, summaries: null, defaults: null, depreciation: null, maintenance: null, investment: null },
    '731WO': { transactions: null, summaries: null, defaults: null, depreciation: null, maintenance: null, investment: null }
  },
  pendingDefaultPrompt: null,   // { category, amount } — shown after saving a transaction
  pendingMaintPrompt: null,     // { date, amount, description, category } — shown after expense save
  budget: null,                 // loaded once, global — { income, expenses, worksheets }
  solar: { config: null, entries: null, summaries: null }
};
```
`null` means not yet fetched. `ensureLoaded(property, key)` fetches on demand and caches in `state.data`.

### Key JS Functions
| Function | Purpose |
|---|---|
| `ensureLoaded(prop, key)` | Lazy-loads one data type for one property; no-ops if already cached |
| `callApi(body)` | All API calls go through here — adds `X-Password` header, handles 401 |
| `renderView()` | Dispatches to the correct render function based on `state.currentView` |
| `renderCurrentYear()` | Current year view |
| `renderHistorical()` | Historical summaries + depreciation section |
| `renderTaxSummary()` | Tax summary view |
| `renderAddEntry()` | Add entry form |
| `renderPortfolio()` | All-properties portfolio view |
| `renderMaintenance()` | Maintenance log view |
| `renderInvestmentReturn()` | IRR/equity/Zillow view |
| `renderBudget()` | Monthly budget planner |
| `renderSolar()` | Solar ROI view |
| `renderTaxPlanning()` | Tax planning view |
| `openBudgetWorksheetModal(id)` | Opens the property income worksheet for a budget income item |
| `calcDepreciationSchedule(costBasis, placedInService)` | MACRS 27.5-yr straight-line, mid-month convention |
| `fmt(amount)` | Format dollar amount with 2 decimal places |
| `fmtShort(amount)` | Abbreviated format ($1.4k, $22k) for tables |
| `fmtDate(iso)` | `YYYY-MM-DD` → `Mon D, YYYY` |
| `escHtml(str)` | XSS-safe HTML escaping — use on all user-supplied content |
| `escAttr(str)` | XSS-safe attribute escaping |

### Amount Storage
**All amounts are stored and transmitted in US dollars as plain numbers (e.g. `2200`, `262.50`). Never multiply or divide by 100. There are no "cents" in this codebase.**

### Modals
Four modals exist in the HTML (outside `<main>`):
- **Delete modal** (`#delete-modal`) — step 1: shows entry detail, "Yes, Delete" button
- **Delete double-confirm** (`#delete-modal-2`) — step 2: "Delete Forever" (darker red)
- **Edit modal** (`#edit-modal`) — pre-filled form for editing a transaction
- **Property income worksheet** (`#budget-worksheet-modal`) — calculates net monthly income for 95EB/6AL/446BB; body rendered dynamically by `_renderBudgetWorksheetModal()`
- **Solar billing cycle calculator** (`#solar-calc-modal`) — estimates electricity cost without solar

All modals close on Escape key or clicking the backdrop.

### Password Gate
On load, `sessionStorage` is checked for `rentals_auth = '1'`. If not set, the entire app UI is hidden and a login form is shown. On successful login:
- `sessionStorage.setItem('rentals_auth', '1')` — persists for the browser session
- `sessionStorage.setItem('rentals_pw', pw)` — password stored for API calls
- `state.password` is set and sent as `X-Password` header on every `callApi()` call

If any API call returns 401, the user is immediately sent back to the login screen and session storage is cleared.

### Monthly Budget — Property Income Worksheets
The budget income section treats income items named `95EB`, `6AL`, or `446BB` (or with a matching `property` field) as "property income" rows. These render with a `(worksheet)` suffix and open `#budget-worksheet-modal` when clicked.

The worksheet modal calculates net monthly income:
```
net = rent − (mgmtFees + hoaFees + taxes + insurance + maintSavings + turnoverSavings + incomeTaxSavings + umbrellaInsurance)
```
On first open, the worksheet pre-populates from:
- `rent` — stored defaults for the property (`state.data[prop].defaults.rent`)
- `mgmtFees` — `rent × NORMAL_MONTH_CONFIG[prop].mgmtPct`
- `hoaFees` — sum of `NORMAL_MONTH_CONFIG[prop].hoa[].amount`

Saving writes the calculated net back as the income item's amount. Worksheet values are persisted in `state.budget.worksheets` (keyed by income item UUID) and saved to KV under the `budget` key.

```javascript
const NORMAL_MONTH_CONFIG = {
  '6AL':   { mgmtPct: 0,    hoa: [] },
  '95EB':  { mgmtPct: 0.15, hoa: [{ amount: 370, description: 'Condo fee' }] },
  '446BB': { mgmtPct: 0.10, hoa: [
    { amount: 373, description: 'Condo fee' },
    { amount: 230, description: 'Special assessment' }
  ]}
};
```

---

## Categories

```javascript
// Income
{ code: 'rent',         name: 'Rent Received' }
{ code: 'deposit',      name: 'Security Deposit' }
{ code: 'late_fee',     name: 'Late Fees' }
{ code: 'other_income', name: 'Other Income' }

// Expense
{ code: 'taxes',         name: 'Property Taxes' }
{ code: 'insurance',     name: 'Insurance' }
{ code: 'repairs',       name: 'Repairs & Maintenance' }
{ code: 'improvements',  name: 'Improvements' }
{ code: 'utilities',     name: 'Utilities' }
{ code: 'hoa',           name: 'HOA Fees' }
{ code: 'management',    name: 'Property Manager Commission' }
{ code: 'auto',          name: 'Auto' }
{ code: 'legal',         name: 'Legal & Professional' }
{ code: 'marketing',     name: 'Advertising / Marketing' }
{ code: 'other_expense', name: 'Other Expenses' }
```

---

## Cloudflare Worker (`cloudflare/src/worker.js`)

### Config (`wrangler.toml`)
```toml
name = "rentals-api"
main = "src/worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "RENTALS"
id = "75372b2a892343c8b45e3d8abafcbce3"
```

### CORS
All responses include:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Password
```
`OPTIONS` preflight returns 204. **If you add a new request header on the frontend, add it to `Access-Control-Allow-Headers` in the worker or browsers will block it.**

### Authentication
- All actions except `verify_password` require the `X-Password` request header to match the `ADMIN_PASSWORD` secret (set via `wrangler secret put`).
- Missing or wrong password → 401 response.
- `verify_password` action takes `{ password }` in the body (no header needed) and returns `{ ok: true/false }`.

### API — Single Endpoint
All calls: `POST /api/data` with JSON body `{ action, property, ...payload }`.

#### Transactions
| Action | Extra payload | Returns |
|---|---|---|
| `get_transactions` | — | `{ transactions: [...] }` |
| `add_transaction` | `transaction: { type, category, date, amount, description }` | `{ transaction: { id, ...} }` — id is a server-side UUID |
| `delete_transaction` | `id` | `{ success: true }` |

#### Annual Summaries (Historical)
| Action | Extra payload | Returns |
|---|---|---|
| `get_summaries` | — | `{ summaries: { "2023": { rent: X, ... }, ... } }` |
| `save_summary` | `year` (string), `data` (category → amount object) | `{ success: true }` |
| `delete_summary` | `year` (string) | `{ success: true }` |

#### Defaults (per-property saved amounts)
| Action | Extra payload | Returns |
|---|---|---|
| `get_defaults` | — | `{ defaults: { rent: X, management: Y, ... } }` |
| `save_defaults` | `defaults: { category: amount }` | `{ success: true }` — **merges** into existing, never overwrites all |

#### Depreciation (per-property config)
| Action | Extra payload | Returns |
|---|---|---|
| `get_depreciation` | — | `{ config: { costBasis, placedInService, purchaseDate } \| null }` |
| `save_depreciation` | `config: { costBasis, placedInService, purchaseDate }` | `{ success: true, config }` |

#### Maintenance Log (per-property)
| Action | Extra payload | Returns |
|---|---|---|
| `get_maintenance` | — | `{ entries: [...] }` |
| `save_maintenance` | `entries: [...]` | `{ success: true }` |
| `add_maintenance_entry` | `entry: { date, description, amount, category, isImprovement }` | `{ entry: { id, ... } }` |
| `update_maintenance_entry` | `id`, `entry: {...}` | `{ success: true }` |
| `delete_maintenance_entry` | `id` | `{ success: true }` |

#### Investment Return (per-property config)
| Action | Extra payload | Returns |
|---|---|---|
| `get_investment` | — | `{ config: { purchasePrice, purchaseDate, downPayment, ... } \| null }` |
| `save_investment` | `config: {...}` | `{ success: true }` |

#### Budget (global — not per-property)
| Action | Extra payload | Returns |
|---|---|---|
| `get_budget` | — | `{ data: { income: [...], expenses: { [cat]: [...] }, worksheets: { [id]: {...} } } }` |
| `save_budget` | `data: { income, expenses, worksheets }` | `{ success: true }` |

#### Solar ROI (global — not per-property)
| Action | Extra payload | Returns |
|---|---|---|
| `get_solar_config` | — | `{ config: { ... } \| null }` |
| `save_solar_config` | `config: {...}` | `{ success: true }` |
| `get_solar_entries` | — | `{ entries: [...] }` |
| `add_solar_entry` | `entry: { date, description, code, amount }` | `{ entry: { id, ... } }` |
| `update_solar_entry` | `id`, `entry: {...}` | `{ success: true }` |
| `delete_solar_entry` | `id` | `{ success: true }` |
| `get_solar_summaries` | — | `{ summaries: { [year]: { ... } } }` |
| `save_solar_summary` | `year`, `data` | `{ success: true }` |
| `delete_solar_summary` | `year` | `{ success: true }` |

#### Password
| Action | Extra payload | Returns |
|---|---|---|
| `verify_password` | `password` | `{ ok: true/false }` |

### KV Key Scheme
```
transactions:{property}    →  Array of transaction objects
summaries:{property}       →  { "2023": { rent: X, taxes: Y, ... }, ... }
defaults:{property}        →  { rent: X, management: Y, ... }
depreciation:{property}    →  { costBasis, placedInService, purchaseDate }
maintenance:{property}     →  Array of maintenance entry objects
investment:{property}      →  Investment config object
budget                     →  { income: [...], expenses: {...}, worksheets: {...} }
solar:config               →  Solar system config object
solar:entries              →  Array of solar entry objects
solar:summaries            →  { [year]: { ... } }
```
Valid properties: `6AL`, `95EB`, `446BB`, `731WO`

---

## Deploying the Worker

```bash
cd cloudflare/
npx wrangler deploy          # deploy worker code
```

### Setting the Password (one-time or to change it)
```bash
cd cloudflare/
npx wrangler secret put ADMIN_PASSWORD
# Prompts for the password — input is hidden, never stored in any file
```

The secret is stored encrypted in Cloudflare and available as `env.ADMIN_PASSWORD` in the worker at runtime. It is **not** in `wrangler.toml` or any committed file.

---

## Deploying the Frontend (GitHub Pages)

The `index.html` at the repo root is served directly by GitHub Pages from the `main` branch root. No build step.

```
Settings → Pages → Source: Deploy from branch → Branch: main / / (root)
```

Live URL: `https://99redder.github.io/rentals/`

To update: commit changes to `index.html` and push to `main`. GitHub Pages deploys automatically within ~1 minute.

---

## Development Notes

- **No build step** — edit `index.html` directly. Open it via a local file server (`npx serve .`) to test.
- **Test the worker locally** with `cd cloudflare && npx wrangler dev` (uses remote KV by default — add `--local` for local KV).
- **CORS errors** almost always mean either a new header wasn't added to `Access-Control-Allow-Headers`, or the worker hasn't been redeployed after a code change.
- **401 errors** mean `ADMIN_PASSWORD` secret hasn't been set on the worker, or the password entered at login is wrong.
- **Do not commit `node_modules/`** — it is gitignored. The `workerd` binary inside it exceeds GitHub's 100 MB file limit and will prevent pushing.
- Amounts are **always dollars**. Never store or display cents. The original codebase had a bug (`amount * 100`) that was fixed — do not reintroduce it.
- When rendering user-supplied strings into HTML, always use `escHtml()`. When rendering into HTML attributes, use `escAttr()`.
- The `budget` KV record stores `worksheets` alongside `income` and `expenses`. When loading budget state, all three must be pulled from `raw` — omitting any will lose data on the next save.

---

## Current 2026 Data Summary

| Property | Monthly Rent | Mgmt Fee | HOA | Self-Managed? |
|---|---|---|---|---|
| 6AL | $1,400 | — | — | Yes |
| 95EB | $1,750 | $262.50 (15%) | $370/mo (condo fee) | No |
| 446BB | $1,595 | $159.50 (10%) | $603/mo ($373 condo + $230 special assessment) | No |

Entries through April 2026 have been pre-loaded. Historical annual summaries (2009–2025) have not yet been entered and are pending.
