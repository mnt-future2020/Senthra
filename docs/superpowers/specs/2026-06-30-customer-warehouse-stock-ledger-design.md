# Customer Warehouse Stock Transaction ledger — design (approved, deferred)

**Date:** 2026-06-30 · **Status:** ✅ **Approved architecture — deferred (not release-blocking).** Build only when
the business actually needs a complete customer-warehouse audit trail. This is an enhancement to the audit model,
not a fix for a broken workflow, so it must not delay release. · **Relates to:** the Stock Movement History audit,
finding #1.

## Problem

Customer-owned stock **at a warehouse** is held in `CustomerStockEntry.quantity` — a bare running balance with
**no transaction ledger** (it is the customer-side twin of `InventoryBalance`, but the matching twin of
`InventoryTransaction` does not exist). Every operation that changes it produces no ledger row, so these
stock-affecting movements are **absent from the unified Stock Movement History**:

| Operation | Write site (today) | Ledger today |
|---|---|---|
| Receipt into warehouse (entry create) | `customer.repository.ts` create (`:760/:820`) | none |
| Warehouse→warehouse transfer | `customer.repository.ts` transfer (`:983` decrement src, `:1001/:1008` inc/create dest) | none |
| Job issue — **warehouse-out leg** | `goods-management.service.ts:500` `adjustCustomerStockEntryQtyTx(-qty)` | none (van-in leg **is** ledgered) |
| Job return — **warehouse-in leg** | `goods-management.service.ts:1043` `adjustCustomerStockEntryQtyTx(+qty)` | none (van-out leg **is** ledgered) |
| Damaged-restore → warehouse | `goods-management.service.ts:1714` `incrementCustomerStockEntryTx` | none (damaged-out leg **is** ledgered) |
| Manual entry edit that changes qty / delete-with-qty | `customer.repository.ts:793/:895/:907` | none |

Consequence: one-sided movements in the history (e.g. a customer restore shows the damaged-out leg with no
visible destination) and no chain-of-custody / reconciliation for customer goods at warehouses.

## Proposed model — `CustomerWarehouseStockTransaction`

The customer-warehouse twin of `InventoryTransaction`, shaped identically to the four existing delta ledgers so it
drops straight into the unified Stock Ledger. **Loose sockets (no `@relation`)** + snapshots — matching
`EngineerCustomerStockTransaction` — so **no existing model is touched**.

```prisma
// Immutable, append-only ledger for customer-owned stock held AT a warehouse — the customer-warehouse
// twin of InventoryTransaction. Loose sockets + snapshots (no relations), like the other customer ledgers.
model CustomerWarehouseStockTransaction {
  id                   String   @id @default(auto()) @map("_id") @db.ObjectId
  customerStockEntryId String   @db.ObjectId
  customerId           String?  @db.ObjectId   // snapshot — filter by customer
  warehouseId          String   @db.ObjectId
  warehouseName        String?  // snapshot — avoids a name resolver in the read path

  itemName String   // snapshot (customer stock has no shared catalogue)
  sku      String?  // snapshot

  quantityDelta Int     // + receipt/return-in/transfer-in/restore  − issue-out/transfer-out/damage-out
  type          String  // goods_in | issue | return | transfer_in | transfer_out | adjust | write_off | restore | opening_balance
  sourceType    String  // customer_stock_receipt | customer_stock_transfer | goods_management |
                        // goods_management_return | damaged_restore | stock_adjustment | opening_balance
  sourceId      String  @db.ObjectId
  sourceCode    String?
  balanceAfter  Int     // CustomerStockEntry.quantity after applying this row
  notes         String?
  createdBy     String?
  createdAt     DateTime @default(now())

  @@index([customerStockEntryId])
  @@index([warehouseId])
  @@index([customerId])
  @@index([sourceType, sourceId])
  @@index([createdAt])   // required for the unified-ledger keyset
}
```

## Write-path changes

Introduce one forget-proof helper that pairs the balance change with the ledger row in the **same transaction**,
mirroring how `inventory.service.applyInbound/applyOutbound` already guarantee it for company stock:

```ts
// goods-management (or a new customer-stock) repository — tx-aware, the ONLY way to move warehouse customer qty.
applyCustomerWarehouseDelta(tx, {
  customerStockEntryId, customerId, warehouseId, warehouseName, itemName, sku,
  delta, type, sourceType, sourceId, sourceCode, createdBy,
}): Promise<{ balanceAfter: number }>   // = adjustCustomerStockEntryQtyTx(delta) + insert ledger row (skip if delta === 0)
```

Then route every quantity mutation through it:
- **Job issue / return / restore** (`goods-management.service.ts:500 / :1043 / :1714`) — replace the raw
  `adjustCustomerStockEntryQtyTx` / `incrementCustomerStockEntryTx` calls. The matching van leg already writes
  `EngineerCustomerStockTransaction`, so this completes the **double-entry**.
