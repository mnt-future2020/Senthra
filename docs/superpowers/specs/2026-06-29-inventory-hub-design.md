# Inventory Hub — Production-Grade Inventory Module Design

**Date:** 2026-06-29
**Status:** Draft for review
**Owner:** Shahul

## 1. Purpose & Problem

Today's **Warehouse Inventory** page claims to show "live on-hand stock per item and warehouse" but it only reads a single pool: `InventoryBalance` — **company-owned stock physically in a warehouse**. Everything else the business is accountable for lives in separate screens and never rolls up:

| Stock reality | Backing model | Visible on Inventory today? |
|---|---|---|
| Company stock in a warehouse | `InventoryBalance` | ✅ |
| Customer consignment in a warehouse | `CustomerStockEntry` | ❌ |
| Stock out with engineers (on vans) | `EngineerStockBalance`, `EngineerCustomerStockHolding`, misc | ❌ |
| Damaged / write-off (company + customer) | `DamagedStockBalance` | ❌ |
| Reserved / outgoing & incoming (POs) | `quantityReserved` (=0), open POs | ⚠ partial (item detail only) |

**Goal:** turn Inventory into the single, production-grade place to see and act on **everything the company is responsible for**, organised by **Ownership × Current Location**, while *orchestrating* the existing modules rather than replacing them. No duplicated business logic.

## 2. Core Model: Ownership + Current Location

Inventory is no longer "warehouse stock." Every physical unit the company is accountable for is a **stock position** described by two axes:

- **Ownership:** `Company` | `Customer`
- **Current Location:** `Warehouse` | `Engineer` | `Customer Site` | `Damaged` | `Transit`

This pairing is the canonical domain concept. The views/lenses are simply filters over it; new locations (e.g. `Transit`, `Customer Site`) slot in without new "inventory concepts."

### Canonical DTO — `StockPosition`

A normalized, read-side shape that every pool maps onto:

```
StockPosition {
  itemId            // IRM item id OR customer-stock-entry id
  itemKind          // "irm" | "customer_stock"
  itemCode          // IRM-0001 / CSE-00001
  itemName          // snapshot
  sku               // nullable
  category          // nullable
  ownership         // "company" | "customer"
  customerId?       // present when ownership = customer
  customerName?     // snapshot
  locationType      // "warehouse" | "engineer" | "customer_site" | "damaged" | "transit"
  locationId        // warehouseId | engineerId | ...
  locationLabel     // "London Logistics Hub" | "Eng: Raj Patel" | "Damaged — London Hub"
  quantity          // on-hand at this position
  reserved          // company-warehouse only (0 until Goods-Out allocations live)
  available         // quantity - reserved
  unitCostPence?    // company only; OMITTED for customer/damaged-customer
  valuePence?       // company only
  status            // in_stock | low_stock | out_of_stock | on_van | damaged | overdue
  flags             // { highValue?, serialized?, overdue?, daysOut? }
  lastMovementAt
}
```

### Source mapping

| Ownership × Location | Source model | Notes |
|---|---|---|
| Company × Warehouse | `InventoryBalance` | has value & reserved |
| Company × Engineer | `EngineerStockBalance` | "on van"; counts toward totals |
| Company × Damaged | `DamagedStockBalance` (ownerType=company) | no restore today → new |
| Customer × Warehouse | `CustomerStockEntry` (status=active) | no value, ever |
| Customer × Engineer | `EngineerCustomerStockHolding` | "on van" |
| Customer × Damaged | `DamagedStockBalance` (ownerType=customer) | no value |
| Misc × Engineer | derived from posted issue movements (source=misc) | free-text, not stock-tracked |
| Company/Customer × Transit | (future) stock-transfer in-flight | reserved slot; not in v1 data, modelled in DTO |

## 3. Architecture: read layer & orchestration

### 3a. Read aggregation (the "All Inventory" engine)

A new **inventory aggregation service** in the `inventory` module assembles `StockPosition` records by **delegating counts to the existing repositories** of each owning module (service-to-service / repo reuse is permitted by the layering rules). It does NOT re-implement any counting logic.

**Decision — read-time aggregation that delegates to existing repositories.**
- Query each source repo with the active filters, normalize to `StockPosition`, merge, sort, paginate. Per-source queries stay indexed; the merge/sort is bounded by the active filters (warehouse, search, category, ownership, location).
- The API contract (`StockPosition` + summary aggregates) is the single stable boundary the frontend consumes, so the internal assembly can evolve without changing the UI.

Rationale: maximum reuse, zero duplicated business logic, no write-path changes, no consistency bugs.

### 3b. Action orchestration

The Hub **never owns business logic**. Each action routes to the existing service/pipeline:

| Lens | Actions | Routes to (reuse) | New? |
|---|---|---|---|
| Company | Add Stock, Move, **Adjust**, Export | `inventory.service` (addStock, createTransfer, csv) | **Adjust (downward correction)** is new — extends `inventory.service` + a `StockAdjustment` reason; same atomic ledger pattern |
| Customer | Receive, Return, **Transfer** | customer-stock + goods-management flows | Receive/Return exist; **warehouse↔warehouse Transfer for consignment** is new (mirror of company transfer, no value) |
| Engineer | Issue, Return, Reconcile | `goods-management.service` (postIssue/postReturn/closeReconcile) | exists |
| Damaged | Write-off, **Restore** | damaged-stock flow | Write-off exists; **Restore** (reverse a write-off back to usable `InventoryBalance`/`CustomerStockEntry`) is new — new ledger entry type, no silent mutation |

New logic lives in the **owning module's service**, never in the Hub/controller. The Hub calls it.

