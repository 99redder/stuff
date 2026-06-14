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
├── mom-budget-phone.html       # Public read-only phone PWA for Mom Budget balances
├── mom-budget-manifest.webmanifest
├── mom-budget-sw.js            # Network-first PWA service worker
├── mom-budget-icon.svg / .png  # PWA icons
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

`index.html` is one large self-contained file (~8000+ lines). Use these search anchors:

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
Header buttons: [Deductions Tracker]  [Monthly Budget]  [Mom Budget]  [☀️ Solar]  [Tax Planning]  [💰 Savings]
```
- Property tabs are hidden when **All Properties**, **Deductions Tracker**, **Monthly Budget**, **Mom Budget**, **Solar**, **Tax Planning**, or **Savings** views are active.
- **731WO** is a primary residence — only shows Investment Return and Maintenance views (`PRIMARY_PROPERTIES` / `PRIMARY_VIEWS` constants).
- Switching property tabs reloads the current view for the new property.

### Views
| View | Key | Description |
|---|---|---|
| Current Year | `current-year` | YTD stat cards + transaction list with Edit/Delete |
| Tax Summary | `tax-summary` | Current-year category totals, print-ready |
| Investment Return | `investment-return` | IRR, equity, Zillow estimate, purchase config, federal + MD state/local capital gains estimates |
| Historical | `historical` | Annual summary table + Depreciation Schedule card |
| Maintenance | `maintenance` | Per-property maintenance log with improvement tracking |
| All Properties | `portfolio` | Combined stats + per-property breakdown + multi-year history |
| Monthly Budget | `budget` | Global monthly income/expense planner with property worksheets |
| Mom Budget | `mom-budget` | Global monthly assistance tracker with income template, fixed/reserve bills, groceries/gas/discretionary ledgers, and month math |
| Solar ROI | `solar` | Solar panel ROI tracking + billing cycle calculator |
| Tax Planning | `tax-planning` | Projected federal/MD/VA tax liability with live inputs |
| Deductions Tracker | `deductions` | Global itemized deductions log for the current year |
| Savings | `savings` | Account balances + annual obligations tracker with paid/unpaid checkboxes per year |

### State Model
```javascript
const state = {
  currentProperty: '6AL',       // active property tab
  currentView: 'current-year',  // active view
  password: '',                  // legacy only; runtime auth uses session cookie/token
  data: {
    '6AL':   { transactions: null, summaries: null, defaults: null, depreciation: null, maintenance: null, investment: null },
    '95EB':  { transactions: null, summaries: null, defaults: null, depreciation: null, maintenance: null, investment: null },
    '446BB': { transactions: null, summaries: null, defaults: null, depreciation: null, maintenance: null, investment: null },
    '731WO': { transactions: null, summaries: null, defaults: null, depreciation: null, maintenance: null, investment: null }
  },
  pendingDefaultPrompt: null,   // { category, amount } — shown after saving a transaction
  pendingMaintPrompt: null,     // { date, amount, description, category } — shown after expense save
  budget: null,                 // loaded once, global — { income, expenses, worksheets }
  momBudget: null,              // loaded once, global — { template, months }
  solar: { config: null, entries: null, summaries: null },
  savings: null                 // loaded once, global — { accounts, obligations, payments }
};
```
`null` means not yet fetched. `ensureLoaded(property, key)` fetches on demand and caches in `state.data`.

### Key JS Functions
| Function | Purpose |
|---|---|
| `ensureLoaded(prop, key)` | Lazy-loads one data type for one property; no-ops if already cached |
| `callApi(body)` | All API calls go through here — sends session token/cookie, handles 401 |
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
| `renderDeductions()` | Deductions tracker view |
| `renderSavings()` | Savings view — account balances + annual obligations |
| `renderMomBudget()` | Mom Budget view — global monthly assistance tracker |
| `showBrandedNotice({title,message,type,confirmLabel,onConfirm})` | Branded confirmation modal used by all delete dialogs (replaces native `confirm()`); pass `type:'danger'` for red ⚠️ styling, `confirmLabel` to customize the button text. |
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
Modals exist in the HTML (outside `<main>`):
- **Delete modal** (`#delete-modal`) — step 1: shows entry detail, "Yes, Delete" button (used for transaction delete only)
- **Delete double-confirm** (`#delete-modal-2`) — step 2: "Delete Forever" (darker red)
- **Branded notice modal** (`#notice-modal`) — generic confirmation/info modal driven by `showBrandedNotice()`. Used for ALL other delete confirmations (historical year summary, maintenance entry, solar entry/summary, savings obligation) so the app never falls back to the browser's native `confirm()`. Pass `type:'danger'` for red styling, `confirmLabel` to customize the action button.
- **Deductions delete modal** (`#ded-delete-modal`) — dedicated detail-rich delete confirmation for deductions
- **Edit modal** (`#edit-modal`) — pre-filled form for editing a transaction
- **Property income worksheet** (`#budget-worksheet-modal`) — calculates net monthly income for 95EB/6AL/446BB; body rendered dynamically by `_renderBudgetWorksheetModal()`
- **Solar billing cycle calculator** (`#solar-calc-modal`) — estimates electricity cost without solar

