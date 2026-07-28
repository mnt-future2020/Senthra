# Regional Date/Time Formatting (timezone · dateFormat · timeFormat) — Design

**Date:** 2026-07-20
**Status:** Draft for review
**Owner:** Shahul

> **On the counts in this document.** Every figure (39 call sites, 4 CSV exports, 10 relative-time usages, 24 date inputs, 6 placeholders) is a **verified snapshot taken 2026-07-20**, not a permanent contract. They are recorded deliberately: they are the evidence the codebase was actually surveyed, and they make the §9 rollout checkable — you can tell whether the migration is finished. Expect them to drift as the app grows. The durable rule is the §4 invariant, not the arithmetic: **no component formats a date without going through `useRegionalFormatter()`.** A new screen adding a 40th call site does not invalidate this design; it just follows the rule. Re-run the §5 grep before starting work to get the count as of that day.

## 1. Purpose & Problem

Settings → Company → **Regional formatting** exposes three fields — `timezone`, `dateFormat`, `timeFormat` — with the on-screen promise *"Used by documents, exports and emails."* Two of those three claims are false, and the wider app ignores the settings entirely.

Actual consumption today:

| Setting | Consumed by | Not consumed by |
|---|---|---|
| `timezone` | PDF documents, PO emails | Entire frontend, all CSV exports |
| `dateFormat` | PDF documents, PO emails | Entire frontend, all CSV exports |
| `timeFormat` | **One line** — the PDF footer "generated at" stamp | Everything else |

The formatting primitive already exists and is correct: `backend/src/modules/document/document.formatter.ts:26-63` switches on all three `dateFormat` values and resolves parts through `Intl.DateTimeFormat` with an explicit `timeZone`. It is fed by `getRegionalSettings()` (`backend/src/modules/settings/settings.service.ts:190-197`). The problem is not the formatter — it is that only three call sites use it.

Meanwhile the frontend has **no date module at all** (`frontend/src/lib/` contains env, appearance, branding, clientCache, image, validation, utils, roleReachability, socket, siteImport, download, incoterms, paymentTerms, auth, printBarcode, api — no date helper), no `date-fns`, and 39 date call sites that each reimplement formatting inline. The result is four different behaviours in one app:

```
Settings says          Europe/London · DD/MM/YYYY · 24h
  ↓
PDF footer             company timezone            ✅
PO email               company timezone            ✅
Inventory / Jobs / PO  hardcoded "en-GB"           ❌ browser timezone
Topbar                 hardcoded "en-US"           ❌ different from everything else
Audit log              no locale argument          ❌ varies per user's machine
Movement feed          no locale argument          ❌ varies per user's machine
CSV exports            raw UTC ISO strings         ❌
```

Two consequences beyond cosmetics:

1. **Hydration mismatch risk.** `auditDisplay.ts:169`, `auditDisplay.ts:173` and `MovementFeed.tsx:141` call `toLocaleDateString()` / `toLocaleString()` with no locale argument. Server and client can disagree.
2. **A real "today" bug.** Seven form fields seed their default date with `new Date().toISOString().slice(0,10)` — that is *today in UTC*. For a London company after 00:00 BST, or a New York user before 19:00 local, the form pre-fills the **wrong day**.

Reference scenario: *An operations manager sets the company to `America/New_York` · `MM/DD/YYYY` · `12h`. Today, nothing in the UI changes; a PDF changes. After this work, every screen, every CSV, every PDF and every email renders `07/20/2026 6:30 PM` — with no code change.*

## 2. Scope

**In scope**

- Add `timezone` / `dateFormat` / `timeFormat` to the **public** `GET /settings/branding` response so they can be server-rendered.
- New `RegionalProvider` + `useRegionalFormatter()` hook, SSR-seeded exactly like `BrandingProvider`.
- New pure module `frontend/src/lib/datetime.ts` — `formatDate`, `formatDateTime`, `formatTime`, `todayInTimezone` — with a configurable fallback and three display styles.
- Migrate all **39** frontend date call sites, module by module with verification between each.
- Format date columns in all **four** backend CSV exports; drop the `(UTC)` suffix from their headers.
- Extract the four copy-pasted `csvEscape` implementations into one shared export utility that future exports reuse by default.
- Correct the six misleading `placeholder="dd-mm-yyyy"` hints and the stale comment at `settings.service.ts:182`.

**Out of scope / non-goals** (see §9 decision log)

