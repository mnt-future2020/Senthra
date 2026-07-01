# Stock Movement History — Unified Stock Ledger (design + as-built)

**Date:** 2026-06-30 · **Status:** Implemented · **Module:** `inventory` (+ `engineer` surface)

## Decision

Build a production-grade **Stock Movement History** as a **read-only, cursor-paginated unified view** over the
existing append-only delta ledgers — the system's only sources of truth for stock movement. No new table,
no duplicate data, no write-path changes. This mirrors the ERPNext *Stock Ledger Entry* / SAP material-document
model: when per-location ledgers already exist, the "history" is a query, not a new store.

Rejected alternatives: (B) a physical `StockMovement` table with dual-writes — duplicates data, needs a backfill,
touches every writer; (C) a CQRS read-model projection — correct only at very large scale, premature now. (C) is
the documented escape hatch if cross-collection reads ever become a bottleneck.

## Sources of truth — the four delta ledgers

Each row is **one leg at one stock location** (per-location double-entry: a transfer/dispatch is two rows tied by
`reference`/sourceCode). All four share the same shape (`quantityDelta`, `type`, `sourceType/sourceId/sourceCode`,
`balanceAfter`, `@@index([createdAt])`), differing only in scope:

| Ledger | Location / pool | locationType |
|---|---|---|
| `InventoryTransaction` | company stock in a warehouse (`irmItemId`+`warehouseId`) | `warehouse` |
| `EngineerStockTransaction` | company stock on an engineer van (`engineerId`+`irmItemId`) | `engineer` |
| `EngineerCustomerStockTransaction` | customer consignment on a van (`engineerId`+`customerStockEntryId`) | `engineer` |
| `DamagedStockTransaction` | the damaged pool (`warehouseId`, `ownerType`) | `damaged` |

`JobStockMovement` is deliberately **excluded** — it is a source *document* (reached via `reference`, e.g. `GM-0001`),
not a ledger leg. Every job issue/return/consume/lost already writes the delta ledgers above, so emitting its lines
would double-count. This corrects the previous `aggregation.listMovements`, which mixed `InventoryTransaction` with
`JobStockMovement` lines (now removed).

All stock-affecting sources are covered: Goods In, Goods Out, warehouse↔warehouse Transfers, manual Adjustments
(add/remove), engineer-to-engineer Transfers, Job Issue/Return/Consume/Lost, Write-off (damage) and Restore.

## Components (as built)

- **`inventory/movement.ts`** — the normalised `Movement` DTO, a `(type)→label` map, one mapper per ledger
  (`fromInventoryTxn`, `fromEngineerTxn`, `fromEngineerCustomerTxn`, `fromDamagedTxn`; damaged's verb is derived
  from the sign), and the cursor codec.
- **Per-ledger keyset finders** in each owning repo (`findInventoryTxnPage`, `findEngineerTxnPage`,
  `findEngineerCustomerTxnPage`, `findDamagedTxnPage`) + batch metadata resolvers (`findIrmMetaByIds`,
  `findWarehouseNamesByIds`, `findEngineerNamesByIds`, `findCustomerEntryMetaByIds`,
  `findCustomerStockEntryIdsByCustomer`) — the customer/damaged ledgers carry only ids.
- **`inventory/movement.service.ts`** — the union engine: `selectLedgers()` prunes ledgers by filter,
  `queryUnified()` fetches `limit+1` keyset rows per ledger, merges on `(createdAt DESC, id DESC)`, resolves
  metadata for the page (one batch query each), and maps to `Movement`. Exposes `listMovements` (admin) and
  `listEngineerMovements` (own-scoped).
- **Endpoints:** `GET /inventory/movements` (perm `inventory.history`) and `GET /engineer/movements`
  (perm `engineer.inventory.view`). Both accept `dateFrom,dateTo,irmItem,warehouse,engineer,customer,ownership,
  location,type,sourceType,cursor,limit`.
- **Frontend:** shared `MovementFeed` (filters + cursor "Load more" + per-leg rows with qty±/balanceAfter/reference);
  admin `MovementsTable` (Hub Movements tab) and engineer Stock → **Movements** tab both render it; engineer
  Dashboard **Recent activity** widget reads the own-scoped feed (limit 6).

## Pagination — keyset (cursor)

Total order `(createdAt DESC, _id DESC)`; the cursor is the boundary row's `(createdAt, id)`, base64url-encoded.
ObjectIds are globally unique, so the tuple is a valid total order **across collections** — verified against Mongo,
including the `id: { lt }` keyset tiebreak. `hasMore` is `merged.length > limit`. There is no `total` (counting four
collections per request is wasteful and unnecessary for an append-only log). Deeply paginable, no silent truncation.

## Role scoping

- **Admin** (`inventory.history`): company-wide; every filter honoured.
- **Engineer** (`engineer.inventory.view`): `listEngineerMovements` **forces `engineerId` to the signed-in user**
  (client-supplied engineer/warehouse filters ignored) and queries **only** the two engineer-van ledgers — warehouse
  and damaged movements are never reachable. No value/cost on customer rows (existing pricing constraint).

## Reuse / non-goals

- **Reused unchanged:** all ledger rows + writers (no movement logic touched), the `/inventory/movements` route,
  `inventory.history`, `OwnerTag`/skeleton UI helpers.
- **Non-goals:** no new ledger/table, no write-path or schema change, no migration/backfill, no editing/reversing
  movements from this screen (reversals flow through their own modules), no free-text search in the feed (structured
  filters only — correct under cursor pagination).

## Testing / verification

- Vitest: DTO mappers (all four), `labelFor`, cursor round-trip + junk handling.
- Live-DB probe: 4-ledger union; cursor page-2 strictly older with **zero overlap** and correct ordering; filters
  (ownership / location / type); engineer scoping with **zero leaks**.
- Full suite green (1173 tests), backend typecheck + lint clean, frontend `tsc` + lint clean.

## Future (only if needed)

If cross-collection reads ever bottleneck, add a denormalised `StockMovement` projection rebuilt from these ledgers
(CQRS read model) — a pure read optimisation that keeps the ledgers as the source of truth.
