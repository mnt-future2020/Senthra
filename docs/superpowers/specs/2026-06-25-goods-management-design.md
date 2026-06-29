# Goods Management — Design Spec

**Date:** 2026-06-25
**Status:** Approved design (pre-implementation)
**Author:** Shahul + Claude

## 1. Overview

Goods Management is the physical-stock workflow that connects a **job** to a **field engineer**: the warehouse manager (WM) issues the job's kit stock to the engineer by scanning it out, the engineer takes it to site, does the work, and returns the leftover/damaged stock, which the WM scans back in. Every movement updates the relevant inventory pool (company IRM, customer consignment, or damaged) and the engineer's own holdings, all through immutable ledgers.

This fills several existing gaps:
- Job statuses `in_progress` and `completed` are defined but have **no endpoints** (no "start work" / "complete work").
- Kit lines are **planning only** — there is no link to actual stock movement when an engineer collects stock.
- `GoodsOut` already issues **IRM** stock to engineers (warehouse-decrement + `EngineerStockBalance` + ledger) but is **intentionally hidden from the nav**, is IRM-only, has no returns, and is not job/scan driven.
- There is **no scan-to-look-up** capability anywhere (only barcode *generation/printing*).
- There is **no persistent damaged-stock pool** (damage is only captured at goods-receipt time and discarded from on-hand).

## 2. Goals / Non-goals

### Goals
- Job-scoped, scan-driven **issue** of kit stock (IRM **and** customer) from a warehouse to the assigned engineer, constrained to the job's kit list.
- Engineer **Start work** / **Complete work** lifecycle (wires the existing `in_progress` / `completed` statuses).
- Scan-driven **return** of leftover/damaged stock back to the warehouse, with a separate **Damaged** pool (write-off) for both company and customer stock.
- Track **engineer holdings** for both IRM and customer stock.
- **Engineer-declared consumption**: at **Complete work** the engineer records per-item **used quantity** + a **work summary** (what was done on site). Reconciliation then **verifies** `issued = used + returned(good) + returned(damaged)` and flags any **unaccounted (lost)** units, rather than silently assuming the remainder was consumed.
- A warehouse-manager **"Close & reconcile"** action that verifies the balance and **locks** the job's goods record (so it doesn't sit in `awaiting_return` forever).
- **Shortfall visibility:** the Goods Management queue shows **planned vs available** per kit line (since stock is decremented on scan, not reserved at accept), so the WM sees shortfalls before the engineer arrives.
- **Overdue/lost holdings:** an **"stock out > N days"** view of aging engineer holdings + a standalone **write-off (lost)** action, so holdings on jobs nobody closes don't pile up invisibly.
- **Customer audit trail:** damaged **customer** stock is visible on that customer's record (item, qty, reason, photo, date — **no pricing**).
- Three scan input methods that all converge to one look-up: hardware (keyboard-wedge) scanner, phone camera, and uploaded barcode photo. **Scan once per item, then enter/confirm the quantity** (stock is quantity-based, not one-scan-per-unit).
- **Photo + reason required** when marking an item damaged (evidence, especially for customer-owned stock).

### Non-goals (v1, YAGNI)
- Serial/batch-tracked items in issue/return (same limitation `GoodsOut` has today — block with a clear message).
- Pack-unit conversion (all quantities in base units).
- Damaged-stock **recover / dispose** actions — write-off only (the pool just records damaged units).
- Reservation at accept-time (stock is decremented on scan, not reserved on accept).
- Approval / sign-off gates on issue or return.
- The engineer scanning anything (engineer only Starts/Completes; **all scanning is the WM**).
- Engineer "confirm received" / mismatch flow — deferred (handover is trusted, in person).
- Return at a **different** warehouse than pickup — deferred to v2 (returns go to the pickup warehouse).

## 3. Actors & permissions