- **New relative-time behaviour.** Relative time already exists and stays as-is behaviourally — see §5a. This work only de-duplicates it and fixes its absolute-date fallback; it does not add ticking clocks, `Intl.RelativeTimeFormat`, or new call sites.
- **Custom date-picker inputs.** All 24 `<input type="date">` fields (across 12 files) exchange `YYYY-MM-DD` on the wire regardless of the setting and render per **OS** locale, which the app cannot control. Honouring `dateFormat` in inputs means replacing all 24 with bespoke parse/validate/a11y logic.
- **Two-column CSV** (raw ISO + formatted). Rejected on evidence — see §6.
- **Currency / number locale.** `formatMoney` hardcodes `en-GB` (`document.formatter.ts:9`). No regional currency setting exists; out of scope.
- **`Warehouse.timezone`** (`schema.prisma:212`) — a separate per-warehouse display field, untouched.

## 3. Architecture

```
Settings (Mongo)   timezone · dateFormat · timeFormat
        │
        ├── getRegionalSettings()  ──► document.formatter.ts ──► PDFs · emails · CSVs (new)
        │
        └── GET /settings/branding (PUBLIC, +3 fields)
                    │
                    ▼  server-side fetch in app/layout.tsx
              RegionalProvider   (seeded by prop — no flash)
                    │
                    ▼
              useRegionalFormatter()  ──► lib/datetime.ts ──► 39 call sites
```

**Single source of truth, two implementations.** Backend and frontend each use their own platform's `Intl` call; neither imports the other's code. They are held to identical behaviour by a **shared test-vector table** (§8) rather than shared code.

### Why the public branding endpoint

`GET /settings` requires auth *and* the `settings.view` permission (`settings.routes.ts:20-22`). Two things follow:

- A client-side fetch **flashes** — the server renders defaults, the client swaps after the request resolves.
- The **customer portal breaks**. Customer principals hold a hardcoded `["stock.view"]` (`types/principal.ts:70`) and `requirePermission` only bypasses for `principal.type === "admin"` (`auth.middleware.ts:152`), so a customer gets 403.

`GET /settings/branding` is already public (`settings.routes.ts:15-16`) and already SSR'd through `fetchBranding()` (`lib/branding.ts:30-43`) into `RootLayout` (`app/layout.tsx:37`) and down as a prop to `BrandingProvider` (`providers/BrandingProvider.tsx:15-22`). Adding three fields there gets flash-free SSR and portal coverage for free.

Timezone and date format are not confidential — branding is already public — so widening the payload leaks nothing.

## 4. The formatter — `frontend/src/lib/datetime.ts`

A pure module with no React import, unit-testable under the existing Vitest setup (`frontend/vitest.config.ts`; no jsdom needed).

```ts
export type DateStyle = "numeric" | "medium" | "compact";

export interface FormatOptions {
  style?: DateStyle;      // default "numeric"
  fallback?: string;      // default "—"
  now?: number;           // formatRelative only — injectable clock, defaults to Date.now()
}

formatDate(value, regional, opts?): string
formatDateTime(value, regional, opts?): string
formatTime(value, regional, opts?): string
formatRelative(value, regional, opts?): string   // migrated existing behaviour — see §5a
todayInTimezone(regional): string        // "YYYY-MM-DD" for <input type="date">
```

**Styles** — all three honour `dateFormat`'s day/month ordering:

| Style | `DD/MM/YYYY` | `MM/DD/YYYY` | `YYYY-MM-DD` | Used by |
|---|---|---|---|---|
| `numeric` | `20/07/2026` | `07/20/2026` | `2026-07-20` | Tables, detail fields, CSV |
| `medium` | `20 Jul 2026` | `Jul 20, 2026` | `2026 Jul 20` | PO/PRF lists, cards |
| `compact` | `20 Jul` | `Jul 20` | `07-20` | Chart axes |

`formatTime` renders `18:30` or `6:30 PM` per `timeFormat`. All variants resolve parts via `Intl.DateTimeFormat` with `timeZone` set — **this is what fixes the browser-timezone bug**; a naive `new Date(x).toLocaleDateString(locale)` cannot.

**Configurable fallback** is load-bearing, not cosmetic. UI wants `—`; CSV cells must be empty (`fallback: ""`) or the export contains em-dashes; a future API path may want `null`. `null` / `undefined` / unparseable input all take the fallback.

Fallback precedence, highest wins:

