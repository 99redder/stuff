# STUFF — CLAUDE.md

Developer reference for AI agents working on this project.

---

## What This Is

A single-page property management app for tracking rental income, expenses, and depreciation across three rental properties (**6AL**, **95EB**, **446BB**) plus two primary residences (**731WO**, **4781MC** / 4781 MC).

Deployed as:
- **Frontend**: GitHub Pages — static `index.html` served from `https://99redder.github.io/stuff/`
- **API**: Cloudflare Worker — `https://rentals-api.99redder.workers.dev`

There is no build step. The entire frontend is one self-contained `index.html` (HTML + CSS + JS). Do not introduce bundlers, frameworks, or separate JS/CSS files unless explicitly asked.

---

## File Structure

```
stuff/
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
Property tabs:  [6AL]  [95EB]  [446BB]  [731WO]  [4781MC]
View tabs:      [Current Year]  [Tax Summary]  [Investment Return]  [Historical]  [Maintenance]  [Move-In Purchases]  [All Properties]
Header buttons: [Deductions Tracker]  [Monthly Budget]  [Mom Budget]  [☀️ Solar]  [Tax Planning]  [💰 Savings]  [Net Worth]  [Cash Flow]
```
- Property tabs are hidden for the global header views (`GLOBAL_HEADER_VIEWS`: `tax-planning`, `net-worth`, `budget`, `cash-flow`, `mom-budget`, `solar`, `deductions`, `savings`) and for **All Properties**.
- **731WO** and **4781MC** are primary residences — only show Investment Return and Maintenance views (`PRIMARY_PROPERTIES` / `PRIMARY_VIEWS` constants).
- **Move-In Purchases** is available only on **4781MC** (`MOVE_IN_PURCHASE_PROPERTY`).
- Switching property tabs reloads the current view for the new property.

### Views
| View | Key | Description |
|---|---|---|
| Current Year | `current-year` | YTD stat cards + transaction list with Edit/Delete |
| Tax Summary | `tax-summary` | Current-year category totals, print-ready |
| Investment Return | `investment-return` | IRR, equity, closeout sale estimate, purchase config, federal + MD state/local capital gains estimates |
| Historical | `historical` | Annual summary table + Depreciation Schedule card |
| Maintenance | `maintenance` | Per-property maintenance log with improvement tracking |
| All Properties | `portfolio` | Combined stats + per-property breakdown + multi-year history |
| Monthly Budget | `budget` | Global monthly income/expense planner with property worksheets; includes the collapsible **Fair Share** section (Mom's cost-sharing contribution, derived from the budget's own expenses) |
| Mom Budget | `mom-budget` | Global monthly assistance tracker with income template, fixed/reserve bills, groceries/gas/discretionary ledgers, and month math |
| Solar ROI | `solar` | Solar panel ROI tracking + billing cycle calculator |
| Tax Planning | `tax-planning` | Projected federal + Maryland state/local tax liability with live inputs; includes the **AGI Threshold Watch** card (`#tp-warnings`, built by `tpAgiWarningsHtml()`) flagging 2026 MFJ phase-outs with source links |
| Deductions Tracker | `deductions` | Global itemized deductions log for the current year |
| Savings | `savings` | Account balances + annual obligations tracker with paid/unpaid checkboxes per year |
| Move-In Purchases | `move-in-purchases` | **4781MC only** — move-in shopping list with per-item categories, price totals, and an edit mode |
| Net Worth | `net-worth` | Assets minus liabilities — linked bank balances, manual items, vehicles, property equity, treasury portfolio; includes the bank-sync warning banner + **Reconnect** flow |

### State Model
```javascript
const state = {
  currentProperty: '6AL',       // active property tab
  currentView: 'current-year',  // active view
  password: '',                  // legacy only; runtime auth uses session cookie/token
  data: {
    // every property carries the same keys; moveInPurchases/moveInCategories are only used by 4781MC
    '6AL':   { transactions: null, summaries: null, defaults: null, depreciation: null, maintenance: null, investment: null, moveInPurchases: null, moveInCategories: null },
    '95EB':  { ...same },
    '446BB': { ...same },
    '731WO': { ...same },
    '4781MC': { ...same }
  },
  pendingDefaultPrompt: null,   // { category, amount } — shown after saving a transaction
  pendingMaintPrompt: null,     // { date, amount, description, category } — shown after expense save
  budget: null,                 // loaded once, global — { income, expenses, worksheets }
  momBudget: null,              // loaded once, global — { template, months }
  solar: { config: null, entries: null, summaries: null },
  savings: null,                // loaded once, global — { accounts, obligations, payments }
  netWorth: null                // loaded once, global — see Net Worth section
};
// Note: budget also carries a `fairShare` sub-object — { householdSize, roundDollar, shared:{[itemId]:bool} } —
// for the Fair Share section embedded in the Monthly Budget view (saved inside the `budget` record).
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
| `renderInvestmentReturn()` | IRR/equity/closeout sale view |
| `renderBudget()` | Monthly budget planner |
| `renderSolar()` | Solar ROI view |
| `renderTaxPlanning()` | Tax planning view |
| `renderDeductions()` | Deductions tracker view |
| `renderSavings()` | Savings view — account balances + annual obligations |
| `renderMomBudget()` | Mom Budget view — global monthly assistance tracker |
| `fsRenderCard()` | Fair Share section embedded in the budget view — Mom's cost-sharing contribution, derived from budget expenses (`fsCalc()` does the math) |
| `showBrandedNotice({title,message,type,confirmLabel,onConfirm})` | Branded confirmation modal used by all delete dialogs (replaces native `confirm()`); pass `type:'danger'` for red ⚠️ styling, `confirmLabel` to customize the button text. |
| `openBudgetWorksheetModal(id)` | Opens the property income worksheet for a budget income item |
| `calcDepreciationSchedule(costBasis, placedInService)` | MACRS 27.5-yr straight-line, mid-month convention |
| `fmt(amount)` | Format dollar amount with 2 decimal places |
| `fmtShort(amount)` | Abbreviated format ($1.4k, $22k, $1.43m) for tables |
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
- **Fair Share agreement** (`#fs-agreement-modal`) — generates a print-ready Household Cost-Sharing Agreement from live Fair Share data; body rendered by `_renderFsAgreementBody()`, printed via `fsPrintAgreement()` (popup window + `print()`)
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
        paymentAmount,   // cash due when scheduled; 0 for reserve-only
        auto             // true ONLY for the 'fair-share' line (read-only, value synced from the budget)
      }
    ],
    variable: {
      discretionary: 500
    },
    variableLocks: {
      discretionary: false
    },
    fairShareMigrated,     // one-time flag — wrapped household bills already removed
    carStreamingTrimmed    // one-time flag — car/streaming bills already removed
  },
  months: {
    'YYYY-MM': {
      fixedPaid: { [fixedId]: true },
      fixedActual: { [fixedId]: number },
      discretionary: [{ id, date, amount, name }],
      otherExpenses: [{ id, date, amount, name }]
    }
  },
  rmd: { balance }   // 401(k) RMD calculator input (balance only; birth date is a fixed constant)
}
```
Now that the mother lives with the family, her household bills are wrapped into a single **auto-synced `fair-share` fixed line** whose monthly amount is pulled live from the Monthly Budget's Fair Share section (`mbSyncFairShare()` → `fsCalc().herShare`, run in `renderMomBudget` after `ensureBudgetLoaded()`). Groceries were folded into that household share, and **Gas was removed entirely (she has no car)** — so the only variable budget left is Discretionary. She effectively tracks just **Fair Share, Discretionary, and overages**.

**Current default template:**
- Income: Social Security, 401k Distribution
- Fixed/reserve list: **Fair Share (household)** (auto-synced), CoPays / Prescriptions
- Variable budgets: Discretionary (Gas removed — she has no car; Cell Phone removed — she's on the family plan)
- The wrapped-away household bills (Rent, Internet, Water / Sewer / Trash, Electric, Nat Gas / Heat) and the Groceries budget were removed when she moved in with the family — their cost is represented by the single Fair Share line. Car Insurance / Car Repairs / Car Registration / Netflix / BritBox were also dropped (no longer tracked).

**Fixed bill kinds:**
- `MB_VARIABLE_FIXED_BILL_IDS = new Set(['electric', 'water', 'gas-heat'])` — these ids are no longer in the default template (wrapped into Fair Share), but the set and its variable-paid-amount/overage machinery remain for any custom variable bills.
- The `fair-share` line is `auto: true`: it renders read-only everywhere (no editable amount, lock, or delete) and its value comes from the budget; `mbDeleteTemplateItem` refuses to delete it.
- Fixed rows render the scheduled/budgeted amount as read-only text. Variable rows render an editable paid-amount input.
- Variable fixed bills can generate automatic overage rows when paid above budget; fixed fixed bills do not.

**Reserve bills:**
- `mbIsReserveBill(item)` returns true when `item.frequency && item.frequency !== 'monthly'`
- Such rows display a `Reserve Bill` badge. (The bulk **Mark Reserve Bills Paid** button was removed — the remaining default bills are all monthly, so there are no reserve bills. The predicate/badge remain for any custom non-monthly bill.)
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
  - `Discretionary Left`
- Annual summary: collapsed by default behind an Expand/Minimize button; open state persists in `localStorage` key `rentals_mom_budget_year_stats_open`
- Main layout:
  - Left column cards: Fixed Bills, Discretionary, Other Expense Overages, **401(k) Minimum Distribution (RMD)**
  - Right sticky column: Month Math and Monthly Template

**401(k) RMD calculator** (`mbRmdCard()` / `mbCalcRmd()` / `mbUpdateRmd()`): card at the bottom of the left column. Her birth date is a **fixed constant** (`MOM_RMD_BIRTH_YEAR = 1952`, born Aug 12, 1952; retired, no spouse → IRS Uniform Lifetime Table applies), so the **only editable input is the prior Dec 31 balance**, stored in `state.momBudget.rmd.balance` and saved with the record. `RMD = balance ÷ RMD_UNIFORM_LIFETIME[ageThisYear]` (IRS Uniform Lifetime Table, 2022+); shows yearly minimum + monthly equivalent. `mbRmdStartAge(birthYear)` applies SECURE Act 2.0 start ages (73 for 1951–1959, 75 for 1960+) and the card shows a "not required yet" note if below it. App-only — not surfaced on the phone PWA.

**Top card formulas:**
```javascript
overallSpendingRemaining =
  base.discretionary
  - discretionarySpent - otherOverages;

