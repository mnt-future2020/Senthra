# Inventory Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-pool Inventory page into a unified, production-grade **Inventory Hub** that shows and acts on every stock position the business is accountable for, organised by Ownership × Current Location.

**Architecture:** A read-time aggregation layer in the `inventory` module normalises every stock pool (company-warehouse, company-engineer, customer-warehouse, customer-engineer, damaged) into one canonical `StockPosition` DTO by delegating to each owning module's existing repositories. A unified Movements feed merges the existing ledgers. The Hub frontend renders lenses (tabs) + summary cards over these endpoints and orchestrates actions by calling existing services; three genuinely new write actions (company Adjust, customer Transfer, damaged Restore) are added to their owning module services. An item-level Detail page composes the per-item slices.

**Tech Stack:** Backend — Express 5, Prisma (MongoDB), TypeScript ESM/NodeNext, zod, vitest. Frontend — Next.js 16 App Router, React 19, Tailwind v4, axios via `api()`.

## Global Constraints

- Relative imports MUST include `.js` extension; cross-module imports use `#modules/<domain>/...` (with `.js`); same-module imports stay relative.
- Prisma is touched ONLY in repositories. Controllers hold no logic. Services return data or `throw new HttpError`.
- `process.env` only in `config/env.ts`.
- Customer-owned and damaged-customer rows NEVER expose cost/value. `unitCostPence`/`valuePence`/`value` are `null` for them.
- Money is integer pence internally; GBP currency `"GBP"`.
- New write actions follow the existing pattern: atomic balance change + append-only ledger row + fire-and-forget audit. No destructive in-place edits; codes via the `Counter` allocator, never reused.
- Frontend: components call services, never `api()`/axios directly. Permission checks via `const { can } = useAuth()`.
- Verify backend with `pnpm typecheck` + `pnpm lint` + `pnpm test`; frontend with `pnpm lint` + `pnpm build`.
- Serial/batch-tracked IRM items cannot move via goods-management flows (existing rule) — preserve it.

## File Structure

**Backend (new):**
- `backend/src/modules/inventory/stock-position.ts` — `StockPosition` types + pure mappers + pure filter/sort/paginate helpers (unit-tested).
- `backend/src/modules/inventory/stock-position.test.ts` — vitest for mappers + helpers.
- `backend/src/modules/inventory/movement.ts` — `Movement` type + pure ledger→Movement mappers (unit-tested).
- `backend/src/modules/inventory/movement.test.ts` — vitest.
- `backend/src/modules/inventory/aggregation.service.ts` — `listStockPositions`, `getInventorySummary`, `listMovements`.

**Backend (modified):**
- `backend/src/modules/inventory/inventory.repository.ts` — add `findAllBalancesForAggregation`, `findRecentInventoryTransactions`, `countInventoryTransactionsAll`.
- `backend/src/modules/engineer/engineer.repository.ts` — add `findAllBalances`, `findRecentTransactionsAll`.
- `backend/src/modules/goods-management/goods-management.repository.ts` — add `findAllCustomerHoldings`, `findRecentJobMovementsAll`, `countJobMovementsAll`, damaged restore primitives.
- `backend/src/modules/customer/customer.repository.ts` — add `findActiveStockEntries`.
- `backend/src/modules/inventory/inventory.service.ts` — add `adjustStock` (downward correction).
- `backend/src/modules/inventory/inventory.validation.ts` — add `adjustStockSchema`, `positionsQuerySchema`, `movementsQuerySchema`.
- `backend/src/modules/inventory/inventory.controller.ts` — add `listPositions`, `getSummary`, `listMovements`, `adjustStock`.
- `backend/src/modules/inventory/inventory.routes.ts` — add routes.
- `backend/src/modules/customer/*` — add `transferCustomerStock` (service + repo + validation + route).
- `backend/src/modules/goods-management/*` — add `restoreDamaged` (service + repo + validation + route).

**Frontend (new):**
- `frontend/src/types/stock-position.ts` — `StockPosition`, `InventorySummary`, `Movement`, paged shapes.
- `frontend/src/services/stockPosition.service.ts` — wrappers for positions/summary/movements + new actions.
- `frontend/src/components/dashboard/inventory/InventoryHub.tsx` — tabs container + cards.
- `frontend/src/components/dashboard/inventory/SummaryCards.tsx`.
- `frontend/src/components/dashboard/inventory/StockPositionTable.tsx` — generic lens table (column config per lens).
- `frontend/src/components/dashboard/inventory/MovementsTable.tsx`.
- `frontend/src/components/dashboard/inventory/AdjustStockForm.tsx`, `CustomerTransferForm.tsx`, `RestoreDamagedDialog.tsx`.
- `frontend/src/components/dashboard/inventory/detail/*` — 9 detail sections + `InventoryDetailPage.tsx`.

**Frontend (modified):**
- `frontend/src/app/dashboard/inventory/page.tsx` — render `InventoryHub`.
- `frontend/src/app/dashboard/inventory/[id]/page.tsx` — render new `InventoryDetailPage`.

---

## Execution Order (workstreams)

One production delivery. Execute in this order — **backend 100% complete and verified before any frontend** — rather than alternating per phase. Task *content* below is unchanged; only the sequence is. Tasks 12/13/14 are split into a backend half (built in WS1) and a frontend half (built in WS3).

**WS1 — Backend (all endpoints + write logic):**
Task 1 → 2 → 3 → 4 (enriched summary) → 5 → 6 → 12-BE (Adjust) → 13-BE (Customer Transfer) → 14-BE (Damaged Restore) → 16 (Detail endpoints) → 18-BE (All-Inventory CSV endpoint).
Gate: `cd backend && pnpm typecheck && pnpm lint && pnpm test` all green.

**WS2 — API smoke check:** quick manual hit of `/inventory/positions`, `/summary`, `/movements`, and the three new POSTs against a dev DB to confirm shapes before building UI on them.

**WS3 — Frontend:**
Task 7 (types + all service wrappers incl. actions + CSV) → 8 (enriched cards) → 9 → 10 → 11 (Hub + page) → 12-FE (AdjustStockForm) → 13-FE (CustomerTransferForm) → 14-FE (RestoreDamagedDialog) → 15 (per-lens action bars) → 17 (Inventory Detail page) → 18-FE (realtime refresh).
Gate: `cd frontend && pnpm lint && pnpm build` green.

**WS4 — Integration & verification:** full backend test/lint/typecheck + frontend build, then run the app and walk Hub → each lens → click item → Detail → each new action end-to-end. Final whole-branch review.

---

## PHASE A — Backend read layer

### Task 1: `StockPosition` types + pure mappers

**Files:**
- Create: `backend/src/modules/inventory/stock-position.ts`
- Test: `backend/src/modules/inventory/stock-position.test.ts`

**Interfaces:**
- Produces: `StockPosition`, `Ownership`, `LocationType`, `StockPositionStatus`, and mappers `fromInventoryBalance`, `fromEngineerBalance`, `fromCustomerStockEntry`, `fromEngineerCustomerHolding`, `fromDamagedBalance`, plus `positionStatus`.

- [ ] **Step 1: Write the failing test**