```
caller's opts.fallback   →   module default ("—")
```

There is no third tier and no per-call-site override beyond `opts`. A caller passing `fallback: ""` gets an empty string; a caller passing nothing gets `—`. The CSV path always passes `""` explicitly rather than relying on a separate default, so the behaviour is visible at the call site.

**Internal structure.** All four public helpers wrap one private `formatParts(value, regional, intlOpts)` that owns the single `Intl.DateTimeFormat` construction, the timezone application, the fallback check and the `dateFormat` reordering. Adding a future variant means adding a wrapper, not another `Intl` call. This stays **private** — no generic `format()` is exported, because a public escape hatch would let components bypass the named helpers and reintroduce ad-hoc formatting, which is the exact problem this design exists to remove.

**Invariant — formatting is presentation-only.** Formatted output is a display string and nothing else. Business logic, sorting, filtering, equality checks and date arithmetic operate on the underlying `Date` / ISO value, never on formatter output. Concretely, `if (formatDate(a) === formatDate(b))` is a bug: under `compact` style two different years compare equal, and any style silently conflates instants that fall on the same local day. Compare timestamps; format only at the point of render.

**`todayInTimezone`** replaces `new Date().toISOString().slice(0,10)` at the seven form-seed sites, fixing the wrong-day bug described in §1.

### The hook

```ts
const { formatDate, formatDateTime, formatTime, formatRelative, today } = useRegionalFormatter();
```

Named functions, pre-bound to the active regional settings. Components never thread `regional` manually and never call `Intl` directly.

## 5. Frontend migration — 39 call sites

Grepping `toLocaleDateString|toLocaleTimeString|toLocaleString(|Intl.DateTimeFormat|toISOString().slice` over `frontend/src` returns 54 hits across 34 files. **15 of those are `number.toLocaleString()`** — not dates, not touched: `inventory/SummaryCards.tsx` (5), `inventory/EngineersOverview.tsx` (2), `inventory/detail/InventoryDetailPage.tsx` (4), `inventory/StockPositionTable.tsx` (3), and one number hit elsewhere. The real count is **39 across 29 files**.

| Group | Count | Action |
|---|---|---|
| Shared module helpers — `poStatus.tsx:79`, `inventoryStatus.tsx:30,38`, `jobStatus.tsx:98,106`, `grnStatus.tsx:46`, `portalUi.tsx:19,27`, `auditDisplay.ts:169,173` | 6 files | Rewrite to accept `regional`; downstream consumers update for free. `prfStatus.tsx:6` re-exports `poStatus` and follows automatically. |
| Inline `toLocaleDateString("en-GB", …)` in detail/list views | ~20 | Replace with `formatDate` / `formatDateTime` |
| Locale-less calls — genuine hydration bugs | 3 | `auditDisplay.ts:169`, `auditDisplay.ts:173`, `MovementFeed.tsx:141` |
| `Topbar.tsx:40` — the lone `en-US` | 1 | Normalise |
| Duplicate `relativeTime` implementations — `auditDisplay.ts:158`, `SessionsCard.tsx:44` | 2 defs / 10 usages | Collapse into `formatRelative` (§5a); delete the `SessionsCard` copy |
| `toISOString().slice(0,10)` form seeds | 7 | → `todayInTimezone()`. Sites: `GoodsReceiptForm.tsx:53`, `PurchaseRequestForm.tsx:48`, `PurchaseOrderForm.tsx:52`, `PurchaseOrderDetail.tsx:554`, `AddStockForm.tsx:24`, `AdjustStockForm.tsx:19`, `TransferForm.tsx:19` |
| `toISOString().slice(0,10)` export **filenames** | 4 | **Left alone** — ISO in a filename is correct and sorts properly. `audit.service.ts:63`, `inventory.service.ts:207`, `stockPosition.service.ts:78`, `stockPosition.service.ts:123` |
| `number.toLocaleString()` | 15 | **Not touched** |

Full inline list (20): `GoodsReceiptDetail.tsx:341`, `WarehouseDetail.tsx:36,876`, `SupplierDetail.tsx:33,518`, `SpendTrendChart.tsx:31,34`, `UsersView.tsx:518`, `UserDetail.tsx:20`, `PurchaseOrderDetail.tsx:1091`, `PurchaseRequestDetail.tsx:633`, `IrmItemDetail.tsx:35,566`, `OverdueHoldingsView.tsx:45`, `DamagedStockView.tsx:25`, `StockEntryDetail.tsx:426`, `CustomerDetail.tsx:93`.