- **Transfer** (`customer.repository.ts` transfer txn) — emit two legs: `transfer_out` (source −) and `transfer_in`
  (dest +), sharing one `sourceCode`. The flow is already inside a `withTransaction`.
- **Receipt** (entry create with qty > 0) — `type: "goods_in"`, `sourceType: "customer_stock_receipt"`,
  `balanceAfter = initial qty`.
- **Manual edit that changes qty / delete-with-qty** — `type: "adjust"` / `write_off` for the delta (only when
  quantity actually changes; metadata-only edits emit nothing).

Atomicity is unchanged: the insert lives in the existing transaction, so a ledger-write failure rolls back the
balance change exactly as company-stock movements already do.

## Integration with the unified Stock Ledger (read side)

Additive — a fifth `LedgerKind`, no change to the existing four:
- **`movement.ts`** — add `fromCustomerWarehouseTxn(row)` → `ownership: "customer"`, `locationType: "warehouse"`,
  `itemKind: "customer_stock"`, name/sku/warehouse from the row snapshots (no resolver needed). `labelFor` already
  covers the verbs.
- **Finder** — `findCustomerWarehouseTxnPage(filters, before, take)` (same keyset `[createdAt desc, id desc]`),
  filterable by date / customerId / warehouseId / customerStockEntryId / type / sourceType.
- **`movement.service.selectLedgers`** — add `customerWarehouse` to `ALL_LEDGERS` and to the relevant branches:
  `ownership=customer` ✓, `locationType=warehouse` ✓ (so warehouse = inventory **+** customerWarehouse),
  `warehouseId` ✓, `customerId` ✓; excluded by `ownership=company`, `locationType=engineer|damaged`,
  `engineerId`, `irmItemId`. `CAN_EMIT.customerWarehouse = {goods_in, issue, return, transfer_in, transfer_out,
  adjust, write_off, restore, opening_balance}`.
- **`queryUnified`** — add the customerWarehouse fetch task; `mapPage` needs **no new resolver** (snapshots).
- **Engineer scope** — `listEngineerMovements` restricts to `["engineer","engineerCustomer"]`, so
  customerWarehouse is **never** returned to an engineer. No scoping change; engineers still cannot see warehouse
  stock. (Verified-safe by construction.)

After this, a customer job issue shows **both** legs (warehouse-out `customerWarehouse −` + van-in
`engineerCustomer +`); transfers show two warehouse legs; receipts/restores show their inbound leg —
full double-entry, and `balanceAfter` makes every `CustomerStockEntry` reconstructable from the ledger.

## Can it be added without affecting existing functionality?

**Yes — additive and non-breaking, with two caveats to decide on.**

- **Schema:** a brand-new model with loose sockets → **no edits to any existing model**, and on MongoDB Prisma adds
  it via `prisma generate` + index creation (`db push`) with **no data migration** and no touch to existing
  collections.
- **Write paths:** changes are *additional inserts inside existing transactions*; the balance mutation itself is
  unchanged. The main risk surface is editing the ~6 write sites — each is a localized "also record the leg",
  guarded by tests asserting the ledger row is written (mirror the existing `insertEngineerTxnTx` call-assertions in
  `goods-management.service.test.ts`).
- **Read paths:** the existing four-ledger behaviour is untouched; the admin feed simply *starts showing* the
  previously-missing customer-warehouse legs. **Frontend needs no change** — same DTO; the existing
  `ownership=customer` + `location=warehouse` filter combo (which returns empty today) starts returning data.
- **Performance:** one extra indexed ledger query per page; no extra resolver (snapshots). Negligible.

**Caveat 1 — historical backfill (decision needed):** existing `CustomerStockEntry` rows have no prior ledger, so
history before deployment stays absent. Optional one-time backfill: emit an `opening_balance` row per active entry
equal to its current `quantity`, so balances reconcile from a known baseline going forward. Not required for
correctness of new movements; recommended if the ledger must reconcile to today's on-hand.

**Caveat 2 — timezone of date filters** is unchanged (UTC day bounds, consistent with the rest of the feed).

## Decision

**Approved as architecture, deferred — do not delay release for it.** The current Stock Movement History is
production-grade and complete for company stock (all locations) and engineer-held consignment; the customer-warehouse
ledger is an audit-completeness enhancement, not a fix for a broken workflow.

**Implement only when the business genuinely needs a complete customer-warehouse audit trail** (e.g. a customer
chain-of-custody/reconciliation requirement). When that trigger arrives, the build is exactly as specified above:
the new `CustomerWarehouseStockTransaction` model + the `applyCustomerWarehouseDelta` helper, route the six write
sites through it, add the fifth ledger kind to the read union, and ship an `opening_balance` backfill so the unified
ledger reconciles to on-hand. Until then, this document stands as the agreed blueprint.