| Actor | Capabilities |
|---|---|
| **Warehouse Manager** (warehouse-scoped) | Issue (scan-out), Receive return (scan-in good/damaged, with photo+reason), **Close & reconcile** (verify + lock). Only for their assigned warehouse(s). |
| **Engineer** | Start work, Complete work (**enter per-item used qty + work summary**), view "My stock" (current holdings). Never scans. |
| **Office / Project Manager** | View Goods Management status per job (read-only). |

New permissions (existing `module.action` convention; new role-editor category **"Goods Management"**):
- `goods_management.view`, `goods_management.issue`, `goods_management.receive_return`, `goods_management.reconcile`
- `engineer.jobs.start`, `engineer.jobs.complete` (engineer portal)
- `engineer.inventory.view` (exists) for "My stock"

Warehouse-scoping is enforced on every endpoint (the existing `actor.isWarehouseScoped` / `assignedWarehouseIds` pattern).

## 4. Architecture

A new self-contained domain module `backend/src/modules/goods-management/` (controller → service → repository → validation → routes), mounted at `/goods-management`, following the strict layering and `#modules/*` conventions.

- **IRM movements reuse** the existing `InventoryBalance` / `InventoryTransaction` (warehouse) and `EngineerStockBalance` / `EngineerStockTransaction` (engineer) primitives — the same code paths `GoodsOut.dispatch` uses.
- **Customer movements** get **symmetric new** pieces (decrement `CustomerStockEntry.quantity`; new engineer-side customer holdings + ledger).
- **Damaged** gets a new pool + ledger covering both owner types.
- The hidden `GoodsOut` module is **left untouched** as a legacy/manual path. Goods Management is the new primary flow.
- All writes are **atomic in a single transaction** (header + balances + ledger) with the existing negative-stock guard and in-transaction live-balance re-check for concurrency.

## 5. Data model

### Movement record (header + lines) — one scan/entry session
- **`JobStockMovement`** — `jobId`, `direction` (`issue` | `return` | `consume`), `engineerId` (+ `engineerName`/`engineerEmail` snapshots), `warehouseId` (+ `warehouseName`/`warehouseCode` snapshots), `code` (auto `GM-####` via Counter), `status` (`draft` → `posted`), `performedBy`, `postedAt`, timestamps, soft-delete on draft.
  - `issue` / `return` are **WM scan sessions**. `consume` is the **engineer's declaration at Complete work** (per-item used quantities — *not scanned*, just entered).
- **`JobStockMovementLine`** — `movementId`, `source` (`irm` | `customer`), `irmItemId` **or** `customerStockEntryId` (at most one), item snapshot (name/sku/uom), `qty`, `condition` (`good` | `damaged` — only on returns), `scannedCode` (issue/return only), `jobKitLineId` (optional, links an issue line back to its planned kit line), `damagePhotoUrl` + `damageReason` (**required** when `condition=damaged`, photo via the existing Cloudinary attachment pattern), `notes`.
- **Quantity entry:** the WM scans an item **once** to identify the line, then enters/confirms the quantity (stock is quantity-based). One scanned `CustomerStockEntry` resolves to its single entry.

### Work completion (engineer declaration)
- At **Complete work** the engineer submits a **work summary** (free text — what was done on site) + per-item **used quantities**. This creates a `consume` movement that decrements the engineer's holding by the used amount and stores the summary. `workSummary` is stored on the `JobStockSummary` (or `consume` movement header).

### Engineer holdings
- IRM → **reuse** `EngineerStockBalance` / `EngineerStockTransaction`.
- Customer → **new** `EngineerCustomerStockHolding` (engineer × customerStockEntry × qty) + `EngineerCustomerStockTransaction` (append-only ledger). Snapshots customer + item for history.

### Damaged pool (write-off, both owner types)
- **`DamagedStockBalance`** — `warehouseId`, `ownerType` (`company` | `customer`), `irmItemId?` / `customerStockEntryId?`, `customerId?`, item snapshot, `quantity`.
- **`DamagedStockTransaction`** — append-only ledger of damaged movements (`reason`, `notes`, `sourceType=goods_management_return`, `sourceId`, `balanceAfter`, `createdBy`).
- Damaged units **never** re-enter usable stock in v1.