## 5a. Relative time — already present, must be handled

An earlier draft of this design deferred relative time on the grounds that nothing used it. **That was wrong.** Relative time is live in the app today, with **two duplicate implementations** and **10 call sites**:

| Implementation | Note |
|---|---|
| `components/dashboard/audit/auditDisplay.ts:158` | Exported; `just now` / `Nm ago` / `Nh ago` / `Nd ago`, then falls back to an absolute date past 30 days |
| `components/account/SessionsCard.tsx:44` | Private duplicate of the same logic |

This intersects the current work at exactly one point. `auditDisplay.ts:169` — the >30-day fallback — is `new Date(iso).toLocaleDateString()` **with no locale argument**, one of the three hydration-mismatch sites listed in §5. Fixing it means routing that fallback through `formatDate`, which means `relativeTime` needs `regional`.

The 10 call sites: `SessionsCard.tsx:163`, `AuditLogPanel.tsx:289`, `GoodsReceiptDetail.tsx:341`, `ActivityFeed.tsx:62`, `OverviewView.tsx:135`, `IrmItemDetail.tsx:567`, `PurchaseOrderDetail.tsx:1091`, `PurchaseRequestDetail.tsx:633`, `SupplierDetail.tsx:519`, `WarehouseDetail.tsx:877`.

The prevailing UI pattern pairs the two: the visible cell shows relative time, and its `title` attribute shows the absolute timestamp (`GoodsReceiptDetail.tsx:341`, `PurchaseOrderDetail.tsx:1091`, `PurchaseRequestDetail.tsx:633`, `SupplierDetail.tsx:518`, `IrmItemDetail.tsx:566`, `WarehouseDetail.tsx:876` — all currently hardcoding `"en-GB"` in the tooltip). Those tooltips are already counted in §5's inline group.

Note that `ActivityFeed.tsx:62` and `OverviewView.tsx:135` (Dashboard Home) reach relative time *without* an absolute-date sibling, so Home must be included in the §9 migration sweep even though §5's grep finds only `SpendTrendChart.tsx` there.

**Decision — de-duplicate, do not redesign.** `relativeTime` moves into `lib/datetime.ts` as `formatRelative(value, regional, opts?)`, exposed through `useRegionalFormatter()`:

- The relative thresholds and wording (`just now`, `5m ago`, `3h ago`, `12d ago`) are **preserved exactly**. No `Intl.RelativeTimeFormat`, no wording changes.
- Only the **>30-day absolute fallback** changes — it now honours `dateFormat` and `timezone` instead of using the browser default. This is a bug fix, not a feature.
- `SessionsCard.tsx:44`'s duplicate is deleted in favour of the shared one.
- **No ticking clock.** The value is computed at render, exactly as today. Nothing re-renders on a timer, so no new hydration surface is introduced beyond what already exists.

The genuinely deferred piece is **making relative time reactive** (a `setInterval` that ages "2h ago" into "3h ago" without a re-render). Nothing does that today, it would introduce server/client divergence, and it is independent of all three regional settings. Out of scope.

`formatRelative` is therefore in scope as a *migration* of existing behaviour, not as the new feature the earlier draft rejected.

**Counting note.** §5's 39 and this section's 10 are **separate populations, not overlapping totals.** §5 greps for `toLocale*` / `Intl.DateTimeFormat` / `toISOString().slice`; a bare `relativeTime(x)` call matches none of those. Six sites appear in both lists only because they render relative text *and* carry a hardcoded `"en-GB"` tooltip — in those, the tooltip is the §5 item and the call is the §5a item. Total distinct work items: **39 + 10 − 6 overlapping files = 43 edits across 33 files**, plus the 2 duplicate definitions.

## 6. Backend — CSV exports

### Audience determination

The two-column hedge (raw ISO + formatted) was considered and **rejected on evidence**. All four exports are human-facing reporting files:

- **Formula-injection guard.** All four `csvEscape` copies prefix `'` to any cell starting with `=`, `+`, `-`, `@`, tab or CR — a defence that only makes sense if Excel or Sheets opens the file. The comment at `audit.service.ts:188` says so outright.
- **Display fusion.** `inventory.service.ts:558` emits `` `${warehouseName} (${warehouseCode})` `` — two fields welded into one string, actively hostile to parsing.
- **Conditional redaction.** `aggregation.service.ts:204-215` blanks `Value (GBP)` for customer-owned and damaged rows. A machine consumer would break on a sometimes-populated column.
- **No import counterpart.** The only CSV parser in the repo is the customer-site import (`lib/siteImport.ts:22-25`), whose columns have zero overlap; its template and report are `.xlsx`. No `papaparse`, no `csv-parse`, no upload route.
- **No primary key.** None of the four emit a row id, so round-tripping is impossible regardless.
- **Docs agree.** `docs/Senthra_Complete_Business_Flow.md:631,669,714` frames each as "Export: Excel / CSV" under reporting headings; the Sage mention at `:672` is a manual hand-off ("downloads report *for* accounts"), not a wired pipeline.
- **UI labels.** All four buttons read "Export CSV" with titles like "Export the filtered list to CSV" (`AuditLogPanel.tsx:166`, `InventoryView.tsx:156`, `StockPositionTable.tsx:383`, `MovementFeed.tsx:129`), delivered via a synthetic `<a download>` click (`lib/download.ts`).

Verdict: **human, four for four.** Format the dates; no ISO column needed.

### Changes

| Export | Service | Header change |
|---|---|---|
| `/audit/export.csv` | `audit.service.ts:204-217` | `When (UTC)` → `When` |
| `/inventory/export.csv` | `inventory.service.ts:552-566` | `Last Movement (UTC)` → `Last Movement` |
| `/inventory/positions/export.csv` | `aggregation.service.ts:197-216` | `Last Movement (UTC)` → `Last Movement` |
| `/inventory/movements/export.csv` | `movement.service.ts:309-317` | `Date (UTC)` → `Date` |

Each service takes `getRegionalSettings()` and formats its date cells through `document.formatter.ts` with `fallback: ""`.

**Accepted risk:** a `DD/MM/YYYY` cell can be misread by Excel depending on the opening machine's regional settings. This is inherent to formatted dates in CSV and is the cost of the chosen option; the two-column variant remains an easy follow-up if it bites in practice.

### Shared `csvEscape`

The helper is copy-pasted verbatim in four services — `audit.service.ts:188`, `inventory.service.ts:536`, `aggregation.service.ts:183`, `movement.service.ts:294`:

```ts
const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
return /["\n,\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
```

It moves to one shared CSV export utility under `backend/src/utils/`, with its own tests, so **new exports reuse it by default** rather than copying a fifth time. Behaviour is unchanged — this is a pure de-duplication done while the files are already open.

## 7. Copy corrections

- `CompanyProfileSection.tsx:168` — "Used by documents, exports and emails" becomes true once §6 lands; keep as-is.
- `settings.service.ts:182` — comment claims "documents, emails, audit display, exports". Audit display is client-side and never consumed regional; correct the comment.
- Six hardcoded `placeholder="dd-mm-yyyy"` hints contradict `MM/DD/YYYY` and `YYYY-MM-DD`. Sites: `GoodsReceiptForm.tsx:533`, `PurchaseOrderForm.tsx:444,450`, `PurchaseRequestForm.tsx:366,394,398`. Native `<input type="date">` supplies its own OS-locale hint, so these are removed rather than made dynamic.

## 8. Testing

**Frontend unit tests** — `frontend/src/lib/datetime.test.ts`, pure logic, no new test infrastructure:

- 3 `dateFormat` values × `12h`/`24h`, across all three styles.
- **Timezone actually applies** — an instant that falls on a *different calendar day* in `America/New_York` vs `Europe/London`.
- **DST boundaries** — London late-March and late-October transitions; New York's, which fall on different dates.
- **Leap year** — 29 Feb 2028 formats correctly in all three orders.
- **Year boundary crossing** — `31 Dec 23:00 America/New_York` renders as 1 Jan in `Europe/London`.
- **`todayInTimezone`** across the UTC-midnight edge — the wrong-day bug from §1.
- **`formatRelative` parity** — the preserved thresholds (`just now` <60s, `Nm ago` <60m, `Nh ago` <24h, `Nd ago` <30d) assert identically to today's `auditDisplay.ts:158` output, with a fixed injected "now" so the test is deterministic. The >30-day branch asserts it honours `dateFormat` and `timezone` instead of the browser default.
- `null` / `undefined` / unparseable input → configured fallback; `fallback: ""` yields an empty string, not `—`.