otherOverages = manualOtherExpenses + fixedBillOverages;

discretionaryAdjusted =
  Math.max(0, base.discretionary - otherOverages);
```

`Overall Spending Left` shows the selected month in italic text and the note: `Discretionary, including other overage amounts`.

**Ledger cards:**
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
- **One-time `fairShareMigrated` migration:** removes the wrapped household bills (`rent`, `internet`, `water`, `electric`, `gas-heat`) from `template.fixed`, then ensures the auto-synced `fair-share` line exists (prepended). Also `delete`s `template.variable.groceries` (groceries folded into Fair Share).
- **One-time `carStreamingTrimmed` migration:** removes `car-insurance`, `car-repairs`, `registration`, `netflix`, `britbox` from `template.fixed` (no longer tracked).
- **One-time `cellTrimmed` migration:** removes `cell` (she's on the family cell plan). Default fixed list is now just `fair-share`, `medical`.
- **Gas removed entirely:** `delete`s `template.variable.gas`; `mbCalcMonth`/`mbTemplateTotals` drop gas from all formulas; Gas Left stat, Gas ledger card, and Gas template row are gone. Old month `gas[]` ledger entries are left in storage but unused.
- Backfills fixed item `frequency`, `dueMonth`, and `paymentAmount` from defaults.
- Migrates old fixed Gas into the new monthly `gas` ledger, then removes old fixed Gas paid/actual state.
- Migrates Car Repairs and Car Registration to reserve-only.
- Ensures `variableLocks` exists.
- The `fair-share` line's amount is **not** set here — `renderMomBudget` calls `mbSyncFairShare()` after `ensureBudgetLoaded()` to pull the live value from `fsCalc()`.

### Mom Budget Phone PWA

Separate public read-only page for an Android/Samsung Galaxy phone:

- File: `mom-budget-phone.html`
- Live URL after GitHub Pages deploy: `https://99redder.github.io/stuff/mom-budget-phone.html`
- Manifest: `mom-budget-manifest.webmanifest`
- Service worker: `mom-budget-sw.js`
- Icons: `mom-budget-icon-192.png`, `mom-budget-icon-512.png`, plus source SVG

This page has no password gate and no editing controls. It is meant to be installed to Red's mother's phone as a simple PWA that shows:

- Current month `Overall Spending Left` prominently
- `Fair Share` — her monthly household contribution (read-only, computed live from the family budget)
- `Discretionary Left`
- Optional collapsed year status showing allocated, used, and under/over allocated

The page fetches only `get_mom_budget_public_summary`, a public Worker action that returns precomputed read-only numbers. It must never call `get_mom_budget`, `save_mom_budget`, or any authenticated/editing action. **The worker keeps its own parallel copy of the Mom Budget math** (`normalizeMomBudget` / `momBudgetTemplateTotals` / `calcMomBudgetMonth`) — when changing the frontend's `mbCalcMonth`/template, mirror it here or the phone shows stale numbers. (Groceries and Gas were removed from both.) The `month.fairShare` field is computed by `calcFairShareFromBudget(budget)` — a mirror of the frontend `fsCalc()` (shared budget expenses ÷ household size) that reads the `budget` KV record directly, so it stays accurate even if the `mom_budget` record's fair-share line is stale. `FS_SHARED_CAT_DEFAULTS` in the worker must match index.html.

The service worker is intentionally network-first and calls `registration.update()` on launch so the installed PWA gets the newest page/assets when opened. If changing the phone PWA files, bump `CACHE_NAME` in `mom-budget-sw.js` if cached asset behavior matters.

### Savings View

Global view (not per-property) for tracking liquid account balances against the year's annual obligations.

**Layout:** Funding summary cards on top (surplus/shortfall against total annual obligations, available accounts, outstanding, annual total) — accounts card on left, obligations table on right. Outstanding remains a simple number; there is no paid-progress bar.

**Data shape (`state.savings`):**
```javascript
{
  accounts: { robinhoodChecking: 0, robinhoodBrokerage: 0 },   // server-owned — both pulled live from the linked bank connection (Plaid), never client-edited
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

### Move-In Purchases View (4781MC only)

Shopping list for the 4781 MC new build — items, estimated prices, notes, product links, purchase status, and a per-item **category**. Gated to `MOVE_IN_PURCHASE_PROPERTY` (`'4781MC'`); `renderMoveInPurchases()` redirects to the property's default view for any other property.

**Primary anchors in `index.html`:**
- Section starts at `// ── View: Move-In Purchases`
- Category helpers/modal at `// ── Move-In Purchase Categories`
- CSS lives in the stylesheet under `/* ── Move-In Purchases` — all `.mip-*` classes
- Render path: `renderMoveInPurchases()` → `renderMoveInPurchasesSection(prop)` → `mipTableHtml()` / `mipRowHtml()`

