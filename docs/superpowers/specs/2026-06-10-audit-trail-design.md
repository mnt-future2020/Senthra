# Audit Trail — Read Side & UI (production-grade)

**Date:** 2026-06-10
**Status:** Design — awaiting review

## Problem

The audit trail is half-built. Entries are **written** correctly across the app
(`audit.record(...)` is called from `auth`, `user`, `role`, `customer`, `email`,
`jobTitle`, `department` services), the Prisma `AuditLog` model exists with
indexes on `action`, `(targetType, targetId)` and `createdAt`, and an
`audit.view` permission is already in the RBAC catalog.

But there is **no way to read the log**:

- `audit.repository.ts` has an unused `findRecent()` with no filtering/pagination.
- There is **no** `audit.controller.ts`, `audit.routes.ts`, `audit.validation.ts`,
  and no read method in `audit.service.ts`.
- Audit routes are **not mounted** in `routes/index.ts`.
- The frontend has **no** audit service, page, UI, or nav entry.

The system diagram references an audit trail; the project intends one. This spec
finishes the **read side end-to-end** and surfaces it in the dashboard as a
production-grade, filterable audit log.

## Scope

In scope:
- Backend: paginated + filterable read API for `AuditLog`, gated by `audit.view`.
- Backend: a **CSV export** endpoint honoring the same filters, streaming all
  matching rows (capped), gated by `audit.view`.
- Frontend: a new top-level **Audit Log** nav item (`/dashboard/audit`) with a
  filterable, paginated table, a row-click **detail drawer** showing all fields
  incl. formatted metadata, and an **Export CSV** button that exports the current
  filtered view.

Out of scope (explicitly):
- No change to how entries are **written** (the write path already works).
- No new audit event types.
- No editing/deleting audit entries — the trail is immutable by design.

## Diagram alignment

Per the system board (`docs/diagrams/Senthra.png`, Admin → **"Reports & audit
trails"**), the audit trail is specified as **"EVERY action in the system gets
logged"** — listing stock scanned IN, stock dispatched OUT, stock returned,
engineer-to-engineer transfer, threshold changed, report generated, and user
login/logout — sitting alongside a custom-reports/export node. Two implications,
both already satisfied by this design:

- The read API and UI are **generic over `action` / `targetType`**, so the
  not-yet-built stock/inventory/engineer events will appear automatically once
  those modules call `audit.record(...)` — no audit-side change needed.
- The diagram pairs auditing with **report generation / export**, which is
  exactly what the CSV export endpoint provides.

## Decisions (from brainstorming)

- **UI:** full filterable table (server-side filters + pagination), matching the
  existing `AuditLog` indexes.
- **Placement:** new top-level "Audit Log" sidebar entry, gated by `audit.view`,
  route `/dashboard/audit`.
- **Detail:** row click opens a **side drawer** with all fields and the metadata
  JSON formatted.
- **CSV export:** server-side endpoint honoring the current filters, streaming
  **all matching rows** (not just the current page), capped at a safe maximum.
  Gated by `audit.view`. Triggered by an **Export CSV** button in the panel.

## Backend design

All new code mirrors the existing module conventions (see `customer` and
`jobTitle` modules for the exact patterns): strict layering
`route → middleware → controller → service → repository → Prisma`, `#modules/*`
alias for cross-module imports, `.js` extensions, repositories the only place
Prisma is touched.

### 1. `audit.repository.ts` — add filtered list + count + distinct actions

Add to the existing repo (keep `create`; `findRecent` may stay or be removed —
it is currently unused, so remove it to avoid dead code):

- `AuditListFilters` shape: `{ search?, action?, actorType?, targetType?, from?, to? }`.
- `buildWhere(filters)` → `Prisma.AuditLogWhereInput`:
  - `action` → exact match on `action`.
  - `actorType` → exact match on `actorType`.
  - `targetType` → exact match on `targetType`.
  - `from` / `to` → `createdAt: { gte, lte }` (parsed `Date`s).
  - `search` (case-insensitive `contains`) → `OR` over `actorEmail`,
    `targetLabel`, `targetId`, `action`.
- `findMany(filters, skip, take)` → ordered `createdAt desc`.
- `count(filters)`.
- `findForExport(filters, take)` → like `findMany` but no `skip`, ordered
  `createdAt desc`, bounded by `take` (the export cap). Used by the CSV endpoint.
  (A single bounded `findMany` is simpler than cursor-streaming and the cap keeps
  it memory-safe; if the cap ever needs to grow past what's comfortable to hold
  in memory, switch this to a cursor-paged loop without touching callers.)
- `distinctActions()` → `prisma.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } })` so the UI's action filter dropdown is populated from real data. (Small table, distinct is fine; if it grows we can hard-code the catalog later.)

### 2. `audit.service.ts` — add `listAuditLogs`

Add a read method alongside the existing `record()`:

- `ListAuditParams` = filters + `page?`, `pageSize?`.
- `PagedAuditLogs` = `{ entries, total, page, pageSize, totalPages }`.
- `listAuditLogs(params)`:
  - Clamp `pageSize` to `[1, 100]`, default `25` (mirror `listCustomers`).
  - Validate `actorType` against the known set
    (`admin | user | customer | system`); ignore unknown (no filter).
  - Parse `from`/`to` to `Date`; ignore invalid.
  - `count` → `totalPages` → clamp `page` → `findMany(skip, take)`.
  - Map rows to a `PublicAuditEntry` DTO (id, actorId, actorType, actorEmail,
    action, targetType, targetId, targetLabel, metadata, createdAt). Pass
    `metadata` through as-is (it is already JSON).
- `listActions()` → thin pass-through to `repo.distinctActions()` returning
  `string[]`.
- `exportAuditCsv(params)` → reuses the **same filter normalization** as
  `listAuditLogs` (extract that into a shared `normalizeFilters(params)` helper so
  the list and export can never diverge), calls `repo.findForExport(filters, CAP)`
  with `CAP = AUDIT_EXPORT_MAX` (e.g. `50_000`), and serializes the rows to a CSV
  **string**. Columns: `When (ISO 8601 UTC), Action, Actor Type, Actor Email,
  Actor Id, Target Type, Target Id, Target Label, Metadata`. `metadata` is
  `JSON.stringify`'d into a single cell. Every field is RFC-4180 escaped (wrap in
  quotes, double any embedded quote) — a small local `csvEscape()` helper, no new
  dependency. Returns `{ csv, count, capped }` where `capped` is true when the
  result hit `CAP` (so the controller / UI can note the truncation). Define
  `AUDIT_EXPORT_MAX` in `config/env.ts` if it should be tunable, else a module
  const.

