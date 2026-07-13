# Dashboard Home — Design Spec

**Date:** 2026-07-09
**Status:** Approved for implementation
**Branch (planned):** `feat/dashboard-home`

## Problem

`/dashboard` has no screen of its own — `frontend/src/app/dashboard/page.tsx` redirects to the
first permitted section via `firstDashboardPath()`, so a super-admin lands on **Settings** after
login. The app needs a real, production-grade landing page: a role-aware operations dashboard in
the visual language of the `reference/` starter UI (stat cards with sparklines, interactive SVG
area chart, bar panel, tables — all CSS-variable themed), with content designed for Senthra's own
domains (procurement, jobs, inventory), at the quality bar of Zoho-class ERPs.

The `reference/` folder is used for **visual design only** (layout, class names, component
structure — per its README). All data, widgets, and behavior are designed fresh for this project.

## Design principles (binding)

These exist to stop the dashboard from ever growing into a god module:

1. The dashboard is **read-only** — the only mutations it offers are navigation (Quick Actions
   link into owning modules; nothing is created/edited on the dashboard itself).
2. The dashboard is **not a reporting module** and never becomes one. Deep analytics belong to
   owning modules (e.g. the supplier Procurement tab).
3. **Every number links to its owning module** (card → filtered list, worklist row → detail page,
   activity row → entity).
4. The dashboard owns **no business logic** — every metric definition lives in the owning
   module's repository; the dashboard service only permission-gates and orchestrates.
5. The dashboard owns **no data persistence** — no dashboard collections, no snapshots, no cache
   tables.
6. **Every widget has exactly one owner module:**

   | Widget | Owner |
   |---|---|
   | Pending PRFs card | purchase-request |
   | Open POs card | purchase-order |
   | Active Jobs card | job |
   | Low Stock card | inventory (+ IRM thresholds) |
   | Spend Trend chart | purchase-order |
   | PO Pipeline chart | purchase-order |
   | Recent Activity | audit |
   | Awaiting Your Action | dashboard orchestration only (rows sourced from owning repos) |

## Layout

```
Overview                          [+ New PRF] [+ New PO] [+ New Job] [Goods In]

┌────────────┬────────────┬────────────┬────────────┐
│ Pending    │ Open POs   │ Active     │ Low Stock  │   ← KPI cards + sparklines
│ PRFs       │ (count+£)  │ Jobs       │            │
└────────────┴────────────┴────────────┴────────────┘
┌────────────────────────────────────────────────────┐
│ Awaiting Your Action  (role-aware worklist)        │   ← THE widget, full width
└────────────────────────────────────────────────────┘
┌──────────────────────────────┬─────────────────────┐
│ Spend Trend (12-mo area)     │ PO Pipeline (bars)  │
└──────────────────────────────┴─────────────────────┘
┌────────────────────────────────────────────────────┐
│ Recent Activity (operational feed from audit)      │
└────────────────────────────────────────────────────┘
```

Work-first ordering is deliberate: users log in to finish work, so the worklist sits above the
charts (Zoho/ServiceNow pattern). Spend is analytics and lives in the chart row, not a KPI card.

Responsive: 4-col cards → 2-col (tablet) → 1-col (mobile); chart row stacks on tablet; all
sections single-column on mobile.

## Widgets

### KPI cards (permission-gated; grid reflows when a card is hidden)