**Constants:**
```javascript
const MOVE_IN_PURCHASE_PROPERTY = '4781MC';
const MOVE_IN_PURCHASE_DEFAULT_DATE = '2027-02-01';
const MOVE_IN_CATEGORIES_DEFAULT = ['Living Room','Basement','Craft Room','Office','Kitchen / Dining Room','Ellie','Mom','Other'];
const MOVE_IN_UNCATEGORIZED = 'Other';   // fallback for items with no category
const MOVE_IN_CATEGORY_ICONS = { 'Living Room':'🛋️', Basement:'🧰', 'Craft Room':'🎨', Office:'💼', 'Kitchen / Dining Room':'🍽️', Ellie:'🧸', Mom:'👵', Other:'📦' };
```
Icons are **only** rendered in the category-sort group headers (`moveInCategoryIcon()`); custom categories fall back to 🏷️.

**Entry shape** (one per purchase, server-assigned `id`):
```javascript
{ id, item, date, estimatedPrice, productLink, notes, purchased, category }
```

**View state (module-level, not persisted):**
- `_mipSort` — `'category'` (default) · `'name'` · `'price-desc'` · `'price-asc'`; options listed in `MIP_SORTS`
- `_mipEditMode` — when **off**, the category renders as a read-only pill and per-item Edit/✕ are hidden; when **on**, a category `<select>` and Edit/✕ appear plus the **⚙ Categories** button
- `_mipSearch` — free-text filter over item name, notes, and category (`mipFilterEntries`). `mipSetSearch()` re-renders and then restores focus/caret, since the whole view is re-rendered per keystroke.

**Layout:** header (title + `N items · N purchased` meta + `+ Add Purchase`) → progress bar (% of estimated total purchased) → toolbar strip (search · segmented Sort control · Edit / Categories) → table. Columns are `Item | Category | Est. Price`; the Item column carries `width:100%` so it absorbs slack and the other two hug the right edge. Card is capped at `760px`, widened to `900px` in edit mode so the selects and action buttons don't force horizontal scrolling.

**Category sort** groups rows by category in `moveInCategories()` order with a subtotal header row per group; within a group items sort **price high → low** with purchased items last.

**Categories** are stored per-property and are fully editable via the branded `#mip-categories-modal` (`openMoveInCategoriesModal()`): add, rename, delete. Renaming cascades to every item in that category and deleting reassigns its items to `Other` — both persist the item changes via the bulk `save_move_in_purchases` action. `moveInCategories(prop)` returns the stored list plus any category referenced by an existing item, so nothing renders orphaned.

> **Gotcha:** a global `input, select, textarea { width: 100% }` rule squeezes any inline `<select>` inside a table cell and clips its text. The row category select sets `width:auto` (`.mip-cat-select`) to size to its widest option.

---

### Net Worth: linked bank accounts

The Net Worth view combines manual items, vehicles, property equity, a treasury portfolio, and balances pulled from linked bank accounts. This section covers the account-sync half.

**No user-facing mention of the provider.** The button is **↻ Refresh Accounts**, labels read "Linked account", and error text says "linked account". Internal identifiers (`nwRefreshPlaid`, `refresh_net_worth_plaid`, `state.netWorth.plaidAccounts`) still use the old name — keep user-visible strings generic.

**Access tokens live in Worker secrets**, not KV — `PLAID_ACCESS_TOKENS` (JSON array) or the legacy single `PLAID_ACCESS_TOKEN`, read by `plaidAccessTokens(env)`. `PLAID_ITEM_LABELS` / `PLAID_ITEM_OWNERS` map an Item ID to a display label / owner name.

**Resilient refresh (`refreshNetWorthPlaid`).** Each Item is fetched independently and settled rather than thrown, so one broken connection cannot wipe out the others:
- Successful institutions refresh normally.
- Failed ones keep their **last known accounts** (merged back in by id) so balances don't vanish from net worth.
- Failures become `syncWarnings: [{ label, itemId, reason, needsReconnect, message }]`, built by `bankSyncWarning()` from `BANK_SYNC_REASONS` / `BANK_SYNC_RECONNECT_CODES`.
- It only throws when **every** connection fails.
- `normalizeNetWorth()` strips unknown keys, so `handleRefreshNetWorthPlaid` attaches `syncWarnings` to the response **after** normalization — don't move it inside the record.

**Naming a failed connection.** `/accounts/get` returns no usable item id for a broken Item, so `resolveLinkedAccountInfo()` falls back to `/item/get` (which still responds for an Item needing re-auth) to recover both the institution name and the `itemId` the reconnect flow needs.

**Reconnect flow (in-app).** `nwSyncWarningHtml()` renders a warning banner with a **Reconnect** button on each connection where `needsReconnect && itemId`:
1. `nwReconnectBank()` lazy-loads the Link SDK (`loadPlaidLink()`).
2. `create_plaid_link_token` finds the access token owning that `itemId` (`findPlaidAccessTokenForItem`) and creates an **update-mode** link token.
3. **Update mode repairs the existing access token in place** — there is no new token and no exchange step, which is why tokens can stay in Worker secrets. On success the frontend just calls the normal refresh.