### 3. `audit.validation.ts` — query parsing helpers (new file)

No body validation needed (read-only GET). Provide small typed parsers for the
query string, used by the controller (consistent with how `customer.controller`
reads `req.query` directly via `queryInt`). Keep it minimal — a function that
takes `req.query` and returns a clean `ListAuditParams`. (If we prefer, fold this
into the controller; a separate `.validation.ts` keeps the module shape uniform.)

### 4. `audit.controller.ts` (new file)

- `listAuditLogs` — reads `search, action, actorType, targetType, from, to,
  page, pageSize` from `req.query`, calls the service, returns
  `{ entries, total, page, pageSize, totalPages }`.
- `listActions` — returns `{ actions }` for the filter dropdown.
- `exportAuditCsv` — reads the **same** query filters (no `page`/`pageSize`),
  calls `audit.service.exportAuditCsv(...)`, then sets:
  - `Content-Type: text/csv; charset=utf-8`
  - `Content-Disposition: attachment; filename="audit-log-<YYYY-MM-DD>.csv"`
    (date from the request time; safe ASCII filename)
  - sends the CSV string. (Optional: prepend a UTF-8 BOM so Excel opens accented
    text correctly.) If `capped` is true, also set a header like
    `X-Audit-Export-Capped: true` so the UI can surface a "first N rows" notice.