All modals close on Escape key or clicking the backdrop.

**Rule:** Never introduce native `confirm()` or `alert()` for destructive actions. Use `showBrandedNotice({ type: 'danger', title, message, confirmLabel: 'Yes, Delete', onConfirm })` so the UX stays consistent. Only the maintenance seed-data prompt currently uses native `confirm()`, and it's a load action, not a delete.

### Password Gate
On load, `sessionStorage` is checked for `rentals_auth = '1'`. If not set, the entire app UI is hidden and a login form is shown. On successful login:
- `sessionStorage.setItem('rentals_auth', '1')` — persists for the browser session
- Worker sets an HttpOnly `rentals_session` cookie and returns a short-lived `sessionToken` fallback for browsers that block cross-site cookies
- `sessionStorage.setItem('rentals_session_token', token)` stores the fallback session token; the raw password is not stored after login

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

### Mom Budget

Global view (not per-property) for tracking Red's mother's monthly assistance budget. Frontend state is `state.momBudget`; Worker actions are `get_mom_budget` / `save_mom_budget`; KV key is `mom_budget`.

**Primary anchors in `index.html`:**
- Section starts at `// ── View: Mom Budget`
- Defaults live in `MOM_BUDGET_DEFAULT`
- Main render path is `renderMomBudget()` → `_renderMomBudgetHtml()`
- Main math helper is `mbCalcMonth(monthKey)`
- Save helper is `_saveMomBudget()`

**Data shape (`state.momBudget`):**
```javascript
{
  template: {
    income: [
      { id, name, amount, locked }
    ],
    fixed: [
      {
        id,
        name,
        amount,          // monthly reserve amount
        locked,
        frequency,       // 'monthly', 'semiannual', 'yearly', or 'reserve'
        dueMonth,        // 1-12 for semiannual/yearly; ignored for reserve-only
        paymentAmount    // cash due when scheduled; 0 for reserve-only
      }
    ],
    variable: {
      groceries: 870,
      gas: 120,
      discretionary: 500
    },
    variableLocks: {
      groceries: false,
      gas: false,
      discretionary: false
    }
  },
  months: {
    'YYYY-MM': {
      fixedPaid: { [fixedId]: true },
      fixedActual: { [fixedId]: number },
      groceries: [{ id, date, amount, orderNumber }],
      gas: [{ id, date, amount, orderNumber }],
      discretionary: [{ id, date, amount, name }],
      otherExpenses: [{ id, date, amount, name }]
    }
  }
}
```

**Current default template:**
- Income: Social Security, 401k Distribution
- Fixed/reserve list: Rent, Internet, Cell Phone, Water / Sewer / Trash, Electric, Nat Gas / Heat, Car Repairs, Car Insurance, Car Registration, CoPays / Prescriptions, Netflix, BritBox
- Variable budgets: Groceries, Gas, Discretionary

**Fixed bill kinds:**
- `MB_VARIABLE_FIXED_BILL_IDS = new Set(['electric', 'water', 'gas-heat'])`
- Variable fixed bills: Electric, Water / Sewer / Trash, Nat Gas / Heat
- Fixed fixed bills: Rent, Cell Phone, Car Insurance, Internet, Netflix, BritBox, Car Registration, and other non-variable fixed items
- Fixed rows render the scheduled/budgeted amount as read-only text. Variable rows render an editable paid-amount input.
- Variable fixed bills can generate automatic overage rows when paid above budget; fixed fixed bills do not.

**Reserve bills:**
- `mbIsReserveBill(item)` returns true when `item.frequency && item.frequency !== 'monthly'`
- Reserve bills are exactly the rows affected by the `Mark Reserve Bills Paid` button in the Fixed Bills card.
- Those rows display a `Reserve Bill` badge, using the same predicate as the button.
- Frequencies:
  - `monthly`: due every month
  - `yearly`: due once in `dueMonth`
  - `semiannual`: due in `dueMonth` and 6 months later
  - `reserve`: reserve-only bucket; never scheduled as due