| Card | Definition | Permission |
|---|---|---|
| **Pending PRFs** | count of PRFs with `status = "submitted"` (awaiting Finance review) | `purchase_requests.view` |
| **Open POs** | count + total £ (`grandTotalPence` sum) of POs in any non-terminal, not-fully-received status (`draft` → `partially_received`; excludes `fully_received`, `closed`, `cancelled`) — same "open" definition as the supplier procurement summary | `purchase_orders.view` |
| **Active Jobs** | count of jobs with `status ∈ {assigned, accepted, in_progress}` | `jobs.view` |
| **Low Stock** | count of IRM items with `trackInventory = true`, a `reorderLevel` set, and total on-hand (sum of `InventoryBalance.quantityOnHand` across the actor's accessible warehouses) ≤ `reorderLevel`. Sub-stat: **N critical** — same test against `criticalLevel`. | `inventory.view` |

**Sparklines (honest data only):** we store no historical snapshots, so sparklines show 8-week
**created volume** (new PRFs / new POs / new jobs per ISO week from `createdAt`) — real activity
trend, not a fabricated history of the headline count. The Low Stock card has no created-series,
so it shows the "N critical" chip instead of a sparkline. No fake data anywhere.

Each card links to its owning list pre-filtered (e.g. Pending PRFs → PRF list filtered to
`submitted`).

### Awaiting Your Action (role-aware worklist)

Union of queues relevant to the signed-in principal — a row appears only if the actor holds the
row's permission (and, where noted, is the assigned user):

| Queue | Source | Shown to |
|---|---|---|
| Review PRF | PRFs `status = submitted` | `purchase_requests.approve` |
| Approve PO (fast-path) | POs `status = draft` with `purchaseRequestId` set | `purchase_orders.approve` |
| Review PO | POs `status = pending_approval` | `purchase_orders.approve` |
| Send to supplier | POs `status = pm_review` **and** `pmUserId = actor.id` | `purchase_orders.send` |
| Record acceptance | POs `status = sent` **and** `pmUserId = actor.id` | `purchase_orders.acknowledge` |
| Receive goods | POs `status ∈ {sent, supplier_accepted, partially_received}`, warehouse-scoped | `goods_in.create` |
| Review kit request | Job kit requests pending PM review | `jobs.kit_request.review` |

**Priority order (spec'd so ordering is never a mystery):**

1. **Overdue** — `expectedDeliveryDate` (or the queue's natural due date) in the past
2. **Due today**
3. **High/urgent priority** (`priority ∈ {high, urgent}` where the entity has one)
4. **Oldest pending first** (age descending within each band)

Row shape: type badge, code (link to detail), supplier/customer/title, age ("3 d"), primary
action label. Capped at **10 rows** with a total count + "view all" link to the relevant list.
Empty state: "All clear ✓ — nothing needs your action."

### Charts

- **Spend Trend** — 12-month area chart of **issued spend**: sum of `grandTotalPence` for POs
  that reached the supplier (`status ∈ {sent, supplier_accepted, partially_received,
  fully_received, closed}`), bucketed by `orderDate` month. Cancelled orders excluded.
  Interactive hover crosshair + tooltip, adapted from the reference `OverviewTab` area chart
  (hand-rolled theme-aware SVG, ResizeObserver width). Permission: `purchase_orders.view`.
- **PO Pipeline** — current count per non-terminal status (`draft`, `pending_approval`,
  `approved`, `pm_review`, `sent`, `supplier_accepted`, `partially_received`) as the reference's
  bar panel; each bar links to the PO list filtered to that status. Permission:
  `purchase_orders.view`.

### Recent Activity

Last **10 audit events**, rendered as an operational feed — type badge + human phrasing + entity
link ("PO-0021 sent to supplier", "PRF-0003 approved") — using the existing audit display
formatting, not raw audit rows. Sourced from audit alone (approvals, sends, goods-in, job
assignment, kit requests are all already audit events — no new event infrastructure).
Permission: `audit.view`.

### Quick Actions (top-right, permission-gated)

| Button | Target | Permission |
|---|---|---|
| + New PRF | `/dashboard/purchase-requests/new` | `purchase_requests.create` |
| + New PO | `/dashboard/purchase-orders/new` | `purchase_orders.create` |
| + New Job | `/dashboard/jobs/new` | `jobs.create` |
| Goods In | `/dashboard/goods-in/new` | `goods_in.create` |

Every target already has a dedicated create route, so Quick Actions are plain permission-gated
links — no query-param mechanism needed. **No "Goods Out" button** — the standalone Goods Out
module was removed (superseded by Job Pack).

On narrow viewports the four buttons collapse into a single **"+ New" dropdown** (the label ERP
users recognize); on desktop they render as individual buttons with no group heading.

## API

### `GET /dashboard/summary`

Route: `rateLimit → requireAuth → controller`. No body/query params in v1 (adding a query param
later is inherently non-breaking, so nothing is pre-reserved).

Grouped, widget-shaped response. **A missing key = the actor lacks that section's permission**
(the server never computes it); **an empty array/zero = permitted but no data** (FE shows an
empty state):

```jsonc
{
  "summary": {
    "generatedAt": "2026-07-09T09:52:11.000Z",   // when the summary finished computing (no persistence)
    "cards": {
      "pendingPrfs": { "count": 4, "weeklyCreated": [1,0,2,3,1,0,4,2] },      // omitted w/o purchase_requests.view
      "openPos":     { "count": 12, "valuePence": 1842000, "weeklyCreated": [...] },
      "activeJobs":  { "count": 7, "weeklyCreated": [...] },
      "lowStock":    { "count": 5, "criticalCount": 2 }
    },
    "charts": {
      "spendTrend":  [{ "month": "2025-08", "totalPence": 240000 }, ...],     // 12 entries
      "poPipeline":  [{ "status": "draft", "count": 3 }, ...]
    },
    "worklist": { "items": [ { "kind": "review_prf", "id": "...", "code": "PRF-0007",
                   "title": "...", "priority": "high", "dueDate": "...", "ageDays": 3,
                   "href": "/dashboard/purchase-requests/..." } ], "total": 14 },
    "activity": [ { "id": "...", "at": "...", "actorName": "...", "summary": "...",
                    "entity": { "type": "purchase_order", "code": "PO-0021", "id": "..." } } ]
  }
}
```

All sections computed in a single `Promise.all`. Warehouse-scoped actors get warehouse-filtered
numbers everywhere a warehouse dimension exists (Open POs, Low Stock, Receive-goods queue,
pipeline, spend) via the existing `warehouseScopeFilter(actor)` helper — no new scoping logic.

**No server-side cache** (decision log below).

## Backend architecture

New module `backend/src/modules/dashboard/`:

- `dashboard.routes.ts` — `GET /summary` (mounted at `/dashboard` in `routes/index.ts`)
- `dashboard.controller.ts` — thin, no logic
- `dashboard.service.ts` — permission checks per section + `Promise.all` over owning-repo
  aggregation calls + worklist merge/sort. **No repository of its own** (principle 5).

Aggregations live in **owning repositories** (the only Prisma layer):

- `purchase-request.repository`: pending count, weekly-created series, submitted worklist rows
- `purchase-order.repository`: open count/value, status counts, spend-by-month, weekly-created
  series, per-queue worklist rows (fast-path drafts, pending_approval, pm_review/sent for a
  given `pmUserId`, receivable)
- `job.repository`: active count, weekly-created series
- `job-kit-request.repository`: pending kit-request worklist rows (kit requests are their own module)
- `inventory.repository`: low-stock + critical counts (IRM thresholds × `InventoryBalance`
  on-hand sums, warehouse-scoped; Mongo aggregation or a two-step fetch — implementation's
  choice, kept inside the repository)
- `audit.repository`: recent activity (limit 10)

Worklist ordering is a **pure exported comparator** in the dashboard service (unit-testable).
Month/week bucketing helpers are pure functions.

## Frontend architecture

- `frontend/src/app/dashboard/page.tsx` becomes the real Overview screen (redirect removed).
  If the summary comes back with **no visible sections at all**, render the existing
  `NoAccessHome` content in place.
- **Sidebar**: "Dashboard" becomes the first nav item for all staff; login lands on `/dashboard`.
  `firstDashboardPath()` remains for deep-link fallbacks elsewhere.
- `frontend/src/services/dashboard.service.ts` — `getDashboardSummary()` typed wrapper.
- Components in `frontend/src/components/dashboard/home/`: `StatCard`, `SpendTrendChart`,
  `PipelineBars`, `WorklistPanel`, `ActivityFeed`, `QuickActions` — visual language adapted from
  `reference/tabs/OverviewTab.tsx` (CSS-variable theming `var(--border)`/`var(--faint)`,
  sparkline SVGs, interactive area chart with hover tooltip, status badges).
- **Loading**: skeleton cards/chart placeholders (no full-page spinner), matching section layout
  to avoid shift.
- **Empty vs hidden**: no-permission → section absent (server didn't send it; consistent with
  sidebar/tab gating everywhere else — never an empty "No purchase orders" card that leaks module
  structure). Permitted-but-empty → friendly empty state.
- Staff-only surface; the customer portal is untouched (customers never see pricing — spend data
  never reaches a customer principal because every pricing section requires staff permissions).

## Decision log

| Decision | Outcome | Why |
|---|---|---|
| Aggregated endpoint vs FE composition vs per-widget endpoints | **One `GET /dashboard/summary`** | One round trip; permission/warehouse/role-aware server-side; FE stays dumb; matches the supplier-summary precedent |
| KPI set | **Work-first** (Pending PRFs, Open POs, Active Jobs, Low Stock); spend demoted to chart | Users log in to see "what needs attention", not "what we spent" |
| Worklist position | **Above charts** | Work queues beat analytics on an ERP landing page |
| Response shape | **Grouped `{cards, charts, worklist, activity}`** | Adding widgets later is non-breaking |
| Server-side 15–30 s cache | **Rejected (v1)** | ~6 cheap counts/groupBys in one `Promise.all` on a small dataset; a cache would make the work queue stale right after the user acts on it — worse than the query cost. Add later behind the same endpoint only if measured slow |
| Reserved-but-ignored `?range=` param | **Rejected** | GET query params are additive; pre-shipping an ignored param is fake future-proofing |
| Widget-provider plugin pattern | **Rejected (YAGNI)** | ~6 widgets from known modules; explicit permission checks match every other module; mechanical to refactor later if widget count triples |
| Separate notifications/assignments feed infrastructure | **Rejected; spirit kept** | Everything wanted (approvals, sends, goods-in, assignments) is already an audit event; feed = audit rendered operationally |
| "Goods Out" quick action | **Rejected** | Module removed (Job Pack superseded it) |
| Sparklines of historical headline counts | **Rejected; created-volume series instead** | No snapshots exist; fabricating history would be fake data |
| Dashboard design principles section | **Added** | Prevents god-module growth |
| Explicit worklist priority order | **Added** | Ordering must never be a mystery to users |
| `generatedAt` timestamp in response | **Added** | Answers "is this today's data?"; one line, no persistence; FE shows "Updated X ago" |
| `version` field in response | **Rejected** | Grouped contract makes additions non-breaking; no other endpoint versions responses; unread field is dead weight |
| Quick-actions "Create/New" group label | **Partially adopted** | Desktop buttons are self-labelled; mobile collapses them into a single "+ New" dropdown |

## Testing

- **Backend (vitest)** — `dashboard.service.test.ts`: each section omitted without its permission
  key; warehouse scope passed through to repo calls; worklist comparator (overdue → due today →
  high priority → oldest); week/month bucketing edge cases (empty months zero-filled, 12-month
  window boundaries). Repo aggregation functions get focused tests where pure logic exists.
- **Frontend** — `pnpm build` + `pnpm lint`; manual role walkthrough: super-admin (everything),
  Finance (PRF/PO queues), PM (send/accept/kit queues), warehouse manager (receive queue +
  scoped numbers), a no-permission user (NoAccessHome).

## Out of scope (v1)

Widget customization/drag-drop, date-range filters, per-user layout persistence, exports,
server-side caching, a notifications system, supplier delivery-performance analytics (separately
deferred), customer-facing dashboards.