```ts
// stock-position.test.ts
import { describe, it, expect } from "vitest";
import { fromInventoryBalance, fromCustomerStockEntry, fromDamagedBalance, positionStatus } from "./stock-position.js";

describe("positionStatus", () => {
  it("out_of_stock at 0", () => expect(positionStatus(0, 5)).toBe("out_of_stock"));
  it("low_stock at/under reorder", () => expect(positionStatus(5, 5)).toBe("low_stock"));
  it("in_stock above reorder", () => expect(positionStatus(6, 5)).toBe("in_stock"));
  it("in_stock when reorder null and positive", () => expect(positionStatus(3, null)).toBe("in_stock"));
});

describe("fromInventoryBalance", () => {
  const row: any = {
    id: "b1", irmItemId: "i1", warehouseId: "w1", quantityOnHand: 10, quantityReserved: 2,
    irmItem: { code: "IRM-0001", name: "Cable", sku: "SKU1", baseUnit: "Each", reorderLevel: 5,
      standardCostPence: 100, trackSerialNumbers: false, trackBatchNumbers: false,
      category: { name: "Tools" } },
    warehouse: { name: "London Hub", code: "WH-0001" },
    updatedAt: new Date("2026-06-29T00:00:00Z"),
  };
  const p = fromInventoryBalance(row);
  it("is company/warehouse with value", () => {
    expect(p.ownership).toBe("company");
    expect(p.locationType).toBe("warehouse");
    expect(p.available).toBe(8);
    expect(p.valuePence).toBe(1000);
    expect(p.inventoryBalanceId).toBe("b1");
  });
});

describe("fromCustomerStockEntry hides value", () => {
  const entry: any = {
    id: "c1", customerId: "cu1", warehouseId: "w1", itemName: "Router", sku: "R1",
    quantity: 4, serialized: true, serialNumber: "SN1", highValue: true, status: "active",
    customer: { name: "Acme" }, warehouse: { name: "London Hub", code: "WH-0001" },
    category: { name: "Networking" }, updatedAt: new Date("2026-06-29T00:00:00Z"),
  };
  const p = fromCustomerStockEntry(entry);
  it("has no value, carries customer + flags", () => {
    expect(p.ownership).toBe("customer");
    expect(p.valuePence).toBeNull();
    expect(p.value).toBeNull();
    expect(p.customerName).toBe("Acme");
    expect(p.flags.highValue).toBe(true);
    expect(p.flags.serialized).toBe(true);
  });
});

describe("fromDamagedBalance", () => {
  it("customer-owned damage carries no value", () => {
    const row: any = { id: "d1", warehouseId: "w1", ownerType: "customer", irmItemId: null,
      customerStockEntryId: "c1", customerId: "cu1", itemName: "Patch lead", quantity: 2,
      warehouse: { name: "London Hub", code: "WH-0001" }, updatedAt: new Date("2026-06-29T00:00:00Z") };
    const p = fromDamagedBalance(row, { reason: "broken", photoUrl: null });
    expect(p.ownership).toBe("customer");
    expect(p.locationType).toBe("damaged");
    expect(p.status).toBe("damaged");
    expect(p.valuePence).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm test stock-position`
Expected: FAIL — module not found / exports missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// stock-position.ts
export type Ownership = "company" | "customer";
export type LocationType = "warehouse" | "engineer" | "customer_site" | "damaged" | "transit";
export type StockPositionStatus =
  | "in_stock" | "low_stock" | "out_of_stock" | "on_van" | "damaged" | "overdue";

export interface PositionFlags {
  highValue?: boolean;
  serialized?: boolean;
  overdue?: boolean;
  daysOut?: number;
}

export interface StockPosition {
  id: string;                 // synthetic stable key
  itemId: string;             // irmItemId or customerStockEntryId
  itemKind: "irm" | "customer_stock";
  itemCode: string;
  itemName: string;
  sku: string | null;
  categoryName: string | null;
  ownership: Ownership;
  customerId: string | null;
  customerName: string | null;
  locationType: LocationType;
  locationId: string;
  locationLabel: string;
  quantity: number;
  reserved: number;
  available: number;
  unitCostPence: number | null;
  valuePence: number | null;
  value: number | null;
  currency: string;
  status: StockPositionStatus;
  flags: PositionFlags;
  lastMovementAt: string;
  inventoryBalanceId: string | null;
}

const CURRENCY = "GBP";
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

export function positionStatus(onHand: number, reorderLevel: number | null): "in_stock" | "low_stock" | "out_of_stock" {
  if (onHand <= 0) return "out_of_stock";
  if (reorderLevel != null && onHand <= reorderLevel) return "low_stock";
  return "in_stock";
}

export function fromInventoryBalance(row: any): StockPosition {
  const onHand = row.quantityOnHand ?? 0;
  const reserved = row.quantityReserved ?? 0;
  const unitCostPence = row.irmItem?.standardCostPence ?? 0;
  return {
    id: `company:warehouse:${row.warehouseId}:irm:${row.irmItemId}`,
    itemId: row.irmItemId,
    itemKind: "irm",
    itemCode: row.irmItem?.code ?? "",
    itemName: row.irmItem?.name ?? "",
    sku: row.irmItem?.sku ?? null,
    categoryName: row.irmItem?.category?.name ?? null,
    ownership: "company",
    customerId: null,
    customerName: null,
    locationType: "warehouse",
    locationId: row.warehouseId,
    locationLabel: row.warehouse?.name ?? "",
    quantity: onHand,
    reserved,
    available: onHand - reserved,
    unitCostPence,
    valuePence: onHand * unitCostPence,
    value: (onHand * unitCostPence) / 100,
    currency: CURRENCY,
    status: positionStatus(onHand, row.irmItem?.reorderLevel ?? null),
    flags: { serialized: !!row.irmItem?.trackSerialNumbers },
    lastMovementAt: iso(row.updatedAt),
    inventoryBalanceId: row.id,
  };
}

export function fromEngineerBalance(row: any, engineerName: string): StockPosition {
  const qty = row.quantityOnHand ?? 0;
  return {
    id: `company:engineer:${row.engineerId}:irm:${row.irmItemId}`,
    itemId: row.irmItemId,
    itemKind: "irm",
    itemCode: row.irmItem?.code ?? "",
    itemName: row.irmItem?.name ?? "",
    sku: null,
    categoryName: null,
    ownership: "company",
    customerId: null,
    customerName: null,
    locationType: "engineer",
    locationId: row.engineerId,
    locationLabel: `Eng: ${engineerName}`,
    quantity: qty,
    reserved: 0,
    available: qty,
    unitCostPence: null,
    valuePence: null,
    value: null,
    currency: CURRENCY,
    status: "on_van",
    flags: {},
    lastMovementAt: iso(row.updatedAt),
    inventoryBalanceId: null,
  };
}

export function fromCustomerStockEntry(entry: any): StockPosition {
  const qty = entry.quantity ?? 0;
  return {
    id: `customer:warehouse:${entry.warehouseId}:cse:${entry.id}`,
    itemId: entry.id,
    itemKind: "customer_stock",
    itemCode: entry.barcode ?? entry.sku ?? "",
    itemName: entry.itemName,
    sku: entry.sku ?? null,
    categoryName: entry.category?.name ?? null,
    ownership: "customer",
    customerId: entry.customerId,
    customerName: entry.customer?.name ?? null,
    locationType: "warehouse",
    locationId: entry.warehouseId,
    locationLabel: entry.warehouse?.name ?? "",
    quantity: qty,
    reserved: 0,
    available: qty,
    unitCostPence: null,
    valuePence: null,
    value: null,
    currency: CURRENCY,
    status: positionStatus(qty, entry.thresholdQty ?? null),
    flags: { highValue: !!entry.highValue, serialized: !!entry.serialized },
    lastMovementAt: iso(entry.updatedAt),
    inventoryBalanceId: null,
  };
}

export function fromEngineerCustomerHolding(h: any): StockPosition {
  const qty = h.quantityOnHand ?? 0;
  return {
    id: `customer:engineer:${h.engineerId}:cse:${h.customerStockEntryId}`,
    itemId: h.customerStockEntryId,
    itemKind: "customer_stock",
    itemCode: "",
    itemName: h.itemName,
    sku: null,
    categoryName: null,
    ownership: "customer",
    customerId: h.customerId ?? null,
    customerName: h.customerName ?? null,
    locationType: "engineer",
    locationId: h.engineerId,
    locationLabel: "Engineer",
    quantity: qty,
    reserved: 0,
    available: qty,
    unitCostPence: null,
    valuePence: null,
    value: null,
    currency: CURRENCY,
    status: "on_van",
    flags: {},
    lastMovementAt: iso(h.updatedAt ?? h.createdAt),
    inventoryBalanceId: null,
  };
}