- Car Repairs and Car Registration migrate to `frequency: 'reserve'`.

**Mom Budget tab layout:**
- Header row: back button, `Mom Budget` title, month input, existing-month dropdown
- Top summary row:
  - `Monthly Income`
  - prominent `Overall Spending Left`
- Second summary row:
  - `Groceries Left`
  - `Gas Left`
  - `Discretionary Left`
- Annual summary: collapsed by default behind an Expand/Minimize button; open state persists in `localStorage` key `rentals_mom_budget_year_stats_open`
- Main layout:
  - Left column cards: Fixed Bills, Groceries, Gas, Discretionary, Other Expense Overages
  - Right sticky column: Month Math and Monthly Template

**Top card formulas:**
```javascript
overallSpendingRemaining =
  base.groceries + base.gas + base.discretionary
  - groceriesSpent - gasSpent - discretionarySpent - otherOverages;

otherOverages = manualOtherExpenses + fixedBillOverages;

discretionaryAdjusted =
  Math.max(0, base.discretionary - groceryOver - gasOver - otherOverages);
```

`Overall Spending Left` shows the selected month in italic text and the note: `Groceries + gas + discretionary, including other overage amounts`.

**Ledger cards:**
- Groceries: date + amount rows, ordered with `orderNumber`
- Gas: date + amount rows, ordered with `orderNumber`
- Discretionary: date + description + amount rows. Note at top says discretionary includes non-grocery purchases, prescription copays, and overages from other budget areas.
- Other Expense Overages: no manual Add row. It auto-populates fixed bill overages. Legacy/manual rows are still included if already present in saved data.

**Monthly Template card:**
- Income template rows and fixed template rows are edited here.
- Add Income/Add Expense use the branded Mom Budget modal, not inline add rows.
- Template rows have lock/unlock controls.
- Fixed template rows show compact italic schedule text under the title instead of frequency/month dropdowns.
- Monthly reserve amount remains editable unless locked.

**Normalization/migrations in `mbNormalize(raw)`:**
- Ensures all `template`, `months`, arrays, locks, and variable budgets exist.
- Backfills fixed item `frequency`, `dueMonth`, and `paymentAmount` from defaults.
- Migrates old fixed Gas into the new monthly `gas` ledger, then removes old fixed Gas paid/actual state.
- Migrates Car Repairs and Car Registration to reserve-only.
- Ensures `variableLocks` exists.

### Mom Budget Phone PWA

Separate public read-only page for an Android/Samsung Galaxy phone:

- File: `mom-budget-phone.html`
- Live URL after GitHub Pages deploy: `https://99redder.github.io/rentals/mom-budget-phone.html`
- Manifest: `mom-budget-manifest.webmanifest`
- Service worker: `mom-budget-sw.js`
- Icons: `mom-budget-icon-192.png`, `mom-budget-icon-512.png`, plus source SVG

This page has no password gate and no editing controls. It is meant to be installed to Red's mother's phone as a simple PWA that shows:

- Current month `Overall Spending Left` prominently
- `Groceries Left`
- `Gas Left`
- `Discretionary Left`
- Optional collapsed year status showing allocated, used, and under/over allocated

The page fetches only `get_mom_budget_public_summary`, a public Worker action that returns precomputed read-only numbers. It must never call `get_mom_budget`, `save_mom_budget`, or any authenticated/editing action.

The service worker is intentionally network-first and calls `registration.update()` on launch so the installed PWA gets the newest page/assets when opened. If changing the phone PWA files, bump `CACHE_NAME` in `mom-budget-sw.js` if cached asset behavior matters.

### Savings View

Global view (not per-property) for tracking liquid account balances against the year's annual obligations.

**Layout:** Stats bar on top (annual total, paid so far, outstanding, liquid in accounts, coverage %, YTD progress bar) — accounts card on left, obligations table on right.

**Data shape (`state.savings`):**
```javascript
{
  accounts: { robinhood: 0, ibkr: 0 },   // manually edited dollar balances
  obligations: [
    { id: 'uuid', name: '6AL Taxes', amount: 7400, paymentsPerYear: 2, kind: 'recurring', note: 'Paid twice a year' },
    { id: 'uuid', name: 'Mom Assistance Fund', amount: 3500, paymentsPerYear: 1, kind: 'static', note: 'Target: $25,000' },
    ...
  ],
  payments: {
    "2026": {                            // keyed by year — Jan 1 starts a fresh empty object
      "<obligation-id>": [true, false],  // length = paymentsPerYear (1 or 2)
    }
  }
}
```