Set the optional `PLAID_REDIRECT_URI` secret for OAuth institutions (must also be registered in the provider's dashboard); a missing/invalid one returns a specific error.

> **CSP:** the `Content-Security-Policy` meta tag in `index.html` allows `https://cdn.plaid.com` (`script-src`, `frame-src`, `img-src`) and `https://production.plaid.com` (`connect-src`) purely for this flow. Removing them breaks Reconnect.

**Account display names** are built in `refreshNetWorthPlaid`. Robinhood accounts get owner prefixes by subtype (brokerage / ira / crypto), followed by a **catch-all** that prefixes any remaining Robinhood account with the item owner — so a Roth IRA becomes "Chris's Robinhood Roth IRA" without hardcoding a subtype string. Already-prefixed names are skipped and joint accounts stay unprefixed. An explicit `PLAID_ITEM_LABELS` entry overrides everything.

---

### Fair Share (section inside Monthly Budget)

A collapsible **section inside the Monthly Budget view** — not a standalone tab. It **reuses the budget's own expense items** (no double entry): it totals the expenses marked **shared**, divides by household size, and shows the fair per-person amount Red's mother contributes once she lives with the family.

**Context / why it's *not* an SSI tool:** the mother receives regular **Title II Social Security** (~$2,092.50/mo net; ~$2,989.90 gross), confirmed by her COLA notice and the "SSA TREAS 310 XXSOC SE" bank descriptor — **not SSI** (SSI caps ~$967 and her benefit income would zero it out). Title II is *not* needs-based, so household contributions don't change her check, and there is no SSA floor. The goal is to keep her contribution at her **share of actual shared costs (no markup)** so it reads as **cost-sharing / expense reimbursement** — generally not taxable income to the family. (Charging *above* her actual share is what could look like rental income.) Not tax advice; confirm with a CPA.

**Primary anchors in `index.html`** (just after `_saveBudget()`):
- Section starts at `// ── Monthly Budget: Fair Share section`
- Category defaults: `FS_SHARED_CAT_DEFAULTS` (which budget expense categories count as shared by default)
- Card builder: `fsRenderCard()` — injected into `_renderBudgetHtml()` right after the summary bar
- Math: `fsCalc()` · per-item check: `fsItemShared(item, cat, fs)` · normalizer: `fsNormalize(raw)`
- Collapse: `fsToggleSection()` (open state in `localStorage` key `rentals_budget_fairshare_open`)
- Mutators: `fsToggleShared(itemId)`, `fsUpdateSetting(key, value)` — both persist via `_saveBudget()`
- **Income line:** `fsSyncBudgetIncome()` (called at the top of `_renderBudgetHtml`) keeps an auto, read-only income item `id: 'mom-fair-share'` ("Mom's Fair Share") in `budget.income`, valued at `fsCalc().herShare`, so her contribution counts as household income. It renders read-only (⚖️ "from Fair Share", no edit/lock/delete); `budgetDelete`/`budgetToggleLock` early-return for `FS_INCOME_ID`. It persists in the budget record but its amount is re-synced every render.
- **Separate family gift — REMOVED (2026-07-03):** the recurring `$400/mo` gift was dropped because recurring gifts are uncompensated transfers under Medicaid's 5-year lookback and could create an eligibility penalty for her. `fsNormalize()` drops any saved `giftAmount`/migration flags; `ensureBudgetLoaded` strips the legacy `mom-family-gift` income line (id kept as `FS_GIFT_INCOME_ID` for cleanup); `mbNormalize`/worker `normalizeMomBudget` filter the `family-gift` fixed line out of saved `mom_budget` records; the phone PWA's Family Gift card and the worker's `month.giftAmount` field are gone. Her payments are Fair Share expense reimbursement only.

**Data shape (`state.budget.fairShare`):**
```javascript
{
  householdSize,   // divisor — everyone living in the home (incl. mother & children)
  roundDollar,     // round her share to the NEAREST whole dollar (Math.round, neutral)
  shared: { [budgetExpenseItemId]: bool },  // per-item OVERRIDES of the category default
  participants: { [itemId]: number },       // per-item divisor override (who benefits)
  agreement: { residentName, ownerNames, propertyAddress },  // cost-sharing agreement parties
  mortgage: { enabled, itemId, loanAmount, ratePct, termYears, firstPayment },  // principal exclusion (see below)
  foodBenchmark: { enabled, itemId, amount, sourceLabel, suppliesAllowance }  // USDA food benchmark for the Weekly Spending item (see below)
}
```
There is **no separate bills list** — the bills are the budget's expense items. An item counts as shared if `fairShare.shared[item.id]` is set (explicit override), else it falls back to `FS_SHARED_CAT_DEFAULTS[category]`. Toggling the Shared/Personal pill writes an explicit override.

**`fsCalc()` math** (iterating all budget expense items across `BUDGET_EXPENSE_CATS`):
```
totalAll    = Σ item.amount
totalShared = Σ item.amount where fsItemShared(item, cat)
perPerson   = totalShared / householdSize
herShare    = roundDollar ? round(perPerson) : perPerson
```
The card header shows `herShare` (always visible, even collapsed) and a green "Cost-sharing, not income" note when open. Personal items dim and their pill reads **Personal**. No SSI/SSA/FBR/buffer logic. `herShare` is also surfaced as a read-only **"Mom's Fair Share" income line** in the budget's Income section (see `fsSyncBudgetIncome` above) so it rolls into Monthly Income / Net.

**Persistence:** `fairShare` rides inside the `budget` KV record. The budget loader (`renderBudget`) reads it back via `fsNormalize(raw.fairShare)` — like `worksheets`, it must be pulled from `raw` or it's lost on the next save. `fsNormalize` also migrates the original standalone version's `roundUp` → `roundDollar`.

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
| `add_maintenance_entry` | `entry: { date, description, cost, performedBy, notes, capitalImprovement }` | `{ entry: { id, ... } }` |
| `update_maintenance_entry` | `id`, `entry: {...}` | `{ success: true }` |
| `delete_maintenance_entry` | `id` | `{ success: true }` |

Maintenance entries use `capitalImprovement: true` when marked **Improvement** in the UI. For `6AL`, `95EB`, and primary residences (`731WO`, `4781MC`), those marked-improvement maintenance costs are included in Investment Return cost basis, sale closeout math, and Tax Planning property-sale imports. Entries marked **Repair** remain in the maintenance log but are excluded from basis.

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
| `get_mom_budget_public_summary` | optional `month: "YYYY-MM"` | `{ monthKey, monthLabel, updatedAt, month: { overallSpendingRemaining, discretionaryRemaining, discretionaryAdjusted, otherOverages, discretionarySpent, fairShare }, year: {...} }` — public unauthenticated read-only summary for `mom-budget-phone.html`; returns calculated numbers only, never raw editable records. `month.fairShare` is computed live from the `budget` KV record (`calcFairShareFromBudget`). Guarded by a per-IP rate limit (`env.PUBLIC_RATELIMIT`, 60 req/60s → `429`, fails open) and a ~45s edge cache (synthetic GET cache key keyed by month, `Cache-Control: public, s-maxage=45`). Both are invisible to the phone and cap bot/flood abuse. |

#### Move-In Purchases (per-property — 4781MC only)
All of these reject any property other than `4781MC` (`requireMoveInPurchaseProperty`) with a 400.

| Action | Extra payload | Returns |
|---|---|---|
| `get_move_in_purchases` | — | `{ entries: [...] }` |
| `save_move_in_purchases` | `entries: [...]` | `{ entries: [...] }` — full overwrite; used by category rename/delete cascades |
| `add_move_in_purchase` | `entry: { item, date, estimatedPrice, productLink, notes, purchased, category }` | `{ entry: { id, ... } }` — server-side UUID |
| `update_move_in_purchase` | `id`, `entry: {...}` | `{ entry: {...} }` |
| `delete_move_in_purchase` | `id` | `{ success: true }` |
| `get_move_in_categories` | — | `{ categories: [...] }` — seeds `MOVE_IN_CATEGORIES_DEFAULT` when unset |
| `save_move_in_categories` | `categories: [...]` | `{ categories: [...] }` — trims, drops blanks, de-dupes case-insensitively, caps at 100 |

#### Net Worth (global — not per-property)
| Action | Extra payload | Returns |
|---|---|---|
| `get_net_worth` | — | `{ data: {...} }` |
| `save_net_worth` | `data: {...}` | `{ data: {...} }` |
| `refresh_net_worth_plaid` | — | `{ data: {...} }` — `data.syncWarnings` present when some connections failed; 502 only if **all** failed |
| `create_plaid_link_token` | `itemId` | `{ linkToken, expiration }` — update-mode token for reconnecting that Item |
| `value_net_worth_vehicle` | `vehicle` | `{ value, valuedAt, source }` |
| `get_vehicle_trims` | vehicle lookup fields | trim options |

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
| `save_savings` | `data: { accounts, obligations, payments }` | `{ success: true, data }` — full overwrite of the `savings` KV record. The worker sanitizes: **ignores client-supplied `accounts.{robinhoodChecking,robinhoodBrokerage}`** (both are server-owned — set only from the latest Plaid balance cache, falling back to the last saved balance), coerces `paymentsPerYear` to `1` or `2`, drops any year key that isn't a 4-digit string. |
| `get_robinhood_balance` / `get_robinhood_brokerage_balance` | optional `refresh: true` | `{ balance, current, available, refreshedAt, source, stale, ... }` — live balance for the Robinhood **checking** / **brokerage** (Chris's Individual Account) accounts. Resolves the account inside the linked Robinhood (`ins_54`) Item by subtype (checking / brokerage), caches per-account (5-min TTL, 1-min force-refresh floor), and mirrors the value into `savings.accounts.{robinhoodChecking,robinhoodBrokerage}`. Both refresh on Savings-tab load and on the daily 6am ET cron. |

> **Fair Share** has no dedicated action/KV key — its settings (`householdSize`, `roundDollar`, per-item `shared` overrides) live inside the `budget` record under `data.fairShare` and are saved via `save_budget`.

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
budget                     →  { income: [...], expenses: {...}, worksheets: {...}, fairShare: { householdSize, roundDollar, shared: { [itemId]: bool } } }
mom_budget                 →  { template: { income, fixed, variable, variableLocks }, months: { [YYYY-MM]: {...} } }
solar:config               →  Solar system config object
solar:entries              →  Array of solar entry objects
solar:summaries            →  { [year]: { ... } }
deductions                 →  Array of deduction entry objects
tax_planning:{year}        →  Tax planning inputs for that year
savings                    →  { accounts: {robinhoodChecking, robinhoodBrokerage}, obligations: [...], payments: { [year]: { [oid]: [bool, ...] } } }
net_worth                  →  { manualItems, vehicles, propertyAssets, plaidAccounts, treasuryPortfolio, plaidRefreshedAt, history }
move_in_purchases:{property}  →  Array of move-in purchase objects (4781MC only)
move_in_categories:{property} →  Array of category name strings (4781MC only)
```
Valid properties: `6AL`, `95EB`, `446BB`, `731WO`, `4781MC`

Bank access tokens are **not** in KV — they live in Worker secrets (`PLAID_ACCESS_TOKENS`). See the Net Worth section.

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

Live URL: `https://99redder.github.io/stuff/`

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
- **The main `<script>` is NOT wrapped in an IIFE.** The `})();` at the end of the file closes the `initApp()` call only. Top-level `function` declarations are therefore already global, which is why `onclick=` handlers work without registration. The long `window.X = X` block near the bottom is legacy and largely redundant — harmless to add to, but not required. (`const`/`let` at top level are *not* on `window`, so `state` is unreachable from the console.)
- **CSS variables:** `--card-bg` is an alias of `--surface` and follows the dark theme automatically. Before it was declared it resolved to `transparent`, which looked fine on cards but left page-level panels unfilled — if you add a variable, declare it in `:root`.
- The global `input, select, textarea { width: 100% }` rule will squeeze inline `<select>`s in table cells and clip their text. Set `width:auto` on those.

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

### 2026-07-22 — Reconnect banner surfaced beyond Net Worth

- **The bank "needs reconnecting" prompt now appears in Savings and Cash Flow too**, not just Net Worth — anywhere a Robinhood balance is shown. Previously an expired login (`ITEM_LOGIN_REQUIRED`) only surfaced on the Net Worth tab, so the Savings balances would silently show stale values with a generic "Unable to refresh" error and no way to fix it.
- **Worker:** `fetchPlaidAccountBalance` now attaches the Plaid `error_code` to the thrown error, and `handleGetRobinhoodBalance` calls `buildBalanceReconnectInfo()` on failure — reusing `resolveLinkedAccountInfo` (`/item/get`, which still responds during re-auth) + `bankSyncWarning` to attach `{ needsReconnect, itemId, reconnectLabel, reconnectMessage }` to the balance response (both the 502 and the cached-fallback 200). No new action/KV — the reconnect signal rides on the existing balance endpoints.
- **Frontend:** `callApi` now preserves the response body on the thrown error (`err.data`). `refreshRobinhoodBalanceFor` reads reconnect info from the response/error into `state.robinhoodReconnect` / `state.robinhoodBrokerageReconnect` (cleared on a clean live pull). New shared `bankSyncBannerHtml()` + `bankReconnect(itemId, btn)` (generalized from `nwReconnectBank`, opens Plaid update mode then re-pulls every balance and re-renders) are injected at the top of the Savings and Cash Flow views. Net Worth keeps its own richer `nwSyncWarningHtml()` (covers all institutions, not just Robinhood).

### 2026-07-22 — Savings: Robinhood Brokerage pulled live

- **Robinhood Brokerage is now auto-synced from the linked bank connection**, same as Robinhood Checking — it was previously a manual dollar entry. It maps to the Net Worth "Chris's Robinhood Individual Account" (Plaid `subtype: brokerage` under the Robinhood `ins_54` Item).
- **Worker:** the checking-balance machinery was generalized into a per-account descriptor map (`ROBINHOOD_ACCOUNTS.{checking,brokerage}`), each with its own cache/selection KV keys, `savingsField`, and account matcher. `resolvePlaidTokenForAccount` / `handleGetRobinhoodBalance` now take a descriptor; `syncRobinhoodCheckingSavings` → `syncRobinhoodSavingsField(env, field, balance)`. New action `get_robinhood_brokerage_balance`. `handleSaveSavings` now treats **both** balances as server-owned (ignores client values, sourced from the per-account Plaid cache, falling back to the last saved balance). The daily 6am ET cron refreshes both.
- **Brokerage account is pinned** via the `PLAID_BROKERAGE_ACCOUNT_ID` secret (set to Chris's Robinhood Individual Account id) because there are two `subtype: brokerage` accounts (Chris's + Megan's) and subtype matching alone is ambiguous. `resolvePlaidTokenForAccount` prefers the pinned id (exact `account_id` match) and only falls back to subtype matching if it's absent.
- **Balance fetch has a fallback** (`fetchPlaidAccountBalance`): Robinhood investment accounts (brokerage/IRA) reject Plaid's real-time `/accounts/balance/get` with a 400, so it tries that endpoint first, then falls back to `/accounts/get` (cached balances — the same source the Net Worth view reads successfully). Checking still resolves via the real-time endpoint.
- **Frontend:** the manual brokerage `<input>` (+ `savUpdateAccount`) was replaced with a read-only live-balance card and a "Refresh live" button (`savRefreshRobinhoodBrokerage`), mirroring checking. Refresh logic was parameterized via `ROBINHOOD_BALANCE_KINDS.{checking,brokerage}` (`refreshRobinhoodBalanceFor` / `startRobinhoodBalanceRefreshFor`); both balances refresh on Savings-tab load.

### 2026-07-18 — Net Worth: resilient bank sync + in-app reconnect

- **One expired bank login no longer breaks every account.** `refreshNetWorthPlaid` fetched all Items with a single `Promise.all` that threw on the first error, so an `ITEM_LOGIN_REQUIRED` on one institution failed the whole refresh. Each Item is now settled independently: healthy institutions refresh, failed ones **retain their last known accounts** (merged by id) so balances don't disappear from net worth, and only a total failure throws.
- **Plain-language warnings.** Failures map through `BANK_SYNC_REASONS` / `BANK_SYNC_RECONNECT_CODES` into `syncWarnings: [{ label, itemId, reason, needsReconnect, message }]`, rendered as a banner (`nwSyncWarningHtml()`) plus a modal after a manual refresh. Attached to the response *after* `normalizeNetWorth()`, which strips unknown keys.
- **Naming the failed bank.** `/accounts/get` gives no usable item id for a broken Item, so `resolveLinkedAccountInfo()` falls back to `/item/get` (still responsive during re-auth) for the institution name **and** the `itemId`.
- **In-app Reconnect** (`nwReconnectBank`): lazy-loads Link, calls the new `create_plaid_link_token` action for an **update-mode** token, and re-runs the normal refresh on success. Update mode repairs the existing access token in place — no exchange step, so tokens stay in Worker secrets rather than moving to KV. Optional `PLAID_REDIRECT_URI` secret for OAuth institutions. **CSP was widened** for `cdn.plaid.com` / `production.plaid.com`.
- **Provider name removed from the UI** — button is now "↻ Refresh Accounts" and all labels/errors say "linked account". Internal identifiers unchanged.
- **Robinhood Roth IRA naming:** only brokerage/ira/crypto had owner-prefix rules, so a Roth rendered as "Robinhood Roth IRA". Added a catch-all that prefixes any remaining Robinhood account with the item owner (skips already-prefixed and joint accounts) rather than guessing the provider's Roth subtype string.
- **Declared the missing `--card-bg` CSS variable.** Referenced in 29 places but never defined, so it resolved to `transparent`: fine on cards (transparent over `--surface`), but page-level panels rendered as empty outlined boxes. Declared as `var(--surface)` — confirmed by `.mb-fixed-template-row` (`--surface2`) using `--card-bg` as its contrasting `.is-alt` stripe.

### 2026-07-18 — Move-In Purchases: categories + UI rebuild

- **Per-item categories** with a default set (Living Room · Basement · Craft Room · Office · Kitchen / Dining Room · Ellie · Mom · Other), persisted per property in the new `move_in_categories:{property}` KV record via `get_move_in_categories` / `save_move_in_categories`. Entries gained a `category` field.
- **Category management** in a branded modal (`#mip-categories-modal`) — add, rename, delete. Rename cascades to every item in the category; delete reassigns items to `Other`. Both persist through the bulk `save_move_in_purchases` action.
- **Sorting:** Category (default, grouped with per-category subtotals and an emoji icon in each group header, items price high→low inside a group) · Name · Price ↓ · Price ↑.
- **Edit mode** (`_mipEditMode`): off by default, showing the category as a read-only pill with no per-item Edit/✕. On, it reveals the category dropdown, Edit/✕, and the Categories button. The card widens 760px → 900px in edit mode so the extra controls don't force horizontal scrolling.
- **Card UI rebuilt** from a single cramped toolbar row into header (title + meta + `+ Add Purchase`) / progress bar / toolbar strip (search · segmented sort · edit) / table, with a dedicated `.mip-*` stylesheet section replacing the inline styles. Added free-text **search** over item, notes, and category. Removed the Target/Added column and replaced the date-based "Default" sort with Name.
- **Fixed clipped category dropdowns** caused by the global `select { width: 100% }` rule — `.mip-cat-select` sets `width:auto`.

### 2026-07-04 — Tax Planning audit: Maryland 2025 tax-law overhaul + LTCG stacking fix

- **Maryland model updated for the Budget Reconciliation and Financing Act of 2025** (Ch. 604; Comptroller Tax Alert rev. 2025-12-22 + Technical Bulletin 58):
  - `MD_BRACKETS_MFJ` previously held the **single-filer** Schedule I brackets ($100k/$125k/$150k/$250k breakpoints) and stopped at 5.75%. Replaced with the official **Schedule II (MFJ)**: 4.75% to $150k · 5% to $175k · 5.25% to $225k · 5.5% to $300k · 5.75% to $600k · **6.25% to $1.2M · 6.5% above** (new TY2025+ brackets). Verified against the Comptroller's Tax Computation Worksheet anchor amounts.
  - **Standard deduction** is now the flat `MD_STD_DEDUCTION = 6700` (MFJ) — the 15%-of-AGI min/max formula was repealed for TY2025+ (COLA-indexed going forward).
  - **New 2% capital gains surcharge** (`MD_CG_SURCHARGE_*` consts, `mdNetCapitalGain(tp)`): when federal AGI > $350k, Maryland adds 2% on net capital gain per IRC §1222(11) — net LT gains (including unrecaptured §1250 depreciation recapture) less any net ST loss; positive ST gains are excluded. Primary-residence sales under $1.5M are exempt (checked per imported property-sale slot via `PRIMARY_PROPERTIES` + sale price). Surcharge rides in `md.cgSurcharge`/`md.cgSurchargeBase`, is included in Total MD Tax, renders its own results row, and has a Warning/Caution pair in the AGI Threshold Watch (TB-58 source link).
  - **County rates refreshed** for TY2026: Allegany 3.20 · Anne Arundel 2.94 (flat approx of its progressive brackets) · Baltimore County 3.20 · Calvert 3.20 · Cecil 2.74 · Dorchester 3.30 · Kent 3.30 · St. Mary's 3.20 · Washington 2.95 · Worcester 2.25. Wicomico (default) unchanged at 3.20.
  - Results-panel exemption label is now dynamic (`4×$<tier>` instead of hardcoded `4×$3,200`) and the MD input-card notes were rewritten to match the new law.
- **Federal LTCG stacking fix:** `tpCalcLTCGTax` is now called with `ordinaryTaxable + depRecaptureTaxable` as the stack base — unrecaptured §1250 gain occupies the preferential-rate stack *below* other LT gains (Schedule D worksheet), so remaining LTCG no longer incorrectly slides into the 0%/15% brackets when a rental sale includes large recapture.
- **`TP_SALT_PHASEDOWN` 500000 → 505000** — OBBBA indexes the SALT phase-down MAGI threshold +1%/yr like the cap (2026 value).
- Known simplifications (documented, not modeled): passive-activity-loss limits on net rental losses, capital-loss netting/$3k cap, IRA deductibility phase-out when covered by an employer plan, CTC ordering vs SE tax/NIIT, QBI taxable-income cap, and VA nonresident filing for 446BB rental income (MD credit for taxes paid to VA).
- **MAGI computed and displayed** (`r.magi = agi + iraAdj` in `tpCalc` — Roth IRA MAGI per §408A(c)(3)(B)(i) adds back the traditional IRA deduction; the tab's other MAGI-based rules collapse to AGI since there are no foreign-exclusion/tax-exempt-interest inputs). Shown in the AGI Threshold Watch header (`AGI · MAGI · Taxable`) and body intro, and as a results-panel row under AGI whenever it differs. The Roth phase-out warnings now test MAGI instead of AGI (previously could miss ineligibility by up to the $15k IRA deduction).

### 2026-07-03 — Tax Planning: AGI Threshold Watch card

- **New `⚠️ AGI Threshold Watch` card** at the top of the Tax Planning results column (`#tp-warnings`, rendered by `tpAgiWarningsHtml(r, tp)` inside `tpUpdateResults` so it live-updates with every input). Checks the projected AGI/taxable income against 2026 MFJ thresholds and renders each as **⛔ Warning** (past the threshold, red), **⚠️ Caution** (approaching — within `TP_WARN_NEAR = $25k` below, amber), or **Note** (informational), with computed dollar impacts and a source link per item. Every warning-capable threshold has a caution counterpart (MD exemptions' caution covers the $1,600/$800 reduced tiers between $150k–$200k). Items state whether the effect is already modeled in the estimate (NIIT, CTC clawback, 20% LTCG bracket, MD exemptions) or **not** modeled (Roth eligibility, SALT phase-down, QBI W-2/UBIA limits, Additional Medicare).
- Monitored: NIIT $250k · CTC clawback $400k · Roth phase-out $242k–$252k · SALT cap $40,400 phase-down over $500k (floor $10k) · QBI §199A limits over $403,500 taxable (phase-in to $553,500, Rev. Proc. 2025-32) · 20% LTCG breakpoint (`TP_LTCG_MFJ`) · 0.9% Additional Medicare on wages/SE > $250k (pension/gains excluded) · MD exemption elimination > $200k · 2026 charitable 0.5%-of-AGI floor · 110% estimated-tax safe harbor > $150k · Medicare IRMAA 2-year lookback (≈ $218k first tier). Constants in the `TP_WARN_*`/`TP_ROTH_*`/`TP_SALT_*`/`TP_QBI_*` block next to the other TP constants.
- **Accuracy fixes riding along:** `TP_CTC_PER_CHILD` 2000 → **2200** (2026 OBBBA), and `calcMarylandTax` now phases MD personal exemptions by federal AGI (MFJ: $3,200 ≤$150k / $1,600 ≤$175k / $800 ≤$200k / $0 above) instead of always deducting 4 × $3,200. `tpCalc` now returns `nii`, `ctcRaw`, `ctcPhaseout`.

### 2026-07-03 — Fair Share: USDA food benchmark for Weekly Spending

- **New `🍎 USDA Food Benchmark` sub-card** in the Fair Share section. The Weekly Spending bucket is mixed family spending (groceries + dining + kids' items), so an equal per-capita split overstates Mom's consumption. When enabled, her portion of that one item is a **fixed amount pegged to the USDA Official Food Plans: Cost of Food at Home** figure for her age/sex instead of `amount ÷ participants`. Defaults: `FS_USDA_DEFAULT_AMOUNT = 442` — Liberal Plan female 71+ $394.40/mo (May 2026 report) × 0.95 USDA 5–6-person household adjustment = $375, **plus an explicit $67/mo household-supplies allowance** (toiletries, paper goods, cleaning) — and the matching `FS_USDA_DEFAULT_SOURCE` label. Gas is deliberately excluded (she doesn't drive; rides are family support). The agreement's Method clause + Exhibit A write-up describe the composite (USDA food benchmark + stated supplies allowance). Amount + source label are editable inputs, refreshed annually from the latest USDA monthly report (`USDA_FOOD_COST_URL`).
- **One-click auto-update:** the card's `↻ Update from latest USDA report` button (`fsRefreshUsdaBenchmark()`) calls the authenticated worker action `refresh_usda_food_benchmark`, which probes `cnpp-costfood-3levels-{month}{year}.pdf` backwards from the current month (USDA hosts only the newest report at that URL pattern), inflates the PDF's FlateDecode streams via `DecompressionStream` (trailing-EOL-tolerant `inflateBytes`), decodes the Tj/TJ text operators through the embedded ToUnicode CMaps (`parseUsdaCostOfFoodPdf`), and returns `{ reportLabel, liberalMonthly }` from the first (female) `71+ years` row. The frontend recomputes `amount = round(liberalMonthly × 0.95) + suppliesAllowance` (default `FS_USDA_DEFAULT_SUPPLIES = 67`), regenerates the source label (`fsUsdaSourceLabel()`), saves, and shows a branded confirmation. Parse failures return 502 and the UI falls back to a manual-update notice.
- Config in `fairShare.foodBenchmark` (`itemId` empty = auto-detect the first Weekly Spending item). Helpers `fsFoodBenchmark()`/`fsFoodBenchmarkItem()`, mutator `fsUpdateFoodBenchmark()`. In `fsCalc` the item still counts fully in `totalShared` but contributes the fixed benchmark to `herShareExact` (returned as `foodAdj`). The shared-bills row shows a `USDA = $X` badge in place of the ÷N input.
- **Agreement:** Method clause gains a conditional USDA-valuation sentence; the Exhibit A row is marked `†` with the Divided-Among column reading `USDA †`; a boxed `† USDA food benchmark` write-up explains the mixed-bucket reasoning (per-capita figure shown for comparison) and cites the source label; the References clause adds the USDA Cost of Food reports with URL. Card references row links both IRS + USDA.
- **Worker mirrored** (`fairShareFoodBenchmark` inside `calcFairShareFromBudget`) so the phone PWA matches.

### 2026-07-03 — Fair Share: mortgage principal exclusion

- **New `🏠 Mortgage Principal Exclusion` sub-card** in the Fair Share section. The budget keeps the real full mortgage payment, but Fair Share subtracts the current month's estimated loan-principal portion (owner equity, not a shared cost) from that one item before the ÷household split. Standard fixed-rate amortization (`fsMortgageCalc`): P&I = L·r/(1−(1+r)^−n); payment # derived from `firstPayment` (YYYY-MM, payment #1 assumed if unset); balance before payment k → interest → principal. All steps shown as visible math text in the card.
- Config persists in `fairShare.mortgage` (`enabled` off by default, `itemId` empty = auto-detect the first /mortgage/i item in the Mortgage category, defaults $300k / 6.99% / 30yr). Mutator `fsUpdateMortgage()`. The shared-bills list shows the adjusted amount with a strikethrough original + "− principal" badge. The cost-sharing agreement carries the exclusion too: the Method clause gains a conditional principal-exclusion sentence, and Exhibit A shows the adjusted amount with a `*` pointing to a boxed "Mortgage principal exclusion" write-up (loan terms + the full amortization math for the current month, mirroring the card). Both only render when the exclusion is enabled.
- **Worker mirrored** (`fairShareMortgageExclusion` inside `calcFairShareFromBudget`, month via `currentEasternMonthKey()`) so the phone PWA's Fair Share matches.

### 2026-07-03 — Fair Share: cost-sharing agreement generator

- **New `📄 Generate Cost-Sharing Agreement` button** in the Fair Share card opens `#fs-agreement-modal` with a print-ready **Household Cost-Sharing Agreement** built live from the current Fair Share data: numbered terms (cost-sharing not rent/lease, allocation method, monthly contribution, adjustment/termination clauses) plus an **Exhibit A** table of every shared expense with its monthly cost, participant divisor, and Mom's portion, totaling `fsCalc().herShare`. Regenerates from live numbers on every open — reprint/re-sign annually or when bills change.
- Party names/address persist in `budget.fairShare.agreement` (`residentName`, `ownerNames`, `propertyAddress`), normalized in `fsNormalize`, edited in the modal via `fsUpdateAgreementField()`. Printing opens a standalone popup document (`fsPrintAgreement()`, shared `FS_DOC_CSS`, Exhibit A on its own page via `page-break-before`). All user strings escaped with `escHtml`/`escAttr`.

### 2026-07-03 — Removed the $400/mo family gift (Medicaid lookback)

- **The recurring "Gift to Chris & Family" transfer was removed everywhere.** Recurring gifts to family are uncompensated transfers under Medicaid's 5-year lookback (Maryland penalty divisor ≈ $11–12k/mo of nursing-home cost), so a sustained $400/mo gift could create a ~2-month eligibility penalty if she ever needs long-term-care Medicaid. Her payments are now limited to Fair Share expense reimbursement (payment for value — not a gift).
- **Frontend:** Fair Share card's "Separate Monthly Gift" input, `FS_GIFT_*` consts, the `giftAmount` branch of `fsUpdateSetting`, the "Mom's Family Gift" auto income line (`fsSyncBudgetIncome` now filters `FS_GIFT_INCOME_ID` out; `ensureBudgetLoaded` does a one-time KV cleanup save), the `family-gift` Mom Budget fixed line (`MOM_BUDGET_DEFAULT` + `mbNormalize` now filter it out of saved records), and the gift-specific IRS links are all gone. The Fair Share explainer now carries a "No gifts" Medicaid-lookback warning instead.
- **Worker + phone PWA:** `giftAmountFromBudget()`/`FAMILY_GIFT_*` removed; `syncMomHouseholdTransfers` syncs only `fair-share`; `normalizeMomBudget` filters `family-gift`; the public summary no longer returns `month.giftAmount`. `mom-budget-phone.html` drops the Family Gift card; `mom-budget-sw.js` `CACHE_NAME` → `v9`.

### 2026-06-18 — Mom Budget: 401(k) RMD calculator

- Added a **401(k) Minimum Distribution (RMD)** card to the Mom Budget left column. Her birth date is fixed (`MOM_RMD_BIRTH_YEAR = 1952`, born Aug 12, 1952; retired, no spouse → Uniform Lifetime Table), so the **only input is the prior Dec 31 401(k) balance** (persisted in `state.momBudget.rmd`, saved via the passthrough `save_mom_budget`). Computes the yearly required minimum = balance ÷ IRS Uniform Lifetime Table factor (`RMD_UNIFORM_LIFETIME`) for the age she reaches this year, plus a monthly equivalent, and notes the retired/no-spouse assumptions. `mbRmdStartAge()` applies SECURE Act 2.0 start ages (73 / 75). `mbCalcRmd()` / `mbRmdCard()` / `mbUpdateRmd()`; `mbNormalize` seeds `data.rmd`. No worker/phone change.

### 2026-06-18 — Mom Budget phone PWA: Fair Share card

- Added a **Fair Share** card to `mom-budget-phone.html` (between Overall Spending Left and Discretionary Left) showing her monthly household contribution. The worker's `get_mom_budget_public_summary` now returns `month.fairShare`, computed live from the `budget` KV record by `calcFairShareFromBudget()` (a mirror of the frontend `fsCalc()` + `FS_SHARED_CAT_DEFAULTS`), so it reflects the latest household bills even if the `mom_budget` record's fair-share line is stale. `mom-budget-sw.js` `CACHE_NAME` bumped to `v7`.

### 2026-06-17 — Mom Budget: simplified Month Math

- Trimmed the **Month Math** card now that she has few bills. Removed `Fixed due this month` (identical to fixed total when all bills are monthly), `Reserve cash delta` (leftover reserve-bill jargon), and `Fixed bill overage` (always $0 — no variable fixed bills remain). Renamed `Fixed monthly reserve` → `Fixed bills`, `Discretionary base` → `Discretionary budget`, `Fixed cash paid` → `Fixed bills paid`. The `Other overages` + `Adjusted discretionary` rows now render **only when there are overages**. Result: 6 rows normally, 8 with overages (was 11).

### 2026-06-17 — Mom Budget: removed Cell Phone + Mark Reserve Bills Paid button

- **Cell Phone removed** (she's on the family cell plan) via the one-time `cellTrimmed` migration in `mbNormalize`. Default fixed list is now just `fair-share`, `medical`.
- **`Mark Reserve Bills Paid` button removed** from the Fixed Bills card header (and the `mbMarkReserveBillsPaid()` function + `reserveFixedItems`/`reserveAllPaid` locals deleted). No remaining default bills are reserve bills. `mbIsReserveBill()` and the `Reserve Bill` badge are kept for any custom non-monthly bill.

### 2026-06-17 — Mom Budget: removed Gas + car/streaming bills

- **Gas budget and ledger removed** (she has no car). `mbNormalize` `delete`s `template.variable.gas`; `mbCalcMonth`/`mbTemplateTotals` and the worker's parallel math drop gas from every formula; the Gas Left stat, Gas ledger card, Gas budget/overage Month-Math rows, and Gas variable-template row are gone. Phone PWA drops the Gas Left card (`mom-budget-sw.js` → `v6`). She now tracks just **Fair Share, Discretionary, and overages**.
- **Car Insurance / Car Repairs / Car Registration / Netflix / BritBox removed** from Fixed Bills via the one-time `carStreamingTrimmed` migration (runs even on records already past `fairShareMigrated`).
- **Cell Phone removed** (she's on the family cell plan) via the one-time `cellTrimmed` migration. Default fixed list is now just `fair-share`, `medical`.

### 2026-06-17 — Mom Budget: bills wrapped into Fair Share (she now lives with family)

- **Mom Budget no longer lists her household bills separately.** Rent, Internet, Water / Sewer / Trash, Electric, and Nat Gas / Heat are removed and replaced by one **auto-synced `fair-share` fixed line** whose monthly amount is pulled live from the Monthly Budget Fair Share section (`mbSyncFairShare()` → `fsCalc().herShare`, after a new shared `ensureBudgetLoaded()` helper). The line is `auto: true` → read-only amount, no lock/delete (guarded in `mbDeleteTemplateItem`), ⚖️ icon.
- **Groceries folded into Fair Share.** Removed the Groceries variable budget, ledger card, and `Groceries Left` stat; `mbCalcMonth`/`mbTemplateTotals` drop groceries from `overallSpendingRemaining`, `discretionaryAdjusted`, `budgetSpent`. One-time `fairShareMigrated` flag in `mbNormalize` strips the wrapped fixed bills + `delete`s `template.variable.groceries`; existing month `groceries[]` arrays are left untouched but unused.
- **Worker + phone PWA mirrored.** The worker's parallel public-summary math (`normalizeMomBudget`/`momBudgetTemplateTotals`/`calcMomBudgetMonth`) and `MOM_BUDGET_DEFAULT` were updated the same way (critically, it now `delete`s the groceries budget so it can't re-add $870). `mom-budget-phone.html` drops the Groceries Left card/JS; `mom-budget-sw.js` `CACHE_NAME` bumped to `v5`.

### 2026-06-17 — Fair Share moved into Monthly Budget

- **Removed the standalone `⚖️ Fair Share` tab** and re-embedded it as a collapsible **section inside the Monthly Budget view** so it reuses the bills already entered as budget expenses — no double entry. Header button, `fair-share` view case, `state.fairShare`, and the `get_fair_share`/`save_fair_share` worker actions + `fair_share` KV key were all removed.
- **Now derives from budget expenses.** `fsCalc()` iterates `state.budget.expenses`, summing items marked shared (per-item override in `fairShare.shared[itemId]`, else the `FS_SHARED_CAT_DEFAULTS[category]` default), ÷ household size. Settings + overrides live in `state.budget.fairShare` and save inside the `budget` record via `_saveBudget()` (read back through `fsNormalize(raw.fairShare)` in `renderBudget`). Card built by `fsRenderCard()`, collapse state in `localStorage` `rentals_budget_fairshare_open`.
- **Her contribution shows as Income.** `fsSyncBudgetIncome()` adds a read-only auto income line (`id: 'mom-fair-share'`, "Mom's Fair Share") to `budget.income` valued at `herShare`, so it rolls into Monthly Income / Net on the budget tab.

### 2026-06-17 — Fair Share view

- **New `⚖️ Fair Share` header button / view** (`fair-share`) — global view for what Red's mother contributes toward household expenses once she lives with the family. Editable household-bill list (name / monthly amount / Split toggle / note) with household-size and round-to-dollar settings, persisted to the `fair_share` KV record. Math in `fsCalc()`; render in `renderFairShare()` / `_renderFairShareHtml()`.
- **Built first as an SSI calculator, then redesigned as a cost-sharing splitter.** It initially computed an SSI "fair share" (food+shelter floor, FBR, VTR/PMV reductions). Her COLA notice + bank descriptor confirmed she's on **Title II Social Security, not SSI** (so household payments don't affect her benefit and there's no SSA floor). Reworked into a plain per-person splitter whose goal is keeping her contribution at her share of *actual* shared costs — cost-sharing/reimbursement, generally not taxable income to the family. Dropped: SSA floor, `buffer`, `fbr`, `countsSSA`, VTR/PMV. Added: per-bill `shared` Shared/Personal toggle (`fsToggleShared()`), `roundDollar` (round to nearest), and a green "cost-sharing, not income" note + CPA-confirmation explainer.
- **Worker API** — `get_fair_share` / `save_fair_share` (KV key `fair_share`). The save handler sanitizes household size (≥1, rounded, default 5), `roundDollar` boolean, and each bill to `{ id, name, amount≥0, shared, note }`, migrating legacy `roundUp` / `countsSSA` fields.

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

- **Savings view added** (`💰 Savings` header button) — global view with account balances (Robinhood Checking, Robinhood Brokerage — both pulled live from the linked bank connection) on the left and the year's annual obligations on the right. Funding summary at top shows whether available account balances cover total annual obligations, with surplus/shortfall as the primary metric and Outstanding as a simple number. Each obligation has 1 or 2 paid checkboxes (H1/H2 for twice-a-year items). Payments are keyed by year so Jan 1 auto-resets to all-unpaid; past years stay in KV.
- **Obligation sorting** — sort buttons in the Savings card header: Default (input order), Amount (largest first), A→Z, Unpaid (highest outstanding first). Sort state is in-memory only (not persisted).
- **Default obligations seed** — `DEFAULT_SAVINGS_OBLIGATIONS` (32 items, sourced from the 2026 goal-budget spreadsheet) is auto-seeded on first visit if the `savings` KV record has no obligations.
- **Branded delete modals** — all delete confirmations now go through `showBrandedNotice({ type:'danger', ... })` instead of native `confirm()`. Affected flows: historical year summary, maintenance entry, solar entry, solar summary, savings obligation. `showBrandedNotice` accepts a new `confirmLabel` option (defaults to "Yes, Delete" when type is `danger`).
- **Worker API additions** — `get_savings` / `save_savings` (KV key `savings`). The save handler sanitizes account balances, coerces `paymentsPerYear` to 1 or 2, validates year keys as 4-digit strings, and clamps boolean payment arrays to length ≤ 2.