export function fromDamagedBalance(row: any, meta: { reason: string; photoUrl: string | null }): StockPosition {
  const qty = row.quantity ?? 0;
  const isCompany = row.ownerType === "company";
  return {
    id: `${row.ownerType}:damaged:${row.warehouseId}:${row.irmItemId ?? row.customerStockEntryId}`,
    itemId: row.irmItemId ?? row.customerStockEntryId ?? "",
    itemKind: isCompany ? "irm" : "customer_stock",
    itemCode: "",
    itemName: row.itemName,
    sku: null,
    categoryName: null,
    ownership: isCompany ? "company" : "customer",
    customerId: row.customerId ?? null,
    customerName: null,
    locationType: "damaged",
    locationId: row.warehouseId,
    locationLabel: `Damaged — ${row.warehouse?.name ?? ""}`.trim(),
    quantity: qty,
    reserved: 0,
    available: 0,
    unitCostPence: null,
    valuePence: null,
    value: null,
    currency: CURRENCY,
    status: "damaged",
    flags: {},
    lastMovementAt: iso(row.updatedAt),
    inventoryBalanceId: null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm test stock-position`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/inventory/stock-position.ts backend/src/modules/inventory/stock-position.test.ts
git commit -m "feat(inventory): StockPosition types + pool mappers"
```

### Task 2: pure filter / sort / paginate helpers

**Files:**
- Modify: `backend/src/modules/inventory/stock-position.ts`
- Test: `backend/src/modules/inventory/stock-position.test.ts`

**Interfaces:**
- Produces: `PositionFilters` interface; `filterPositions(rows, f)`, `sortPositions(rows)`, `paginate(rows, page, pageSize)` returning `{ slice, total, page, pageSize, totalPages }`.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { filterPositions, sortPositions, paginate } from "./stock-position.js";

const sample = (over: Partial<any>) => ({
  itemName: "X", itemCode: "", sku: null, ownership: "company", locationType: "warehouse",
  status: "in_stock", quantity: 1, locationId: "w1", categoryName: "Tools", customerId: null, ...over,
});

describe("filterPositions", () => {
  const rows: any[] = [
    sample({ itemName: "Cable", ownership: "company", locationType: "warehouse" }),
    sample({ itemName: "Router", ownership: "customer", locationType: "engineer" }),
    sample({ itemName: "Broken", ownership: "company", locationType: "damaged", status: "damaged" }),
  ];
  it("filters by ownership", () => expect(filterPositions(rows, { ownership: "customer" })).toHaveLength(1));
  it("filters by location", () => expect(filterPositions(rows, { locationType: "damaged" })).toHaveLength(1));
  it("search matches name", () => expect(filterPositions(rows, { search: "rout" })).toHaveLength(1));
});

describe("paginate", () => {
  it("slices and reports totals", () => {
    const rows = Array.from({ length: 25 }, (_, i) => sample({ itemName: `n${i}` }));
    const r = paginate(rows, 2, 10);
    expect(r.slice).toHaveLength(10);
    expect(r.total).toBe(25);
    expect(r.totalPages).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm test stock-position`
Expected: FAIL — `filterPositions` not exported.

- [ ] **Step 3: Write minimal implementation** (append to stock-position.ts)

```ts
export interface PositionFilters {
  ownership?: Ownership;
  locationType?: LocationType;
  warehouseId?: string;     // matches locationId when locationType is warehouse/damaged
  categoryName?: string;
  search?: string;          // item name / sku / code
  status?: StockPositionStatus;
  customerId?: string;
}

export function filterPositions(rows: StockPosition[], f: PositionFilters): StockPosition[] {
  const q = f.search?.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.ownership && r.ownership !== f.ownership) return false;
    if (f.locationType && r.locationType !== f.locationType) return false;
    if (f.warehouseId && r.locationId !== f.warehouseId) return false;
    if (f.categoryName && r.categoryName !== f.categoryName) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.customerId && r.customerId !== f.customerId) return false;
    if (q) {
      const hay = `${r.itemName} ${r.sku ?? ""} ${r.itemCode}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function sortPositions(rows: StockPosition[]): StockPosition[] {
  return [...rows].sort((a, b) =>
    a.itemName.localeCompare(b.itemName) || a.locationLabel.localeCompare(b.locationLabel));
}

export function paginate<T>(rows: T[], page = 1, pageSize = 25) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * pageSize;
  return { slice: rows.slice(start, start + pageSize), total, page: p, pageSize, totalPages };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm test stock-position`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/inventory/stock-position.ts backend/src/modules/inventory/stock-position.test.ts
git commit -m "feat(inventory): position filter/sort/paginate helpers"
```

### Task 3: cross-cutting repository read functions

**Files:**
- Modify: `backend/src/modules/inventory/inventory.repository.ts`
- Modify: `backend/src/modules/engineer/engineer.repository.ts`
- Modify: `backend/src/modules/goods-management/goods-management.repository.ts`
- Modify: `backend/src/modules/customer/customer.repository.ts`

**Interfaces:**
- Produces:
  - inventory.repository: `findAllBalancesForAggregation(filters: InventoryListFilters): Promise<InventoryBalanceWithRelations[]>` (reuse existing `findAllBalances` if its `include` already carries `irmItem.category` + `warehouse`; otherwise add this).
  - engineer.repository: `findAllBalances(): Promise<(EngineerBalanceRow & { engineer: { id, name, email } })[]>`.
  - goods-management.repository: `findAllCustomerHoldings(): Promise<EngineerCustomerStockHolding[]>`.
  - customer.repository: `findActiveStockEntries(filters: { warehouseId?: string; customerId?: string }): Promise<CustomerStockEntryWithRelations[]>`.

- [ ] **Step 1: Add inventory repo function**

```ts
// inventory.repository.ts — ensure category is included for aggregation
export function findAllBalancesForAggregation(filters: InventoryListFilters): Promise<InventoryBalanceWithRelations[]> {
  return prisma.inventoryBalance.findMany({
    where: buildBalanceWhere(filters), // reuse the existing private where-builder used by findAllBalances
    include: {
      irmItem: { select: { id: true, code: true, name: true, sku: true, baseUnit: true,
        reorderLevel: true, standardCostPence: true, trackSerialNumbers: true, trackBatchNumbers: true,
        category: { select: { name: true } } } },
      warehouse: { select: { name: true, code: true } },
    },
  });
}
```

> If `findAllBalances` already includes `irmItem.category`, skip this and reuse it directly in Task 4.

- [ ] **Step 2: Add engineer repo function**

```ts
// engineer.repository.ts
export function findAllBalances() {
  return prisma.engineerStockBalance.findMany({
    where: { quantityOnHand: { gt: 0 } },
    include: {
      irmItem: { select: { id: true, code: true, name: true, baseUnit: true } },
      engineer: { select: { id: true, name: true, email: true } },
    },
  });
}
```

- [ ] **Step 3: Add goods-management repo functions**

```ts
// goods-management.repository.ts
export function findAllCustomerHoldings() {
  return prisma.engineerCustomerStockHolding.findMany({ where: { quantityOnHand: { gt: 0 } } });
}
```

- [ ] **Step 4: Add customer repo function**

```ts
// customer.repository.ts
export function findActiveStockEntries(filters: { warehouseId?: string; customerId?: string } = {}) {
  return prisma.customerStockEntry.findMany({
    where: {
      status: "active",
      quantity: { gt: 0 },
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
    },
    include: {
      customer: { select: { name: true } },
      warehouse: { select: { name: true, code: true } },
      category: { select: { name: true } },
    },
  });
}
```

- [ ] **Step 5: Verify + commit**

Run: `cd backend && pnpm typecheck`
Expected: PASS.

```bash
git add backend/src/modules/inventory/inventory.repository.ts backend/src/modules/engineer/engineer.repository.ts backend/src/modules/goods-management/goods-management.repository.ts backend/src/modules/customer/customer.repository.ts
git commit -m "feat(inventory): cross-pool aggregation repo reads"
```

### Task 4: aggregation service — positions + summary

**Files:**
- Create: `backend/src/modules/inventory/aggregation.service.ts`

**Interfaces:**
- Consumes: mappers/helpers from `stock-position.ts`; repo reads from Task 3; `findAllDamaged`, `findLatestDamagedTxnsByBalances` (existing goods-management repo).
- Produces:
  - `listStockPositions(params: PositionFilters & { page?: number; pageSize?: number }): Promise<{ positions: StockPosition[]; total; page; pageSize; totalPages }>`
  - `getInventorySummary(): Promise<InventorySummary>` where `InventorySummary = { company: { units; valuePence; value }; customer: { units }; engineer: { units; overdue: number }; damaged: { units; thisMonthUnits } }`.

- [ ] **Step 1: Implement aggregation assembly**

```ts
// aggregation.service.ts
import * as inventoryRepo from "./inventory.repository.js";
import * as engineerRepo from "#modules/engineer/engineer.repository.js";
import * as gmRepo from "#modules/goods-management/goods-management.repository.js";
import * as customerRepo from "#modules/customer/customer.repository.js";
import {
  fromInventoryBalance, fromEngineerBalance, fromCustomerStockEntry,
  fromEngineerCustomerHolding, fromDamagedBalance,
  filterPositions, sortPositions, paginate,
  type StockPosition, type PositionFilters,
} from "./stock-position.js";

async function assembleAll(filters: PositionFilters): Promise<StockPosition[]> {
  const repoFilters = { warehouseId: filters.warehouseId, customerId: filters.customerId };

  const [companyWh, engBalances, custEntries, custHoldings, damaged] = await Promise.all([
    inventoryRepo.findAllBalancesForAggregation({ warehouseId: filters.warehouseId }),
    engineerRepo.findAllBalances(),
    customerRepo.findActiveStockEntries(repoFilters),
    gmRepo.findAllCustomerHoldings(),
    gmRepo.findAllDamaged(),
  ]);

  const damagedMeta = await gmRepo.findLatestDamagedTxnsByBalances(damaged);

  const positions: StockPosition[] = [
    ...companyWh.map(fromInventoryBalance),
    ...engBalances.map((b) => fromEngineerBalance(b, b.engineer?.name ?? "Engineer")),
    ...custEntries.map(fromCustomerStockEntry),
    ...custHoldings.map(fromEngineerCustomerHolding),
    ...damaged.map((d) => fromDamagedBalance(d, damagedMeta.get(d.id) ?? { reason: "", photoUrl: null })),
  ];
  return positions;
}

export async function listStockPositions(
  params: PositionFilters & { page?: number; pageSize?: number } = {},
) {
  const all = await assembleAll(params);
  const filtered = sortPositions(filterPositions(all, params));
  const { slice, total, page, pageSize, totalPages } = paginate(filtered, params.page, params.pageSize ?? 25);
  return { positions: slice, total, page, pageSize, totalPages };
}

export interface InventorySummary {
  company: { units: number; valuePence: number; value: number };
  customer: { units: number; customersHolding: number };
  engineer: { units: number; engineersHolding: number; overdue: number };
  damaged: { units: number; thisMonthUnits: number };
}

export async function getInventorySummary(): Promise<InventorySummary> {
  const all = await assembleAll({});
  const sum = (p: StockPosition[]) => p.reduce((n, r) => n + r.quantity, 0);

  const companyWh = all.filter((p) => p.ownership === "company" && p.locationType === "warehouse");
  const customerWh = all.filter((p) => p.ownership === "customer" && p.locationType === "warehouse");
  const engineer = all.filter((p) => p.locationType === "engineer");
  const damaged = all.filter((p) => p.locationType === "damaged");
  const valuePence = companyWh.reduce((n, r) => n + (r.valuePence ?? 0), 0);
  // distinct counts come free from the already-assembled positions — no extra queries
  const customersHolding = new Set(customerWh.map((p) => p.customerId).filter(Boolean)).size;
  const engineersHolding = new Set(engineer.map((p) => p.locationId)).size;

  return {
    company: { units: sum(companyWh), valuePence, value: valuePence / 100 },
    customer: { units: sum(customerWh), customersHolding },
    engineer: { units: sum(engineer), engineersHolding, overdue: 0 }, // overdue wired in Step 2 via gmRepo.countOverdueIssues
    damaged: { units: sum(damaged), thisMonthUnits: 0 }, // thisMonth wired in Step 2 via countDamagedUnitsSince
  };
}
```

> Overdue/thisMonth counts: in Step 2 replace the `0` placeholders with real counts using existing `gmRepo` overdue query and a damaged-txn-since query. If those repo helpers don't exist, add a `countOverdueIssues()` and `countDamagedSince(date)` read in goods-management.repository.ts (Prisma counts only).

- [ ] **Step 2: Wire real overdue + thisMonth counts**

Add to `goods-management.repository.ts`:
```ts
export function countOverdueIssues(beforeDate: Date) {
  return prisma.jobStockMovement.count({
    where: { direction: "issue", status: "posted", createdAt: { lt: beforeDate },
      job: { stockSummary: { is: { goodsStatus: { not: "reconciled" } } } } },
  });
}
export function countDamagedUnitsSince(since: Date) {
  return prisma.damagedStockTransaction.aggregate({ _sum: { quantityDelta: true }, where: { createdAt: { gte: since } } });
}
```
Then in `getInventorySummary` compute `const cutoff = new Date(Date.now() - 14 * 86400000)` and a month-start date, call both, and fill the fields. (Pass `Date.now()` is fine in service code — only workflow scripts forbid it.)

- [ ] **Step 3: Verify + commit**

Run: `cd backend && pnpm typecheck && pnpm test stock-position`
Expected: PASS.

```bash
git add backend/src/modules/inventory/aggregation.service.ts backend/src/modules/goods-management/goods-management.repository.ts
git commit -m "feat(inventory): position aggregation + summary service"
```

### Task 5: Movements feed (types, mappers, service)

**Files:**
- Create: `backend/src/modules/inventory/movement.ts` (+ `.test.ts`)
- Modify: `backend/src/modules/inventory/inventory.repository.ts` (add `findRecentInventoryTransactions(skip, take)`, `countInventoryTransactionsAll()`)
- Modify: `backend/src/modules/goods-management/goods-management.repository.ts` (add `findRecentJobMovementsAll(skip, take)`, `countJobMovementsAll()`)
- Modify: `backend/src/modules/inventory/aggregation.service.ts` (add `listMovements`)

**Interfaces:**
- Produces: `Movement` type; mappers `fromInventoryTxn`, `fromJobMovementLine`; service `listMovements(params): Promise<{ movements: Movement[]; total; page; pageSize; totalPages }>`.

```ts
// movement.ts
export interface Movement {
  id: string;
  date: string;
  type: string;        // goods_in|manual_add|transfer_in|transfer_out|adjust|issue|return|consume|lost|write_off|restore
  itemCode: string;
  itemName: string;
  ownership: "company" | "customer";
  fromLabel: string | null;
  toLabel: string | null;
  quantityDelta: number;
  reference: string | null;
  actor: string | null;
  source: { kind: string; id: string };
}
```

- [ ] **Step 1: Write failing mapper test**

```ts
// movement.test.ts
import { describe, it, expect } from "vitest";
import { fromInventoryTxn } from "./movement.js";
describe("fromInventoryTxn", () => {
  it("maps a transfer_out row", () => {
    const m = fromInventoryTxn({ id: "t1", createdAt: new Date("2026-06-29T00:00:00Z"), type: "transfer_out",
      quantityDelta: -5, sourceCode: "TRF-0001", createdBy: "a@b.com", sourceType: "stock_transfer", sourceId: "s1",
      irmItem: { code: "IRM-0001", name: "Cable" }, warehouse: { name: "London Hub" } } as any);
    expect(m.type).toBe("transfer_out");
    expect(m.quantityDelta).toBe(-5);
    expect(m.reference).toBe("TRF-0001");
    expect(m.ownership).toBe("company");
  });
});
```

- [ ] **Step 2: Run + fail**

Run: `cd backend && pnpm test movement`
Expected: FAIL.

- [ ] **Step 3: Implement mappers**

```ts
// movement.ts (append)
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);

export function fromInventoryTxn(row: any): Movement {
  return {
    id: `inv:${row.id}`,
    date: iso(row.createdAt),
    type: row.type,
    itemCode: row.irmItem?.code ?? "",
    itemName: row.irmItem?.name ?? "",
    ownership: "company",
    fromLabel: row.quantityDelta < 0 ? (row.warehouse?.name ?? null) : null,
    toLabel: row.quantityDelta > 0 ? (row.warehouse?.name ?? null) : null,
    quantityDelta: row.quantityDelta,
    reference: row.sourceCode ?? null,
    actor: row.createdBy ?? null,
    source: { kind: row.sourceType, id: row.sourceId },
  };
}

export function fromJobMovementLine(movement: any, line: any): Movement {
  const sign = movement.direction === "issue" ? -1 : 1; // issue leaves warehouse
  return {
    id: `gm:${line.id}`,
    date: iso(movement.postedAt ?? movement.createdAt),
    type: movement.direction,
    itemCode: line.sku ?? "",
    itemName: line.itemName,
    ownership: line.source === "customer" ? "customer" : "company",
    fromLabel: movement.direction === "issue" ? (movement.warehouseName ?? null) : (movement.engineerName ?? null),
    toLabel: movement.direction === "issue" ? (movement.engineerName ?? null) : (movement.warehouseName ?? null),
    quantityDelta: sign * (line.qty ?? 0),
    reference: movement.code ?? null,
    actor: movement.performedBy ?? null,
    source: { kind: "job_stock_movement", id: movement.id },
  };
}
```

- [ ] **Step 4: Add repo reads + service**

```ts
// inventory.repository.ts
export function findRecentInventoryTransactions(skip: number, take: number) {
  return prisma.inventoryTransaction.findMany({
    orderBy: { createdAt: "desc" }, skip, take,
    include: { irmItem: { select: { code: true, name: true } }, warehouse: { select: { name: true } } },
  });
}
```
```ts
// goods-management.repository.ts
export function findRecentJobMovementsAll(skip: number, take: number) {
  return prisma.jobStockMovement.findMany({
    where: { status: "posted" }, orderBy: { createdAt: "desc" }, skip, take,
    include: { items: true },
  });
}
```
```ts
// aggregation.service.ts (append)
import { fromInventoryTxn, fromJobMovementLine, type Movement } from "./movement.js";
import { paginate } from "./stock-position.js";

export async function listMovements(params: { page?: number; pageSize?: number; ownership?: string; type?: string } = {}) {
  const CAP = 500;
  const [invTxns, jobMoves] = await Promise.all([
    inventoryRepo.findRecentInventoryTransactions(0, CAP),
    gmRepo.findRecentJobMovementsAll(0, CAP),
  ]);
  let movements: Movement[] = [
    ...invTxns.map(fromInventoryTxn),
    ...jobMoves.flatMap((m) => (m.items ?? []).map((l: any) => fromJobMovementLine(m, l))),
  ].sort((a, b) => b.date.localeCompare(a.date));

  if (params.ownership) movements = movements.filter((m) => m.ownership === params.ownership);
  if (params.type) movements = movements.filter((m) => m.type === params.type);

  const { slice, total, page, pageSize, totalPages } = paginate(movements, params.page, params.pageSize ?? 25);
  return { movements: slice, total, page, pageSize, totalPages };
}
```

> Note in code comment: the 500-row cap per source is logged behaviourally — surface "showing most recent activity" in the UI so truncation is honest (Global Constraints / no silent caps).

- [ ] **Step 5: Verify + commit**

Run: `cd backend && pnpm test movement && pnpm typecheck`
Expected: PASS.

```bash
git add backend/src/modules/inventory/movement.ts backend/src/modules/inventory/movement.test.ts backend/src/modules/inventory/inventory.repository.ts backend/src/modules/goods-management/goods-management.repository.ts backend/src/modules/inventory/aggregation.service.ts
git commit -m "feat(inventory): unified movements feed"
```

### Task 6: routes + controllers + validation for read endpoints

**Files:**
- Modify: `backend/src/modules/inventory/inventory.validation.ts`
- Modify: `backend/src/modules/inventory/inventory.controller.ts`
- Modify: `backend/src/modules/inventory/inventory.routes.ts`

**Interfaces:**
- Produces: `GET /inventory/positions`, `GET /inventory/summary`, `GET /inventory/movements` (all `inventory.view`).

- [ ] **Step 1: Add validation (query parsing helpers)**

```ts
// inventory.validation.ts (append)
export const OWNERSHIPS = ["company", "customer"] as const;
export const LOCATION_TYPES = ["warehouse", "engineer", "customer_site", "damaged", "transit"] as const;
```

- [ ] **Step 2: Add controllers**

```ts
// inventory.controller.ts (append)
import * as aggregation from "./aggregation.service.js";
import { queryInt } from "../../utils/request.js";

export const listPositions = asyncHandler(async (req, res) => {
  const q = req.query;
  const result = await aggregation.listStockPositions({
    ownership: q.ownership as any,
    locationType: q.location as any,
    warehouseId: q.warehouse as string | undefined,
    categoryName: q.category as string | undefined,
    search: q.search as string | undefined,
    status: q.status as any,
    customerId: q.customer as string | undefined,
    page: queryInt(q.page),
    pageSize: queryInt(q.pageSize),
  });
  res.json(result);
});

export const getSummary = asyncHandler(async (_req, res) => {
  res.json(await aggregation.getInventorySummary());
});

export const listMovements = asyncHandler(async (req, res) => {
  res.json(await aggregation.listMovements({
    ownership: req.query.ownership as string | undefined,
    type: req.query.type as string | undefined,
    page: queryInt(req.query.page),
    pageSize: queryInt(req.query.pageSize),
  }));
});
```

- [ ] **Step 3: Add routes** (place BEFORE the `/:id` route so they don't get captured)

```ts
// inventory.routes.ts — add above router.get("/:id", ...)
router.get("/positions", requirePermission("inventory.view"), inventoryController.listPositions);
router.get("/summary", requirePermission("inventory.view"), inventoryController.getSummary);
router.get("/movements", requirePermission("inventory.history"), inventoryController.listMovements);
```

- [ ] **Step 4: Verify + commit**

Run: `cd backend && pnpm typecheck && pnpm lint`
Expected: PASS.

```bash
git add backend/src/modules/inventory/inventory.validation.ts backend/src/modules/inventory/inventory.controller.ts backend/src/modules/inventory/inventory.routes.ts
git commit -m "feat(inventory): positions/summary/movements endpoints"
```

---

## PHASE B — Frontend Hub (read-only lenses + cards)

### Task 7: frontend types + service wrappers

**Files:**
- Create: `frontend/src/types/stock-position.ts`
- Create: `frontend/src/services/stockPosition.service.ts`

**Interfaces:**
- Produces: TS mirror of `StockPosition`, `InventorySummary`, `Movement`, `PagedPositions`, `PagedMovements`; service fns `listPositions`, `getSummary`, `listMovements`.

- [ ] **Step 1: Types** (mirror backend exactly)

```ts
// stock-position.ts (frontend) — copy field-for-field from backend StockPosition, InventorySummary, Movement
export type Ownership = "company" | "customer";
export type LocationType = "warehouse" | "engineer" | "customer_site" | "damaged" | "transit";
export type StockPositionStatus = "in_stock" | "low_stock" | "out_of_stock" | "on_van" | "damaged" | "overdue";
export interface StockPosition { /* identical fields to backend Task 1 */ }
export interface InventorySummary {
  company: { units: number; valuePence: number; value: number };
  customer: { units: number; customersHolding: number };
  engineer: { units: number; engineersHolding: number; overdue: number };
  damaged: { units: number; thisMonthUnits: number };
}
export interface Movement { /* identical fields to backend Task 5 */ }
export interface PagedPositions { positions: StockPosition[]; total: number; page: number; pageSize: number; totalPages: number; }
export interface PagedMovements { movements: Movement[]; total: number; page: number; pageSize: number; totalPages: number; }
```

- [ ] **Step 2: Service wrappers**

```ts
// stockPosition.service.ts
import { api } from "@/lib/api";
import type { PagedPositions, PagedMovements, InventorySummary } from "@/types/stock-position";

export interface PositionParams {
  ownership?: string; location?: string; warehouse?: string; category?: string;
  search?: string; status?: string; customer?: string; page?: number; pageSize?: number;
}
const qs = (p: Record<string, unknown>) =>
  Object.entries(p).filter(([, v]) => v !== undefined && v !== "" && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");

export function listPositions(params: PositionParams = {}): Promise<PagedPositions> {
  const s = qs(params); return api<PagedPositions>(`/inventory/positions${s ? `?${s}` : ""}`);
}
export function getSummary(): Promise<InventorySummary> { return api<InventorySummary>("/inventory/summary"); }
export function listMovements(params: { ownership?: string; type?: string; page?: number; pageSize?: number } = {}): Promise<PagedMovements> {
  const s = qs(params); return api<PagedMovements>(`/inventory/movements${s ? `?${s}` : ""}`);
}
```

- [ ] **Step 3: Verify + commit**

Run: `cd frontend && pnpm lint`
Expected: PASS.

```bash
git add frontend/src/types/stock-position.ts frontend/src/services/stockPosition.service.ts
git commit -m "feat(inventory): frontend stock-position types + service"
```

### Task 8: SummaryCards component

**Files:**
- Create: `frontend/src/components/dashboard/inventory/SummaryCards.tsx`

**Interfaces:**
- Consumes: `getSummary()`. Produces: `<SummaryCards active onSelect />` where `onSelect(lens: "company"|"customer"|"engineer"|"damaged")` switches lens.

- [ ] **Step 1: Implement**

```tsx
"use client";
import * as React from "react";
import * as svc from "@/services/stockPosition.service";
import type { InventorySummary } from "@/types/stock-position";
import { useAuth } from "@/hooks/useAuth";

type Lens = "company" | "customer" | "engineer" | "damaged";

export function SummaryCards({ active, onSelect }: { active: string; onSelect: (l: Lens) => void }) {
  const { can } = useAuth();
  const [s, setS] = React.useState<InventorySummary | null>(null);
  React.useEffect(() => { svc.getSummary().then(setS).catch(() => setS(null)); }, []);
  const card = (key: Lens, label: string, value: string, sub?: string) => (
    <button key={key} onClick={() => onSelect(key)}
      className={`rounded-xl border p-4 text-left transition ${active === key ? "border-primary ring-1 ring-primary" : "hover:border-foreground/30"}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </button>
  );
  if (!s) return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0,1,2,3].map(i => <div key={i} className="h-24 animate-pulse rounded-xl border bg-muted/30" />)}</div>;
  const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" · ") || undefined;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {card("company", "Company — in warehouse", `${s.company.units}`, can("inventory.view") ? `£${s.company.value.toLocaleString()} value` : undefined)}
      {card("customer", "Customer consignment", `${s.customer.units}`, join(`${s.customer.customersHolding} customers`))}
      {card("engineer", "With engineers", `${s.engineer.units}`, join(`${s.engineer.engineersHolding} engineers`, s.engineer.overdue ? `${s.engineer.overdue} overdue` : undefined))}
      {card("damaged", "Damaged", `${s.damaged.units}`, join(s.damaged.thisMonthUnits ? `+${s.damaged.thisMonthUnits} this month` : undefined))}
    </div>
  );
}
```

- [ ] **Step 2: Verify + commit**

Run: `cd frontend && pnpm lint`
Expected: PASS.

```bash
git add frontend/src/components/dashboard/inventory/SummaryCards.tsx
git commit -m "feat(inventory): summary cards"
```

### Task 9: StockPositionTable (generic lens table)

**Files:**
- Create: `frontend/src/components/dashboard/inventory/StockPositionTable.tsx`

**Interfaces:**
- Consumes: `listPositions`. Produces: `<StockPositionTable lens columns fixedFilters />` rendering a paginated, searchable table. `columns` selects which of a known column set to show.

- [ ] **Step 1: Implement** (reuse `Select`, `Pagination`, status badge patterns from `InventoryView`)

```tsx
"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import * as svc from "@/services/stockPosition.service";
import type { StockPosition, PagedPositions } from "@/types/stock-position";
import { Pagination } from "@/components/ui/Pagination";

type Col = "item" | "sku" | "ownership" | "location" | "customer" | "engineer" | "warehouse" | "qty" | "available" | "value" | "status" | "lastMovement" | "reason";

export function StockPositionTable({
  columns, fixedFilters = {},
}: { columns: Col[]; fixedFilters?: svc.PositionParams }) {
  const router = useRouter();
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<PagedPositions | null>(null);
  React.useEffect(() => {
    const t = setTimeout(() => {
      svc.listPositions({ ...fixedFilters, search, page, pageSize: 25 }).then(setData).catch(() => setData(null));
    }, 250);
    return () => clearTimeout(t);
  }, [search, page, JSON.stringify(fixedFilters)]);

  const cell = (r: StockPosition, c: Col): React.ReactNode => {
    switch (c) {
      case "item": return r.itemName;
      case "sku": return r.sku ?? "—";
      case "ownership": return r.ownership === "company" ? "Company" : "Customer";
      case "location": return r.locationLabel;
      case "customer": return r.customerName ?? "—";
      case "engineer": return r.locationType === "engineer" ? r.locationLabel.replace(/^Eng:\s*/, "") : "—";
      case "warehouse": return r.locationType === "warehouse" || r.locationType === "damaged" ? r.locationLabel : "—";
      case "qty": return r.quantity;
      case "available": return r.available;
      case "value": return r.value == null ? "—" : `£${r.value.toLocaleString()}`;
      case "status": return r.status.replace(/_/g, " ");
      case "reason": return r.flags?.serialized ? "Serialized" : "—";
      case "lastMovement": return new Date(r.lastMovementAt).toLocaleDateString();
    }
  };
  return (
    <div className="space-y-3">
      <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        placeholder="Search item or SKU…" className="w-full max-w-sm rounded-md border px-3 py-2 text-sm" />
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead><tr className="border-b bg-muted/30 text-left text-xs uppercase text-muted-foreground">
            {columns.map((c) => <th key={c} className="px-3 py-2">{c}</th>)}
          </tr></thead>
          <tbody>
            {(data?.positions ?? []).map((r) => (
              <tr key={r.id} className="border-b last:border-0 hover:bg-muted/20 cursor-pointer"
                onClick={() => r.inventoryBalanceId && router.push(`/dashboard/inventory/${r.inventoryBalanceId}`)}>
                {columns.map((c) => <td key={c} className="px-3 py-2">{cell(r, c)}</td>)}
              </tr>
            ))}
            {data && data.positions.length === 0 ? (
              <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-muted-foreground">No stock in this view.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {data ? <Pagination page={data.page} totalPages={data.totalPages} total={data.total} label="records" onPage={setPage} /> : null}
    </div>
  );
}
```

- [ ] **Step 2: Verify + commit**

Run: `cd frontend && pnpm lint`
Expected: PASS.

```bash
git add frontend/src/components/dashboard/inventory/StockPositionTable.tsx
git commit -m "feat(inventory): generic stock-position lens table"
```

### Task 10: MovementsTable

**Files:**
- Create: `frontend/src/components/dashboard/inventory/MovementsTable.tsx`

- [ ] **Step 1: Implement** (analogous to Task 9, reads `svc.listMovements`, columns: Date, Type, Item, Ownership, From→To, Qty Δ, Reference, Actor; show a "showing most recent activity" hint).

```tsx
"use client";
import * as React from "react";
import * as svc from "@/services/stockPosition.service";
import type { PagedMovements } from "@/types/stock-position";
import { Pagination } from "@/components/ui/Pagination";

export function MovementsTable() {
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<PagedMovements | null>(null);
  React.useEffect(() => { svc.listMovements({ page, pageSize: 25 }).then(setData).catch(() => setData(null)); }, [page]);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Showing the most recent stock activity across all pools.</p>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead><tr className="border-b bg-muted/30 text-left text-xs uppercase text-muted-foreground">
            {["Date","Type","Item","Owner","From → To","Qty","Reference","Actor"].map(h => <th key={h} className="px-3 py-2">{h}</th>)}
          </tr></thead>
          <tbody>
            {(data?.movements ?? []).map((m) => (
              <tr key={m.id} className="border-b last:border-0">
                <td className="px-3 py-2">{new Date(m.date).toLocaleString()}</td>
                <td className="px-3 py-2">{m.type.replace(/_/g, " ")}</td>
                <td className="px-3 py-2">{m.itemName}</td>
                <td className="px-3 py-2">{m.ownership === "company" ? "Company" : "Customer"}</td>
                <td className="px-3 py-2">{[m.fromLabel, m.toLabel].filter(Boolean).join(" → ") || "—"}</td>
                <td className={`px-3 py-2 ${m.quantityDelta < 0 ? "text-red-600" : "text-emerald-600"}`}>{m.quantityDelta > 0 ? `+${m.quantityDelta}` : m.quantityDelta}</td>
                <td className="px-3 py-2">{m.reference ?? "—"}</td>
                <td className="px-3 py-2">{m.actor ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data ? <Pagination page={data.page} totalPages={data.totalPages} total={data.total} label="movements" onPage={setPage} /> : null}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/dashboard/inventory/MovementsTable.tsx
git commit -m "feat(inventory): movements table"
```

### Task 11: InventoryHub container (tabs + cards), wire into page

**Files:**
- Create: `frontend/src/components/dashboard/inventory/InventoryHub.tsx`
- Modify: `frontend/src/app/dashboard/inventory/page.tsx`

**Interfaces:**
- Consumes: `SummaryCards`, `StockPositionTable`, `MovementsTable`, existing `InventoryView` (Company lens).

- [ ] **Step 1: Implement Hub**

```tsx
"use client";
import * as React from "react";
import { SummaryCards } from "./SummaryCards";
import { StockPositionTable } from "./StockPositionTable";
import { MovementsTable } from "./MovementsTable";
import { InventoryView } from "./InventoryView";

type Lens = "all" | "company" | "customer" | "engineer" | "damaged" | "movements";
const TABS: { id: Lens; label: string }[] = [
  { id: "all", label: "All Inventory" }, { id: "company", label: "Company" },
  { id: "customer", label: "Customer" }, { id: "engineer", label: "Engineer" },
  { id: "damaged", label: "Damaged" }, { id: "movements", label: "Movements" },
];

export function InventoryHub() {
  const [lens, setLens] = React.useState<Lens>("all");
  return (
    <div className="space-y-5 p-4">
      <div>
        <h1 className="text-2xl font-semibold">Warehouse Inventory</h1>
        <p className="text-sm text-muted-foreground">Everything the business is accountable for — by ownership and current location.</p>
      </div>
      <SummaryCards active={lens} onSelect={(l) => setLens(l)} />
      <div className="flex flex-wrap gap-1 border-b">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setLens(t.id)}
            className={`px-3 py-2 text-sm ${lens === t.id ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {lens === "all" && <StockPositionTable columns={["item","sku","ownership","location","qty","available","value","status","lastMovement"]} />}
      {lens === "company" && <InventoryView embedded />}
      {lens === "customer" && <StockPositionTable fixedFilters={{ ownership: "customer", location: "warehouse" }} columns={["item","sku","customer","warehouse","qty","status","lastMovement"]} />}
      {lens === "engineer" && <StockPositionTable fixedFilters={{ location: "engineer" }} columns={["item","ownership","engineer","qty","lastMovement"]} />}
      {lens === "damaged" && <StockPositionTable fixedFilters={{ location: "damaged" }} columns={["item","ownership","warehouse","qty","lastMovement"]} />}
      {lens === "movements" && <MovementsTable />}
    </div>
  );
}
```

- [ ] **Step 2: Wire page**

```tsx
// frontend/src/app/dashboard/inventory/page.tsx
import { PermissionGate } from "@/components/auth/PermissionGate";
import { InventoryHub } from "@/components/dashboard/inventory/InventoryHub";
export default function InventoryPage() {
  return (<PermissionGate anyOf={["inventory.view"]}><InventoryHub /></PermissionGate>);
}
```

- [ ] **Step 3: Verify + commit**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: PASS; navigate `/dashboard/inventory`, confirm tabs + cards render and Company lens matches the old table.

```bash
git add frontend/src/components/dashboard/inventory/InventoryHub.tsx frontend/src/app/dashboard/inventory/page.tsx
git commit -m "feat(inventory): Inventory Hub with lenses + cards"
```

---

## PHASE C — New write actions

### Task 12: Company **Adjust** (downward correction)

**Files:**
- Modify: `backend/src/modules/inventory/inventory.validation.ts`, `inventory.service.ts`, `inventory.repository.ts`, `inventory.controller.ts`, `inventory.routes.ts`
- Create: `frontend/src/components/dashboard/inventory/AdjustStockForm.tsx`

**Interfaces:**
- Produces: `POST /inventory/adjust` (`inventory.adjust`) consuming `{ irmItemId, warehouseId, quantity (>0 units to REMOVE), reason, movementDate, referenceNumber?, notes? }`; service `adjustStock(input, actor)` writing a negative `manual_adjust` transaction + ADJ code, guarding `available >= quantity`.

- [ ] **Step 1: Validation**

```ts
// inventory.validation.ts (append)
export const STOCK_ADJUST_DOWN_REASONS = ["damage_correction", "shrinkage", "miscount", "other"] as const;
export const adjustStockSchema = z.object({
  irmItemId: z.string().regex(OBJECT_ID_RE, "Select an item."),
  warehouseId: z.string().regex(OBJECT_ID_RE, "Select a warehouse."),
  quantity: z.coerce.number().int("Use a whole number.").min(1, "Quantity must be at least 1.").max(10_000_000),
  movementDate: requiredPastOrTodayDate("Movement date"),
  reason: z.enum(STOCK_ADJUST_DOWN_REASONS, { error: "Select a reason." }),
  referenceNumber: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
```

- [ ] **Step 2: Repository primitive** (mirror `createStockAdjustmentWithCode` but allow negative delta + balance guard)

```ts
// inventory.repository.ts (append)
export async function createNegativeAdjustmentWithCode(
  header: StockAdjustmentHeaderInput, ledger: StockAdjustmentLedgerInput, // ledger.quantity is the POSITIVE amount to remove
): Promise<{ adjustment: StockAdjustment; balanceAfter: number }> {
  return prisma.$transaction(async (tx) => {
    const bal = await findBalancePairTx(tx, ledger.irmItemId, ledger.warehouseId);
    const onHand = bal?.quantityOnHand ?? 0;
    const reserved = bal?.quantityReserved ?? 0;
    if (onHand - reserved < ledger.quantity) throw new HttpError(409, "Not enough available stock to adjust.");
    const code = `ADJ-${String(await nextAdjustmentSequence()).padStart(4, "0")}`;
    const adjustment = await tx.stockAdjustment.create({ data: { ...header, code } });
    const updated = await upsertBalanceTx(tx, ledger.irmItemId, ledger.warehouseId, -ledger.quantity);
    await insertTransactionTx(tx, {
      irmItemId: ledger.irmItemId, warehouseId: ledger.warehouseId, quantityDelta: -ledger.quantity,
      type: "manual_adjust", sourceType: "stock_adjustment", sourceId: adjustment.id, sourceCode: code,
      balanceAfter: updated.quantityOnHand, notes: ledger.notes, createdBy: ledger.createdBy,
    });
    return { adjustment, balanceAfter: updated.quantityOnHand };
  });
}
```
> Import `HttpError` at top of repository if not present. (Repos may throw `HttpError` here since it's a guard, consistent with existing `createTransferWithCode` validate-callback pattern.)

- [ ] **Step 3: Service + controller + route**

```ts
// inventory.service.ts (append)
export async function adjustStock(input: AdjustStockInput, actor?: AuditActor): Promise<PublicStockAdjustment> {
  const item = await irmRepo.findActiveById(input.irmItemId); // reuse existing item lookup used by addStock
  if (!item) throw new HttpError(400, "Item not found or inactive.");
  if (item.trackSerialNumbers || item.trackBatchNumbers) throw new HttpError(400, "Serial/batch items can't be bulk-adjusted.");
  const { adjustment } = await inventoryRepo.createNegativeAdjustmentWithCode(
    { warehouseId: input.warehouseId, reason: input.reason, movementDate: new Date(input.movementDate),
      referenceNumber: input.referenceNumber ?? null, notes: input.notes ?? null, createdBy: actor?.email ?? null },
    { irmItemId: input.irmItemId, warehouseId: input.warehouseId, quantity: input.quantity,
      notes: input.notes ?? null, createdBy: actor?.email ?? null },
  );
  void audit.log(actor, "inventory.adjusted", { code: adjustment.code }); // reuse existing audit helper
  return toPublicAdjustment(adjustment); // reuse existing serializer used by addStock
}
```
```ts
// inventory.controller.ts (append)
export const adjustStock = asyncHandler(async (req, res) => {
  const actor = { id: req.userId, email: req.userEmail };
  res.status(201).json(await inventoryService.adjustStock(req.body, actor));
});
```
```ts
// inventory.routes.ts (append)
router.post("/adjust", requirePermission("inventory.adjust"), writeLimiter, validateBody(adjustStockSchema), inventoryController.adjustStock);
```

- [ ] **Step 4: Frontend form + wrapper** — add `adjustStock(payload)` to `inventory.service.ts` (frontend) and an `AdjustStockForm.tsx` modeled on the existing `AddStockForm.tsx` (item + warehouse select, quantity to remove, reason enum, live "new balance = current − qty" using `getAvailability`, guard qty ≤ available). Surface an "Adjust" button on the Company lens action bar gated by `can("inventory.adjust")`.

- [ ] **Step 5: Verify + commit**

Run: `cd backend && pnpm typecheck && pnpm lint && pnpm test`; `cd frontend && pnpm lint`
Expected: PASS.

```bash
git add backend/src/modules/inventory frontend/src/components/dashboard/inventory/AdjustStockForm.tsx frontend/src/services/inventory.service.ts
git commit -m "feat(inventory): downward stock adjust action"
```

### Task 13: Customer **Transfer** (warehouse ↔ warehouse consignment)

**Files:**
- Modify customer module: `customer.validation.ts`, `customer.service.ts`, `customer.repository.ts`, `customer.controller.ts`, `customer.routes.ts`
- Create: `frontend/src/components/dashboard/inventory/CustomerTransferForm.tsx`

**Interfaces:**
- Produces: `POST /customers/stock/transfer` (`customer_stock.move` or existing customer-stock write perm) consuming `{ customerStockEntryId, toWarehouseId, quantity, movementDate, notes? }`; service moves quantity between two `CustomerStockEntry` rows of the same customer+item (decrement source, upsert/find destination active entry for that item at the destination warehouse, increment), atomic, no value, append a movement note. Mirror `transferStock` semantics minus valuation.

- [ ] **Step 1–4:** validation (zod), repo atomic `transferCustomerStockTx`, service `transferCustomerStock(input, actor)` (guard source.quantity ≥ qty; if no destination entry exists for the same item/customer at the target warehouse, create one in `active` status copying item fields, no price), controller, route. Audit `customer_stock.transferred`.
- [ ] **Step 5:** frontend `CustomerTransferForm.tsx` (entry select scoped to customer lens row, destination warehouse, quantity ≤ available), "Transfer" button on Customer lens gated by the customer-stock write permission; also "Receive" and "Return" buttons deep-link to the existing customer-stock receive/return flows (no new logic).

Run: `cd backend && pnpm typecheck && pnpm lint && pnpm test`; `cd frontend && pnpm lint`

```bash
git add backend/src/modules/customer frontend/src/components/dashboard/inventory/CustomerTransferForm.tsx
git commit -m "feat(customer-stock): warehouse transfer for consignment"
```

### Task 14: Damaged **Restore** (reverse a write-off)

**Files:**
- Modify goods-management: `goods-management.validation.ts`, `goods-management.service.ts`, `goods-management.repository.ts`, `goods-management.controller.ts`, `goods-management.routes.ts`
- Create: `frontend/src/components/dashboard/inventory/RestoreDamagedDialog.tsx`

**Interfaces:**
- Produces: `POST /goods-management/damaged/restore` (`goods_management.reconcile`) consuming `{ warehouseId, ownerType, irmItemId?, customerStockEntryId?, quantity, notes }`; service decrements `DamagedStockBalance` (guard ≥ qty) and returns the units to usable stock — company → `InventoryBalance` (+qty, `manual_adjust` txn coded ADJ, type `restore`); customer → the matching `CustomerStockEntry` (+qty). Appends a `DamagedStockTransaction` with negative `quantityDelta` (the first reversal allowed) and a positive ledger row on the destination. Atomic; audit `goods_management.damaged_restored`.

- [ ] **Step 1: Repo primitive `restoreDamagedTx`** — single `$transaction`: load damaged balance, guard `quantity >= qty`, decrement it (append `DamagedStockTransaction` `quantityDelta = -qty`, `sourceType="damaged_restore"`), then for company upsert `InventoryBalance(+qty)` + `InventoryTransaction(type:"restore")`, for customer increment the `CustomerStockEntry(+qty)`.
- [ ] **Step 2–4:** validation, service `restoreDamaged(input, actor)`, controller, route.
- [ ] **Step 5:** frontend `RestoreDamagedDialog.tsx` (qty ≤ damaged quantity, notes required), "Restore" + existing "Write-off" buttons on the Damaged lens gated by `goods_management.reconcile`.

Run: `cd backend && pnpm typecheck && pnpm lint && pnpm test`; `cd frontend && pnpm lint`

```bash
git add backend/src/modules/goods-management frontend/src/components/dashboard/inventory/RestoreDamagedDialog.tsx
git commit -m "feat(goods-mgmt): restore damaged stock to usable"
```

### Task 15: per-lens action bars + existing-flow deep links

**Files:**
- Modify: `frontend/src/components/dashboard/inventory/InventoryHub.tsx` (+ small `LensActions.tsx` if cleaner)

**Interfaces:**
- Each lens header shows its actions gated by permission: Company → Add Stock / Move / Adjust / Export (Add/Move/Export deep-link to existing routes; Adjust opens Task 12 form). Customer → Receive / Return (existing flows) / Transfer (Task 13). Engineer → Issue / Return / Reconcile (deep-link to goods-management for the relevant job). Damaged → Write-off / Restore (Task 14).

- [ ] **Step 1:** Render an actions row per lens reading `can(...)`; reuse existing navigation targets (`/dashboard/inventory/move`, `/dashboard/inventory/add-stock`, goods-management job routes). No business logic in the Hub.
- [ ] **Step 2:** Verify + commit.

```bash
git add frontend/src/components/dashboard/inventory/InventoryHub.tsx
git commit -m "feat(inventory): per-lens action bars wired to existing flows"
```

---

## PHASE D — Item-level Inventory Detail

### Task 16: Detail endpoints (item-scoped slices)

**Files:**
- Modify: `backend/src/modules/inventory/aggregation.service.ts`, `inventory.controller.ts`, `inventory.routes.ts`

**Interfaces:**
- Produces:
  - `GET /inventory/items/:irmItemId/distribution` → `StockPosition[]` for that item across all locations (reuse `assembleAll` filtered to `itemId`).
  - `GET /inventory/items/:irmItemId/holders` → `{ engineers: {...}[]; customers: {...}[] }`.
  - `GET /inventory/items/:irmItemId/jobs` → jobs whose kit lines reference the item (reuse goods-management/job repo).
  - Existing endpoints already cover Overview, Movement history (`/:id/transactions`), Reservations/incoming (`getInventory` → `incoming`/`outgoing`), Purchases, Audit (audit service).

- [ ] **Step 1:** add `getItemDistribution(irmItemId)` to aggregation service: `const all = await assembleAll({}); return all.filter(p => p.itemId === irmItemId || (p.itemKind === "irm" && p.itemId === irmItemId));`
- [ ] **Step 2:** add `getItemHolders(irmItemId)` querying engineer balances + customer holdings for that item (new thin repo reads).
- [ ] **Step 3:** add `getItemJobs(irmItemId)` reusing existing job-kit-line lookup.
- [ ] **Step 4:** controllers + routes (`inventory.view`).
- [ ] **Step 5:** Verify + commit.

Run: `cd backend && pnpm typecheck && pnpm lint`

```bash
git add backend/src/modules/inventory
git commit -m "feat(inventory): item-level distribution/holders/jobs endpoints"
```

### Task 17: Inventory Detail page (9 sections)

**Files:**
- Create: `frontend/src/components/dashboard/inventory/detail/InventoryDetailPage.tsx` + section components.
- Modify: `frontend/src/app/dashboard/inventory/[id]/page.tsx`

**Interfaces:**
- Composes sections in this order: **Overview → Current Position → Current Distribution → Movement History → Reservations/Allocations → Jobs using → Engineers holding → Customer holdings → Audit Trail**. Each section is its own component reading one service (reuse `getInventory`, `listInventoryTransactions`, `listPurchaseHistory`, new distribution/holders/jobs, audit service).

- [ ] **Step 1:** Build `InventoryDetailPage` that loads the balance via `getInventory(id)` for Overview + Current Position (totals), then lazy-loads each section. Reuse the existing detail's Overview/Transactions/Purchases markup where present; add Distribution (renders `StockPosition` rows grouped by location), Holders, Jobs, Audit sections.
- [ ] **Step 2:** Wire `[id]/page.tsx` to render `InventoryDetailPage` behind `PermissionGate anyOf={["inventory.view"]}`.
- [ ] **Step 3:** Verify + commit.

Run: `cd frontend && pnpm lint && pnpm build`
Expected: PASS; open an item, confirm all 9 sections render (empty states honest where no data).

```bash
git add frontend/src/components/dashboard/inventory/detail frontend/src/app/dashboard/inventory/[id]/page.tsx
git commit -m "feat(inventory): item-level Inventory Detail page"
```

---

## PHASE E — Hardening

### Task 18: realtime refresh, CSV for All-Inventory, final pass

**Files:**
- Modify: `InventoryHub.tsx` (subscribe to existing goods socket → refetch summary + active lens), `aggregation.service.ts`/controller (add `GET /inventory/positions/export.csv` reusing the CSV-escape util), `stockPosition.service.ts`.

- [ ] **Step 1:** Add `useGoodsSocket()` refresh hook to the Hub so issue/return/reconcile events refresh cards + table (reuse existing socket hook used by `EngineerInventory`).
- [ ] **Step 2:** Add a formula-injection-safe CSV export for the All-Inventory lens (reuse the existing escaping helper from `inventory.service` CSV).
- [ ] **Step 3:** Final verification.

Run backend: `cd backend && pnpm typecheck && pnpm lint && pnpm test`
Run frontend: `cd frontend && pnpm lint && pnpm build`
Expected: all PASS.

```bash
git add -A
git commit -m "feat(inventory): realtime refresh + All-Inventory CSV export"
```

---

## Self-Review notes (spec coverage)

- All-Inventory + Company/Customer/Engineer/Damaged/Movements lenses → Tasks 4,5,9,10,11.
- Ownership × Current Location model → Task 1 (`StockPosition`).
- Engineer stock counted in totals → Task 4 summary + engineer lens.
- Actions per lens (Add/Move/Adjust/Export, Receive/Return/Transfer, Issue/Return/Reconcile, Write-off/Restore) → Tasks 12–15.
- Orchestrate, no duplicate logic → all actions call owning-module services; Hub holds none.
- New logic (aggregation, Adjust, Customer Transfer, Damaged Restore) → Tasks 4,12,13,14.
- Item Detail 9 sections in spec order → Tasks 16–17.
- No price/value on customer & damaged-customer → mappers null those fields (Task 1).
- Permissions, audit, atomic ledgers → Phase C tasks + Global Constraints.