**Year reset:** Lookups use `payments[String(CURRENT_YEAR)] || {}`. When the year flips, the lookup falls through to an empty object and every obligation renders unpaid. Past-year records are preserved in KV for history — never overwrite or delete them on rollover.

**Default obligations:** First-time visit seeds 32 obligations from `DEFAULT_SAVINGS_OBLIGATIONS` (the spreadsheet supplied 2026-05-11). Users can add/edit/delete entries and adjust `amount` / `paymentsPerYear` / `kind` / `note` freely.

**`kind` field:** Each obligation has a `kind`: `'recurring'` (default) or `'static'`.
- `'recurring'` — fixed annual bills paid in 1 or 2 installments (taxes, insurance, etc.). Freq column shows `1× / yr` or `2× / yr`.
- `'static'` — ongoing savings buckets contributed to each year (Mom Assistance Fund, 6AL Reno & Maintenance, etc.). Freq column shows a `Static` pill. Internally treated as a single annual slot so it still rolls into outstanding/paid totals, but the paid-checkbox label reads "Fund/Funded" rather than "Paid".

On load, if no obligation has a `kind` field, a one-time migration backfills `kind` from `DEFAULT_SAVINGS_OBLIGATIONS` by name match (so the originally-seeded records pick up the static designation without manual editing).

**Outstanding math:** Each obligation has `paymentsPerYear` "slots." Each slot = `amount / paymentsPerYear`. Outstanding = sum across all obligations of `slotAmount × (paymentsPerYear − paidCount)`.

**Sort:** `_savSort` controls obligation order in the table — `default` (input order), `amount` (largest first), `alpha` (A→Z by name), `status` (unpaid/highest-outstanding first).

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