- All wrapped in `asyncHandler`. No `actorFrom` needed (reads don't audit).

### 5. `audit.routes.ts` (new file)

```
router.use(requireAuth);
router.get("/",           requirePermission("audit.view"), audit.listAuditLogs);
router.get("/actions",    requirePermission("audit.view"), audit.listActions);
router.get("/export.csv", requirePermission("audit.view"), audit.exportAuditCsv);
```

No limiter on the list/actions reads (consistent with other read endpoints). The
export does heavier work, so add a dedicated **`exportLimiter`** to
`rateLimit.middleware.ts` (same shape as `writeLimiter`/`testEmailLimiter`, e.g.
~10 requests / 5 min per IP) and apply it to `/export.csv`. Mirror `jobTitle.routes`
for imports/structure.

### 6. Mount in `routes/index.ts`

```
import auditRoutes from "#modules/audit/audit.routes.js";
...
router.use("/audit", auditRoutes);
```

### Error handling

Standard module behavior: invalid filters are **ignored** (fall back to no
filter / defaults) rather than throwing — a typo'd query returns an unfiltered
page, never a 500. Genuine failures bubble to the central error middleware. No
new `HttpError` cases are expected on a read endpoint.

## Frontend design

Mirrors existing dashboard conventions: a `*.service.ts` wrapper over `api()`, a
`page.tsx` gated by `PermissionGate`, a self-contained panel component, the
shared `Pagination`, `Skeleton`, `StatusBadge`, `Modal` UI primitives, and the
`var(--*)` theme tokens.

### 1. Types — `src/types/audit.ts`

`AuditEntry` (the DTO above) and `PagedAuditLogs`.

### 2. Service — `src/services/audit.service.ts`

- `listAuditLogs(params)` → builds the query string from the filter params and
  calls `api<PagedAuditLogs>("/audit?...")`.
- `listAuditActions()` → `api<{ actions: string[] }>("/audit/actions")` for the
  dropdown (can be cached module-level like `jobTitle.service`).
- `exportAuditCsv(params)` → the CSV endpoint returns a file, not JSON, so this
  one bypasses the JSON `api()` wrapper and makes a direct authenticated request
  for a **blob**: a small dedicated axios call (or `fetch`) against
  `env.apiUrl + "/audit/export.csv?<filters>"` with `withCredentials: true` and
  `responseType: "blob"`, then triggers a browser download — create an object URL
  from the blob, click a temporary `<a download="audit-log-<date>.csv">`, and
  revoke the URL. Reads the `Content-Disposition` filename if present (fallback to
  a dated default) and surfaces the `X-Audit-Export-Capped` header so the panel
  can toast "Exported the first N rows". Centralize the download mechanics in a
  tiny `lib/download.ts` helper (`downloadBlob(blob, filename)`) since it's
  reusable. Note: a blob request gets the cookie but **not** the silent
  refresh-on-401 that `api()` provides — acceptable here (the user is already on
  an authenticated page); on a 401 we surface "Your session expired, refresh and
  try again."
- Components call the service, never `api()` directly.

### 3. Nav — `Sidebar.tsx`

Add a `ScrollText` (lucide) nav item:
`{ href: "/dashboard/audit", label: "Audit Log", icon: ScrollText, perms: ["audit.view"] }`.
The existing `NAV.filter(perms.some(can))` already hides it from users without
`audit.view`.

### 4. Page — `src/app/dashboard/audit/page.tsx`

```tsx
<PermissionGate anyOf={["audit.view"]}>
  <Suspense><AuditLogPanel /></Suspense>
</PermissionGate>
```

### 5. Panel — `src/components/dashboard/audit/AuditLogPanel.tsx`

Self-contained client component:

- **Header**: title + short description, with an **Export CSV** button on the
  right. The button calls `audit.service.exportAuditCsv(currentFilters)`, shows a
  loading/spinner state while the download is prepared, is disabled when the
  current result `total` is `0`, and toasts on success (and on the capped case,
  "Exported the first N rows — narrow the filters for a smaller export").
- **Filter bar**: search input (debounced), action dropdown (from
  `listAuditActions`), actor-type dropdown (admin/user/customer/system),
  target-type dropdown (derived from a small static list or distinct), and a
  from/to date range. A "Clear filters" affordance when any filter is active.
- **Table** columns: **When** (relative + absolute on hover), **Action** (a
  badge — colored by verb: created/updated/deleted/login), **Actor**
  (email + type chip), **Target** (`targetType: targetLabel`). Each row is
  clickable.
- **States**: `Skeleton` rows while loading; a friendly empty state ("No audit
  entries match these filters"); an error `Notice` on failure.
- **Footer**: shared `Pagination` (server-driven `page`/`totalPages`/`total`).
- Filters + page held in component state; on change, refetch. (Optionally synced
  to the URL via `useSearchParams` like the users panel — nice-to-have, not
  required for v1.)

### 6. Detail drawer — `AuditEntryDrawer.tsx`

On row click, open a right-side drawer (built with the existing `Modal`
primitive styled as a slide-over, or a simple fixed panel matching the app's
drawer style) showing:

- Action, full timestamp, actor (id + email + type), target (type + id + label).
- **Metadata**: pretty-printed JSON in a monospace, scrollable block (collapsed
  gracefully when `metadata` is null/empty).
- Close on backdrop click / Esc / close button.

### Display helpers

- An `actionLabel`/`actionColor` map turning `"customer.project.created"` into a
  human label ("Project created") and a color, with a sensible fallback for
  unmapped actions (humanize the dotted key). Kept in the audit component folder.

## Data flow

```
UI filter change
  → audit.service.listAuditLogs(params)
  → GET /audit?search=&action=&actorType=&targetType=&from=&to=&page=&pageSize=
  → requireAuth → requirePermission("audit.view")
  → audit.controller.listAuditLogs (parse query)
  → audit.service.listAuditLogs (clamp/validate, paginate)
  → audit.repository.findMany + count (Prisma, indexed)
  → { entries, total, page, pageSize, totalPages }
  → table renders; row click → AuditEntryDrawer(entry)

Export CSV click
  → audit.service.exportAuditCsv(sameFilters)   // blob request, withCredentials
  → GET /audit/export.csv?search=&action=&actorType=&targetType=&from=&to=
  → requireAuth → requirePermission("audit.view") → exportLimiter
  → audit.controller.exportAuditCsv (parse query)
  → audit.service.exportAuditCsv (normalize filters, cap at AUDIT_EXPORT_MAX)
  → audit.repository.findForExport (Prisma, indexed, bounded)
  → text/csv attachment (+ X-Audit-Export-Capped when truncated)
  → browser downloads audit-log-<date>.csv
```

## Verification

Backend (no test runner — per CLAUDE.md): `pnpm typecheck` + `pnpm lint` clean.
Manual: `GET /audit` returns paginated entries; filters narrow results;
`/audit/actions` returns the distinct action list; `GET /audit/export.csv` (with
filters) downloads a well-formed CSV honoring those filters, with correct
`Content-Type`/`Content-Disposition`, RFC-4180-escaped fields (verify a metadata
cell containing commas/quotes/newlines round-trips), and the cap + capped header
when exceeded; a non-`audit.view` principal gets 403 on all three; an
unauthenticated request gets 401.

Frontend: `pnpm lint` clean; `pnpm build` succeeds. Manual: nav item appears only
for `audit.view` holders; table loads, filters + pagination work against the live
backend; row click opens the drawer with formatted metadata; **Export CSV**
downloads the filtered rows (and opens cleanly in Excel/Sheets, accents intact);
empty/error/loading states render; export button disabled at `total === 0`.

## Files

**Backend**
- `src/modules/audit/audit.repository.ts` — *edit* (add `buildWhere`,
  `findMany`, `count`, `findForExport`, `distinctActions`; drop unused
  `findRecent`).
- `src/modules/audit/audit.service.ts` — *edit* (add `normalizeFilters`,
  `listAuditLogs`, `listActions`, `exportAuditCsv` + `csvEscape`, DTO + paged
  types, `AUDIT_EXPORT_MAX`).
- `src/modules/audit/audit.validation.ts` — *new* (query parsing, shared by both
  the list and export endpoints).
- `src/modules/audit/audit.controller.ts` — *new* (`listAuditLogs`,
  `listActions`, `exportAuditCsv`).
- `src/modules/audit/audit.routes.ts` — *new*.
- `src/middleware/rateLimit.middleware.ts` — *edit* (add `exportLimiter`).
- `src/routes/index.ts` — *edit* (mount `/audit`).

**Frontend**
- `src/types/audit.ts` — *new*.
- `src/services/audit.service.ts` — *new* (incl. `exportAuditCsv` blob download).
- `src/lib/download.ts` — *new* (`downloadBlob(blob, filename)` helper).
- `src/components/dashboard/shell/Sidebar.tsx` — *edit* (nav item).
- `src/app/dashboard/audit/page.tsx` — *new*.
- `src/components/dashboard/audit/AuditLogPanel.tsx` — *new* (incl. Export CSV
  button).
- `src/components/dashboard/audit/AuditEntryDrawer.tsx` — *new*.
- `src/components/dashboard/audit/auditDisplay.ts` — *new* (label/color helpers).