### Reconciliation tracking (per job)
- A small **`JobStockSummary`** record (owned by the goods-management module; `jobId` unique) holds the per-job `goodsStatus`: `not_issued` → `partially_issued` → `issued` → `awaiting_return` → `reconciled`, plus `workSummary` and `lastMovementAt` for queue sorting. Kept out of the `Job` model so the goods-management domain stays self-contained.
- Per-item *issued / returned-good / returned-damaged / consumed* is derived from the movement lines (issue / return / consume). **Close & reconcile** verifies, for every item, `issued = used + returned(good) + returned(damaged)`; any shortfall is flagged **unaccounted (lost)** and the WM books it as a write-off (or leaves the record open). On success the record is **locked** (`reconciled`).

## 6. Lifecycle & state machine

```
Job:    accepted ──(engineer: Start work)──▶ in_progress ──(engineer: Complete work)──▶ completed
Goods:  not_issued ─(WM scan-OUT)▶ partially_issued/issued ─(work)▶ awaiting_return ─(WM scan-IN)▶ reconciled
```

1. **Engineer accepts** (exists) → the job appears in the warehouse's Goods Management queue with engineer info + kit list.
2. **WM issues (scan-OUT, `direction=issue`):** scan each item → **decrement warehouse pool** (IRM `InventoryBalance`; customer `CustomerStockEntry.quantity`) → **increment engineer holding** (IRM `EngineerStockBalance`; customer `EngineerCustomerStockHolding`). Constrained to the kit list (item must be on the list; cumulative issued qty ≤ planned qty). Posting writes all ledgers atomically.
3. **Engineer: Start work** → job `accepted → in_progress` (new endpoint, engineer-scoped, atomic status guard).
4. **Engineer: Complete work** → engineer submits a **work summary** + per-item **used quantities** → job `in_progress → completed`. This posts a `consume` movement that **decrements the engineer holding** by the used amount (booked as installed/consumed). Stock may still be out — the physical return is tracked separately via `goodsStatus → awaiting_return`. (Used qty per item can't exceed current holding.)
5. **Engineer returns physically; WM receives (scan-IN, `direction=return`):** scan each item, set quantity, mark **good** (→ back into the originating warehouse pool) or **damaged** (→ **Damaged** pool, write-off, with **required photo + reason**). Decrements the engineer holding accordingly. Returns may be partial across multiple sessions. (Returned qty can't exceed what's still held.)
6. **WM: Close & reconcile:** verifies, per item, `issued = used + returned(good) + returned(damaged)`. Any shortfall (holding not back to 0) is flagged **unaccounted (lost)** → the WM books a write-off (a `consume` line with reason `lost`) or leaves the record open to chase. On success, `goodsStatus → reconciled` and the record is **locked**.

### Stock-movement matrix
| Event | Warehouse pool | Engineer holding | Damaged pool |
|---|---|---|---|
| Issue IRM | − InventoryBalance | + EngineerStockBalance | — |
| Issue customer | − CustomerStockEntry.qty | + EngineerCustomerStockHolding | — |
| Consume (engineer-declared at Complete work) | — | − holding (installed) | — |
| Return good (IRM) | + InventoryBalance | − EngineerStockBalance | — |
| Return good (customer) | + CustomerStockEntry.qty | − EngineerCustomerStockHolding | — |
| Return damaged (either) | — | − holding | + DamagedStockBalance |
| Close: unaccounted (lost) | — | − holding (written off) | — |

## 7. Scanning

All input methods converge to **one decoded string → one look-up**:
- **Hardware scanner / manual type:** a focused input captures the code string.
- **Phone camera:** decode client-side with `@zxing/browser` → string.
- **Photo upload:** decode the uploaded image client-side with the same library → string. (No new backend image-decode dependency.)
- **`POST /goods-management/scan-lookup`** `{ jobId, direction, code }` → resolves the code to an IRM item (by IRM code / barcode) or a `CustomerStockEntry` (by CSE barcode), validates against the kit list (issue) with remaining issuable qty, and returns the matched line (+ remaining). Off-list or over-qty → explicit rejection with a clear message.

## 8. UI surfaces

- **Warehouse detail → "Goods Management" tab:** queue of jobs whose kit lines pick up from this warehouse (engineer, status, issued/returned progress), with **planned vs available** per line (shortfalls highlighted). Drill into a job → **scanner panel** with a **Goods In / Goods Out toggle**, a running scanned list, per-item **good/damaged** selection on returns, and a **Post** action; plus the **Close & reconcile** action.
- **Warehouse detail → "Goods Management" → Overdue view:** a list of engineer holdings **out > N days** (configurable; default 14) with a **Write-off (lost)** action for stuck/unclosed jobs.
- **Engineer portal (job detail):** **Start work** button; **Complete work** opens a short form — **work summary** + per-item **used quantity** (pre-filled from what's held) — then submits. A **My stock** list shows current holdings (IRM + customer) and what is still out per job.
- **Warehouse detail → "Goods Management" → return panel:** marking a line **damaged** requires a **photo upload + reason** before it can be posted.
- **Warehouse detail → Inventory tab:** a **3rd toggle "Damaged"** beside Company (IRM) / Customer, listing damaged rows (item, owner, qty, reason, photo, warehouse).
- **Office Job detail:** read-only Goods Management status (issued/returned/consumed/damaged per line).
- **Customer detail page:** a read-only **"Damaged stock"** section listing that customer's damaged items (item, qty, reason, photo, date) — **no pricing**.

## 9. Realtime

Reuse the existing socket infrastructure:
- `emitToUser(engineerId, "goods:issued", …)` — notify the engineer when stock is issued to them.
- Office/warehouse room emits on issue/return/reconcile so the queue and inventory views refresh live.

## 10. Edge cases & safety

- **Customer-pricing safety:** customer stock and damaged-customer rows show **no cost/value** — only flag/qty/serial/location (consistent with the existing rule).
- **Concurrency:** re-read live balances inside the transaction before each decrement; abort on negative.
- **Over-issue / off-list scans:** rejected at look-up and re-validated at post.
- **Over-consume / over-return:** used qty can't exceed current holding; returned qty can't exceed what's still held; enforced server-side.
- **Damaged evidence:** a damaged return line **cannot post without a photo + reason**.
- **Unaccounted stock:** at Close, any item where `used + returned < issued` is surfaced and must be written off (lost) or left open — never silently absorbed.
- **Serial/batch items:** blocked from issue/return in v1 with a clear message (matches `GoodsOut`).
- **Partial issue/return:** supported; `goodsStatus` reflects partial states.
- **Warehouse scoping:** WM can only act on their assigned warehouse(s).
- **History:** snapshots on all movement lines; append-only ledgers; soft-delete on drafts only.

## 11. Open questions

None outstanding. All foundational decisions are locked:
- Entry point: warehouse tab **+** job-driven.
- Engineer carries **both** IRM and customer stock.
- Scanning: hardware **+** phone camera **+** photo upload.
- Damaged: separate pool, both owner types, write-off; **photo + reason required**.
- Reconciliation: engineer **declares used qty + work summary** at Complete work; WM **Close & reconcile** verifies `issued = used + returned(good) + returned(damaged)` and flags/writes-off any unaccounted (lost).
- Scanning: **scan once per item, then enter quantity** (not one-scan-per-unit).
- Issue constrained to the kit list.
- Job can be completed with stock still out (return tracked separately).
- Engineer does Start/Complete (+ used-qty/summary) only; **WM does all scanning + Close**.
- Queue shows **planned vs available** (shortfall warning).
- **Overdue ("out > N days") view** + standalone **write-off (lost)** action.
- **Damaged customer stock** shown on the customer's record (no pricing).
- **Deferred:** engineer confirm-received (#7), return at a different warehouse (#8).