# Per-IP rate limiter for the public phone endpoint (must be the
# first-class [[ratelimits]] key — the [[unsafe.bindings]] form deploys
# but never enforces the limit, so .limit() always returns success:true).
[[ratelimits]]
name = "PUBLIC_RATELIMIT"
namespace_id = "1001"
simple = { limit = 60, period = 60 }
```

### CORS
All responses include:
```
Access-Control-Allow-Origin: https://99redder.github.io
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Password, X-Session
Access-Control-Allow-Credentials: true
```
`OPTIONS` preflight returns 204. **If you add a new request header on the frontend, add it to `Access-Control-Allow-Headers` in the worker or browsers will block it.**

### Authentication
- `verify_password` rate-limits failed attempts, sets a short-lived HttpOnly session cookie, and returns a session-token fallback.
- All actions except `verify_password` require either the session cookie or `X-Session` token. `X-Password` is kept only as a temporary legacy fallback.
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

#### Mom Budget (global — not per-property)
| Action | Extra payload | Returns |
|---|---|---|
| `get_mom_budget` | — | `{ data: { template, months } }` |
| `save_mom_budget` | `data: { template, months }` | `{ success: true }` — full overwrite of the `mom_budget` KV record |
| `get_mom_budget_public_summary` | optional `month: "YYYY-MM"` | `{ monthKey, monthLabel, updatedAt, month: {...}, year: {...} }` — public unauthenticated read-only summary for `mom-budget-phone.html`; returns calculated numbers only, never raw editable records. Guarded by a per-IP rate limit (`env.PUBLIC_RATELIMIT`, 60 req/60s → `429`, fails open) and a ~45s edge cache (synthetic GET cache key keyed by month, `Cache-Control: public, s-maxage=45`). Both are invisible to the phone and cap bot/flood abuse. |

#### Deductions (global — not per-property)
| Action | Extra payload | Returns |
|---|---|---|
| `get_deductions` | — | `{ deductions: [ { id, date, description, category, amount, locked }, ... ] }` |
| `save_deductions` | `data: [ {...} ]` | `{ success: true }` — replaces the full array |

#### Tax Planning (global, per-year)
| Action | Extra payload | Returns |
|---|---|---|
| `get_tax_planning` | `year` (4-digit string) | `{ data: { ... } }` |
| `save_tax_planning` | `year`, `data: {...}` | `{ success: true }` |

#### Savings (global — not per-property)
| Action | Extra payload | Returns |
|---|---|---|
| `get_savings` | — | `{ data: { accounts, obligations, payments } }` |
| `save_savings` | `data: { accounts, obligations, payments }` | `{ success: true, data }` — full overwrite of the `savings` KV record. The worker sanitizes: clamps `accounts.{robinhood,ibkr}` to numbers, coerces `paymentsPerYear` to `1` or `2`, drops any year key that isn't a 4-digit string. |

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
mom_budget                 →  { template: { income, fixed, variable, variableLocks }, months: { [YYYY-MM]: {...} } }
solar:config               →  Solar system config object
solar:entries              →  Array of solar entry objects
solar:summaries            →  { [year]: { ... } }
deductions                 →  Array of deduction entry objects
tax_planning:{year}        →  Tax planning inputs for that year
savings                    →  { accounts: {robinhood, ibkr}, obligations: [...], payments: { [year]: { [oid]: [bool, ...] } } }
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

---

## Recent Updates

### 2026-06-14 — Mom Budget phone PWA: freshness + abuse guards

- **Always-fresh phone data** — `mom-budget-phone.html` now re-fetches on every foreground (`visibilitychange`/`focus`/`online` + bfcache `pageshow`), not just on first load, since an installed PWA is resumed from memory without reloading. Added an in-flight guard, a wake-event throttle, and a failed-refresh path that keeps the last numbers but flags them as possibly out of date instead of silently showing stale figures. Bumped `mom-budget-sw.js` `CACHE_NAME` to `v2`.
- **Public endpoint abuse guards** — `get_mom_budget_public_summary` is now protected by a per-IP rate limit (`[[ratelimits]]` binding `PUBLIC_RATELIMIT`, 60 req/60s → `429`, fails open so the phone never breaks) and a ~45s Cloudflare edge cache (synthetic GET cache key per month). Both are invisible to the phone, which fetches only a few times per session. Volumetric/DNS DDoS is already absorbed by Cloudflare's network. **Note:** the rate limiter only works via the first-class `[[ratelimits]]` config key, not `[[unsafe.bindings]]`.

### 2026-06-14 — Mom Budget

- **Mom Budget top cards** — top row now has `Monthly Income` plus a prominent `Overall Spending Left` card. Overall spending left is groceries + gas + discretionary budget minus groceries/gas/discretionary spending and other/fixed overage amounts. Groceries Left, Gas Left, and Discretionary Left moved to a second three-card row.
- **Annual status collapsed** — the `YYYY Annual Status` stat row is collapsed by default and controlled by an Expand/Minimize button backed by `localStorage`.
- **Gas tracker split out** — Gas is now a variable budget + monthly ledger like Groceries. Old fixed Gas paid/actual records migrate into the gas ledger on normalization.
- **Discretionary behavior** — Discretionary includes non-grocery purchase items, prescription copays, and overages from other areas. Its budget is adjusted down by grocery overages, gas overages, and other/fixed overages.
- **Other Expense Overages** — manual Add row removed. The card auto-populates when variable fixed bills are marked paid above their budgeted amount; legacy manual rows still render if present in saved data.
- **Fixed Bills card** — rows show Fixed/Variable badges. Variable rows are Electric, Water / Sewer / Trash, and Nat Gas / Heat and keep editable paid amount inputs. Fixed rows show read-only amount text.
- **Reserve bills** — rows included by `Mark Reserve Bills Paid` show a `Reserve Bill` badge. The badge and bulk action both use `mbIsReserveBill(item)`.
- **Fixed template rows** — compact card-style rows show italic schedule text under the title and only expose lock + monthly reserve amount controls.

### 2026-05-11 — Savings

- **Savings view added** (`💰 Savings` header button) — global view with manual account balances (Robinhood Checking, IBKR Individual Brokerage) on the left and the year's annual obligations on the right. Stats bar at top shows total annual, paid so far, outstanding, liquid coverage %, and a YTD progress bar. Each obligation has 1 or 2 paid checkboxes (H1/H2 for twice-a-year items). Payments are keyed by year so Jan 1 auto-resets to all-unpaid; past years stay in KV.
- **Obligation sorting** — sort buttons in the Savings card header: Default (input order), Amount (largest first), A→Z, Unpaid (highest outstanding first). Sort state is in-memory only (not persisted).
- **Default obligations seed** — `DEFAULT_SAVINGS_OBLIGATIONS` (32 items, sourced from the 2026 goal-budget spreadsheet) is auto-seeded on first visit if the `savings` KV record has no obligations.
- **Branded delete modals** — all delete confirmations now go through `showBrandedNotice({ type:'danger', ... })` instead of native `confirm()`. Affected flows: historical year summary, maintenance entry, solar entry, solar summary, savings obligation. `showBrandedNotice` accepts a new `confirmLabel` option (defaults to "Yes, Delete" when type is `danger`).
- **Worker API additions** — `get_savings` / `save_savings` (KV key `savings`). The save handler sanitizes account balances, coerces `paymentsPerYear` to 1 or 2, validates year keys as 4-digit strings, and clamps boolean payment arrays to length ≤ 2.