## 4. Inventory Hub — UI

### 4a. Layout
- **Summary card strip** (top): Company-in-warehouse (units + £ value, admin only), Customer consignment (units, no £), With engineers (units + overdue badge), Damaged (units + this-month delta). Clicking a card switches the lens.
- **Lens tabs:** `All Inventory` (default) · Company · Customer · Engineer · Damaged · Movements.
- **Shared filters:** search (item/SKU), warehouse, category; plus lens-contextual filters (ownership/location on All; owner sub-filter on Engineer; reason on Damaged; status on warehouse lenses).
- **Per-lens action bar:** the actions from §3b for the active lens, gated by the matching permission.

### 4b. Lenses

**All Inventory (default).** Every position regardless of ownership/location. Columns: Item, SKU, **Ownership**, **Current Location**, Qty, Available, Status, Last movement. Value column shown only for company rows (blank for customer/damaged), and only to permitted roles. This is the "search one place" view Operations/Admin asked for.

**Company.** Today's table unchanged (Item, SKU, Warehouse, Category, On hand, Reserved, Available, Value, Status). Actions: Add Stock, Move, Adjust, Export.

**Customer.** Item, SKU, Customer, Warehouse, Qty, Serial, High-value flag, Received. **No price/value.** Actions: Receive, Return, Transfer.

**Engineer.** Item, Owner (Company/Customer/Misc sub-filter), Engineer, Qty, Days-out, Overdue flag. Cross-warehouse rollup of everything issued out; the old Overdue view becomes a filter here. Actions: Issue, Return, Reconcile.

**Damaged.** Photo, Item, Owner, Warehouse, Reason, Qty, Last updated. Global rollup of the per-warehouse damaged view. No value. Actions: Write-off, Restore.

**Movements.** A cross-pool movement ledger — every stock event in one chronological, filterable timeline, not a position snapshot. Unifies `InventoryTransaction` (goods-in / add / transfer / adjust), `JobStockMovement` (issue / return / consume / lost), customer-stock transactions, and damaged write-off / restore. Columns: Date, Type, Item, Ownership, From → To (location), Qty Δ (signed), Reference code (GRN/TRF/ADJ/GM…), Actor. Filters: type, ownership, location, warehouse, date range, item. Read-only audit surface; rows deep-link to the originating record. Reuses each module's existing transaction repositories — no new ledger.

## 5. Item-level Inventory Detail (part of this module, not deferred)

Opening any inventory item shows a single page that answers "where is this item and what's happening to it," assembled from existing repositories:

1. **Overview** — identity, category, tracking flags.
2. **Current Position** — the item's headline state now: total on-hand across all locations, total available, total reserved, total value (company portion only), and per-status rollup. The "where it stands" summary, before the breakdown.
3. **Current Distribution** — the item's `StockPosition` rows broken out across every warehouse, every engineer, customer holdings, and damaged — the cross-pool "where exactly is it."
4. **Movement History** — unified ledger (`InventoryTransaction` + relevant `JobStockMovement` + customer-stock transactions) in one timeline.
5. **Reservations / Allocations** — reserved (Goods-Out) and incoming (open POs). Honest "0 / none yet" where the feature isn't live.
6. **Jobs using the item** — jobs whose kit lines reference it (planned/issued/used).
7. **Engineers currently holding it** — from `EngineerStockBalance` / `EngineerCustomerStockHolding`.
8. **Customer holdings** — consignment of this item per customer (when applicable).
9. **Audit Trail** — reuse the existing `audit` service, filtered to this item.

Each section is an independent unit reading from one source; no new business logic, only composition.

## 6. Permissions & safety
- Each lens & action gated by its existing permission (`inventory.view/adjust/move/export`, `goods_management.*`, customer-stock view, damaged view).
- Customer & damaged-customer rows never expose cost/value (existing rule).
- New actions (Adjust, Customer Transfer, Damaged Restore) follow the existing **atomic balance + append-only ledger + audit** pattern; no destructive in-place edits, no reuse-of-numbers.

## 7. What is reused vs new

**Reused as-is:** `inventory.service` (add/move/export, balances, transactions), `goods-management.service` (issue/return/reconcile, damaged listing, overdue), customer-stock receive, `audit` service, `DamagedStockView` and other existing list components, all repositories.

**New (each in its owning module, no Hub logic):**
- `inventory` aggregation service → `StockPosition` list + summary aggregates (the All-Inventory engine).
- Company **Adjust** (downward correction) on `inventory.service`.
- Customer **Transfer** (warehouse↔warehouse consignment) — mirror of company transfer.
- Damaged **Restore** (reverse write-off) on the damaged-stock flow.
- **Inventory Hub** frontend (cards, lens tabs, action bars) + **Inventory Detail** page (8 sections).
- Frontend `inventory.service` wrappers for the new endpoints.

## 8. Phasing (within one production delivery)
1. Read layer: `StockPosition` aggregation + summary endpoint; All-Inventory + the per-pool lenses + the Movements ledger rendering.
2. Wire existing actions into each lens (Company/Customer/Engineer); Export.
3. New actions: Adjust, Customer Transfer, Damaged Restore.
4. Inventory Detail page (8 sections).
5. Hardening: permissions, audit, CSV for All-Inventory, empty/zero states, realtime refresh via existing goods socket.

## 9. Open questions / explicit non-goals
- **Transit** location is modelled in the DTO but has no data source in v1 (no in-flight transfer state today) — rendered only when such data exists.
- **Reserved/outgoing** stays 0 until Goods-Out allocations are real; surfaced honestly.
