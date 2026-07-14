# Kit Request — customer-stock requests + approve-modal polish

**Date:** 2026-07-14
**Status:** Approved (design)

## Problem

Two gaps in the additional-kit-request flow:

1. **Engineer can't request a NEW customer-stock item.** The composer's "Add another item"
   search (`KitItemSearch` → `GET /job-kit-requests/item-search`) hits only the company IRM
   catalogue (`irmRepo.findMany`). Customer stock appears only if it is already a planned kit
   line ("More of a planned item" table). An engineer who needs an extra customer-owned item
   that isn't already planned has no way to request it.

2. **Approve modal hides customer-stock / misc lines.** `ApproveDialog`'s "Pickup warehouse —
   per item" section iterates `irmLines` only (`l.source === "irm"`). A request line whose
   source is `customer_stock` (e.g. `mouse123`) never appears in the modal body — only in the
   subtitle — so the planner sees "one item" while the request clearly lists two. Confusing,
   reads like a bug.

Additionally the per-item warehouse picker uses a native `<Select>` dropdown; the ask is a
better, more visual clickable picker.

## Scope

In:
- Backend: `item-search` also returns the job's own customer stock (scoped, in-stock only).
- Frontend composer: search shows + can add customer-stock items.
- Frontend approve modal: show ALL lines (customer-stock/misc read-only), warehouse picker as
  clickable cards.

Out (unchanged):
- Approve / grow / fulfilment logic. It already handles `customer_stock` lines
  (`warehouseId: l.source === "irm" ? … : null`, service.ts:299) — customer stock issues from
  its stored location automatically.
- Line validation schema — `customer_stock` source is already accepted.

## Decisions

- **Stock scope:** same customer + in stock. Customer-stock search is scoped to the job's
  `customerId`, `status = "active"`, `quantity > 0`. Never leaks another customer's stock;
  never surfaces empty entries. (SECURITY-CRITICAL: the customerId filter is mandatory.)
- **Grouping:** one row per `CustomerStockEntry`. Each result row carries its exact
  `customerStockEntryId` (+ warehouse, qty, serial if serialized) so the approve step targets
  the precise entry, matching the model.
- **Approve UI for non-IRM lines:** read-only rows ("Customer stock · from stored location" /
  "Misc · no warehouse needed"); auto-issue behaviour unchanged. Fixes the missing-item
  confusion without touching backend logic.
- **Picker UI:** clickable warehouse cards (name · code · "N in stock", selected → tick +
  accent border), mirroring the engineer composer's item-search card style.

## Design

### 1. Backend — customer-stock in item-search

**Route/controller** (`job-kit-request.routes.ts` / `.controller.ts`):
`GET /job-kit-requests/item-search?q=&jobId=<id>`. `jobId` is OPTIONAL (backward-safe): when
present the response merges the job's customer stock; when absent it behaves exactly as today
(IRM only). Same `requirePermission("engineer.jobs.request_kit")`.

**Repository** (`goods-management.repository.ts`) — new finder:
```
searchActiveCustomerStock(customerId, term, take = 20)
  where: { customerId, status: "active", quantity: { gt: 0 },
           OR: [ { itemName: { contains: escapeRegex(term), mode: "insensitive" } },
                 { sku:      { contains: escapeRegex(term), mode: "insensitive" } } ] }
  orderBy: { itemName: "asc" }
  select: id, itemName, sku, uom, quantity, serialized, serialNumber,
          warehouseId, warehouse: { name, code }
```
Uses `escapeRegex` (utils/search.js) — Prisma+Mongo `contains` is raw regex (see project
memory: prisma-mongo-contains-regex). Mirrors `irm.repository.ts:77`.

**Service** (`job-kit-request.service.ts` `searchItems`): gains optional `jobId`. When set,
resolve the job → `customerId` (jobRepo.findById), then run the customer-stock finder and
merge. Result option type gains a discriminant:
```
KitItemOption =
  | { source: "irm"; irmItemId; code; name; sku; uom }
  | { source: "customer_stock"; customerStockEntryId; name; sku; uom;
      qty; warehouseName; serialNumber? }
```
IRM options keep their existing shape plus `source: "irm"` (additive — existing FE reads keep
working). Blank term still returns nothing. If the job is missing/soft-deleted, silently skip
the customer-stock half (return IRM only) rather than error — search must stay resilient.

### 2. Frontend — composer (`EngineerKitRequests.tsx` + `jobKitRequest.service.ts`)

- `searchKitItems(q, jobId?)` — append `&jobId=` when given. `KitItemSearch` takes a `jobId`
  prop from `RequestModal` (`job.id`).
- `KitItemOption` service type becomes the discriminated union above.
- `CartItem` gains `source: "irm" | "customer_stock" | "misc"` + `customerStockEntryId: string | null`.
  `addCustomerStock(opt)` with dedup key `cse:<customerStockEntryId>`.
- `KitItemSearch` result rows: IRM as today; customer-stock rows show a "Customer stock" badge
  + "`warehouse` · `qty` in stock" subtext (serial shown when present). Reuse the existing
  result-button styling.
- `excludeKeys` includes `cse:<id>` for cart customer-stock items AND planned customer-stock
  lines (so already-planned customer stock greys out).
- `buildLines`: cart customer_stock → `{ source: "customer_stock", customerStockEntryId,
  itemName, qty }`. Planned customer-stock path already emits this (line 224) — unchanged.

### 3. Frontend — approve modal (`JobKitRequestsReview.tsx`)

- The per-item section iterates ALL `request.lines`, not just `irmLines`:
  - `source === "irm"` → clickable warehouse-card picker (below), stock-aware defaults as today.
  - `source === "customer_stock"` → read-only row: item ×qty + muted "Customer stock · issued
    from its stored location". No picker, not part of `whComplete`.
  - `source === "misc"` → read-only row: item ×qty + muted "Misc · handed over, no warehouse".
- Warehouse picker → clickable cards: one card per warehouse option (`name (code) · N in
  stock`), click selects, selected card gets accent border + check icon. Same `whOptions` /
  `lineWh` state and stock-aware default; `whComplete` / `canSubmit` unchanged (still "every
  IRM line has a warehouse"). Unstocked-warning + "no warehouses configured" states preserved.
- `whComplete` derives from IRM lines only (already correct: `irmLines.every`).

## Data flow

Engineer types in search → FE debounced `searchKitItems(q, job.id)` → BE returns IRM +
customer-stock (scoped) → engineer adds → cart holds source + ids → submit builds lines
(`irm`/`customer_stock`/`misc`) → BE createKitRequest (schema already validates all three) →
planner opens ApproveDialog → IRM lines pick a warehouse (cards), customer-stock/misc shown
read-only → approve grows kit; customer-stock issues from stored location, misc handed over,
IRM issues from picked warehouse (all existing logic).

## Testing

- Backend has vitest (project memory: backend-has-vitest). Add unit tests for the customer-stock
  finder / merged `searchItems`: scoping to customerId, active+in-stock filter, regex-escaped
  term, missing-job resilience (IRM-only), blank term → empty.
- Frontend: manual verification via the running app (compose a request with a customer-stock
  item; approve it; confirm all lines show and the kit grows).

## Risks

- **Cross-customer leak** — mitigated by mandatory customerId scope + a test asserting another
  customer's stock never returns.
- **Serialized entries** — one row per entry already handles serials; qty on a serialized entry
  is typically 1. No special-casing beyond showing the serial.
- **Backward compat** — `jobId` optional and `source` additive on IRM options, so nothing that
  calls the old endpoint/shape breaks.