**Shared test vectors** — one fixture table of `(instant, timezone, dateFormat, timeFormat) → expected string`, asserted by *both* the frontend and backend suites. This is what enforces "same behaviour, different implementations" (§3).

**Backend** — extend the existing `document.formatter.test.ts` patterns to the four CSV services; new tests for the shared `csvEscape` utility covering formula injection, embedded commas, quotes and newlines.

**Manual sweep** — set `America/New_York` · `MM/DD/YYYY` · `12h`, then walk: Dashboard → Audit → Inventory → Stock Positions → Movements → PO → PRF → GRN → Jobs → Customer portal → Topbar; download one CSV and one PDF; hard-refresh to confirm no hydration warning and no flash.

## 9. Rollout

Ordered so each phase is independently shippable and verifiable. Migration is **incremental by module** — a formatter defect surfaces after one module, not after twenty-nine.

| # | Phase | Verify |
|---|---|---|
| 1 | Public `/settings/branding` carries the 3 regional fields | `pnpm typecheck` · `lint` · `test`; curl the endpoint |
| 2 | Extract shared `csvEscape` + format the 4 CSV exports, drop `(UTC)` | Backend tests; download all four CSVs |
| 3 | `lib/datetime.ts` + full test suite incl. shared vectors | `pnpm test` both sides |
| 4 | `RegionalProvider` + `useRegionalFormatter()`, SSR-seeded | Hard refresh — no flash, no hydration warning |
| 5 | Migrate **one** module (Purchase Orders — has both list and detail dates) | Flip settings, verify visually |
| 6…N | Repeat per module: Inventory → Movements → Audit → Jobs → GRN → PRF → Customers → Suppliers → Warehouses → IRM → Users → Portal → Topbar → Home chart | Verify after each |
| N+1 | Collapse the 2 `relativeTime` duplicates into `formatRelative`; delete `SessionsCard.tsx:44` | Parity tests green; check Account → Sessions and one audit table |
| N+2 | Form seeds → `todayInTimezone()` | Check near UTC midnight |
| N+3 | Remove 6 misleading placeholders; fix `settings.service.ts:182` comment | Read-through |

### Decision log

| Decision | Rationale |
|---|---|
| Regional on public branding, not a new endpoint | Flash-free SSR reuses the proven `BrandingProvider` path; unblocks the customer portal, which cannot call `/settings` |
| Shared contract, not shared code | Each platform uses its own `Intl`; a shared vector table enforces parity without a cross-boundary import |
| Configurable fallback | CSV must not emit `—`; UI wants it. Hardcoding either is wrong for the other |
| Format CSV dates, drop `(UTC)` | Seven independent signals say human-facing (§6); the formula-injection guard is decisive |
| Extract `csvEscape` to a shared utility | Four verbatim copies; extracting while already editing all four prevents a fifth |
| Incremental module-by-module migration | 39 replacements in one sweep hides which change broke what |
| `formatRelative()` **in scope**, reversing an earlier draft | The earlier draft deferred it on the false premise that nothing used relative time. Verification found 2 duplicate implementations and 10 live call sites, one of which (`auditDisplay.ts:169`) is a hydration-mismatch bug this work must fix anyway. Scope is de-duplication + regional-aware fallback only; wording and thresholds are preserved verbatim |
| Reactive/ticking relative time deferred | Nothing re-renders on a timer today; adding one would create genuine server/client divergence and is independent of all three settings — YAGNI |
| Date inputs deferred | Native inputs exchange `YYYY-MM-DD` regardless of setting and render per OS locale; a custom picker is its own project |
| Filename ISO stamps kept | ISO in filenames sorts correctly and is not user-facing prose |
| Exact counts **kept**, with a staleness note | Review suggested replacing them with "all existing call sites" to avoid going stale. Rejected: that phrasing is unfalsifiable — you cannot tell whether the migration finished. The counts are the survey evidence and the rollout's completion check; the header note handles drift |
| No public generic `format()` | Review suggested exposing `format(value, {dateStyle, timeStyle, fallback})` for extensibility. The shared-implementation instinct is adopted **internally** (`formatParts`), but exporting it would let components bypass the named helpers and reintroduce ad-hoc formatting — the exact problem being fixed. Future variants add a wrapper |
| Fallback precedence documented; presentation-only invariant stated | Both adopted from review. The invariant guards against `formatDate(a) === formatDate(b)`, a plausible mistake given the API returns strings |
