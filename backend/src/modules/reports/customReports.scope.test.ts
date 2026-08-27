import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Warehouse scope across the REAL Custom Reports → movement.service boundary ─────────────────
//
// The sibling `customReports.service.test.ts` mocks `listMovements` itself, which is right for the
// registry/filter rules it tests and is exactly why it could not see this bug: the report computed
// `scopeWarehouseIds` correctly, and `listMovements` then OVERWROTE it from an actor argument the
// report never passed. Asserting the filter object handed to a mock proved the caller's intent, not
// the callee's behaviour, and the two disagreed.
//
// So this file mocks NOTHING between the report and the movement service. The seam is moved down to
// the repositories — the Prisma boundary — and every layer above it runs for real:
//
//     runCustomReport → movement.service.listMovements → selectLedgers/queryUnified → [repo spies]
//
// What that buys: `scopeWarehouseIds` is observed where it is actually consumed, and the LEDGER
// SELECTION rule (a scoped caller must never receive the engineer-van ledgers, which carry no
// warehouseId to check) is exercised rather than assumed.

const inventoryRepo = vi.hoisted(() => ({
  findInventoryTxnPage: vi.fn(),
  findIrmMetaByIds: vi.fn(),
  findWarehouseNamesByIds: vi.fn(),
}));
const engineerRepo = vi.hoisted(() => ({
  findEngineerTxnPage: vi.fn(),
  findEngineerNamesByIds: vi.fn(),
}));
const gmRepo = vi.hoisted(() => ({
  findEngineerCustomerTxnPage: vi.fn(),
  findDamagedTxnPage: vi.fn(),
  findCustomerStockEntryIdsByCustomer: vi.fn(),
  findCustomerEntryMetaByIds: vi.fn(),
}));
const reportRepo = vi.hoisted(() => ({ findMovementJobProjects: vi.fn(), findEngineerHoldings: vi.fn() }));

vi.mock("#modules/inventory/inventory.repository.js", () => inventoryRepo);
vi.mock("#modules/engineer/engineer.repository.js", () => engineerRepo);
vi.mock("#modules/goods-management/goods-management.repository.js", () => gmRepo);
vi.mock("./customReports.repository.js", () => reportRepo);
// Pulled in by movement.service for its CSV export only; kept out so no test touches Prisma.
vi.mock("#modules/settings/settings.service.js", () => ({ getRegionalSettings: vi.fn() }));
vi.mock("#modules/document/document.formatter.js", () => ({ formatDateTime: (d: Date) => d.toISOString() }));

import { runCustomReport } from "./customReports.service.js";

/** A warehouse-scoped staff user — the seeded `warehouse_manager` shape. */
const SCOPED = {
  id: "u1",
  type: "user" as const,
  email: "wm@x.co",
  permissions: ["reports.view"],
  assignedWarehouseIds: ["wh-leeds"],
};
/** An unrestricted staff user: `assignedWarehouseIds: null` is what "not warehouse-scoped" means. */
const UNRESTRICTED = {
  id: "u2",
  type: "user" as const,
  email: "pm@x.co",
  permissions: ["reports.view"],
  assignedWarehouseIds: null,
};
/** A customer principal. `actorFrom` gives every non-"user" type a null warehouse set. */
const CUSTOMER = { id: "c1", type: "customer" as const, email: "bt@x.co", permissions: [], assignedWarehouseIds: null };

const invTxn = (id: string, warehouseId: string) => ({
  id,
  createdAt: new Date(`2026-05-0${id.slice(-1)}T09:00:00.000Z`),
  type: "goods_out",
  warehouseId,
  warehouse: { name: warehouseId === "wh-leeds" ? "Leeds Depot" : "Bristol Depot" },
  irmItemId: "irm1",
  irmItem: { code: "IRM-0010", name: "SFP-LX", sku: "SFP" },
  quantityDelta: -1,
  balanceAfter: 4,
  sourceCode: "GM-0001",
  sourceType: "goods_management",
  sourceId: "jsm1",
  createdBy: "wm@x.co",
  notes: null,
});

const engTxn = (id: string) => ({
  id,
  createdAt: new Date("2026-05-04T09:00:00.000Z"),
  type: "job_issue",
  engineerId: "eng-secret",
  irmItemId: "irm9",
  quantityDelta: -1,
  sourceType: "goods_management",
  sourceId: "jsm9",
});

const engCustTxn = (id: string) => ({
  id,
  createdAt: new Date("2026-05-03T09:00:00.000Z"),
  type: "job_issue",
  engineerId: "eng-secret",
  customerStockEntryId: "cse1",
  quantityDelta: -1,
  sourceType: "goods_management",
  sourceId: "jsm8",
});

beforeEach(() => {
  vi.clearAllMocks();
  // The inventory ledger HONOURS the scope it is given — this is the spy standing in for the Prisma
  // `warehouseId: { in }` clause, so "forbidden warehouse data absent" is a real filtering result
  // rather than a hand-picked fixture.
  inventoryRepo.findInventoryTxnPage.mockImplementation(
    async (f: { scopeWarehouseIds?: string[]; warehouseId?: string }) => {
      const all = [invTxn("tx1", "wh-leeds"), invTxn("tx2", "wh-bristol")];
      return all.filter((r) => {
        if (f.scopeWarehouseIds !== undefined && !f.scopeWarehouseIds.includes(r.warehouseId)) return false;
        if (f.warehouseId && r.warehouseId !== f.warehouseId) return false;
        return true;
      });
    },
  );
  engineerRepo.findEngineerTxnPage.mockResolvedValue([engTxn("etx1")]);
  gmRepo.findEngineerCustomerTxnPage.mockResolvedValue([engCustTxn("ectx1")]);
  gmRepo.findDamagedTxnPage.mockResolvedValue([]);
  gmRepo.findCustomerStockEntryIdsByCustomer.mockResolvedValue(["cse1"]);
  gmRepo.findCustomerEntryMetaByIds.mockResolvedValue(
    new Map([["cse1", { itemName: "Customer ONT", sku: "ONT-1", customerId: "c1", customerName: "BT" }]]),
  );
  engineerRepo.findEngineerNamesByIds.mockResolvedValue(new Map([["eng-secret", "Karthik"]]));
  inventoryRepo.findIrmMetaByIds.mockResolvedValue(new Map());
  inventoryRepo.findWarehouseNamesByIds.mockResolvedValue(new Map());
  reportRepo.findMovementJobProjects.mockResolvedValue(new Map());
  reportRepo.findEngineerHoldings.mockResolvedValue([]);
});

describe("Stock Movement — a warehouse-scoped actor is scoped at the real boundary", () => {
  it("reaches the inventory ledger WITH the actor's warehouse set", async () => {
    await runCustomReport(SCOPED, { reportKey: "stock_movement", filters: {} });

    expect(inventoryRepo.findInventoryTxnPage).toHaveBeenCalled();
    const [filters] = inventoryRepo.findInventoryTxnPage.mock.calls[0]!;
    // The regression in one assertion: this was `undefined`, i.e. unrestricted.
    expect(filters.scopeWarehouseIds).toEqual(["wh-leeds"]);
  });

  it("returns rows from the permitted warehouse only — forbidden warehouse data is absent", async () => {
    const res = await runCustomReport(SCOPED, { reportKey: "stock_movement", filters: {} });

    const locations = res.rows.map((r) => r.location);
    expect(locations).toContain("Leeds Depot");
    expect(locations).not.toContain("Bristol Depot");
  });

  it("never queries the engineer-van ledgers, which carry no warehouseId to scope by", async () => {
    // The wider half of the leak. `selectLedgers` drops `engineer`/`engineerCustomer` only when
    // `scopeWarehouseIds` is DEFINED — so a discarded scope handed a warehouse-restricted user the
    // company-wide field ledger, which is more than the scope was ever protecting.
    const res = await runCustomReport(SCOPED, { reportKey: "stock_movement", filters: {} });

    expect(engineerRepo.findEngineerTxnPage).not.toHaveBeenCalled();
    expect(gmRepo.findEngineerCustomerTxnPage).not.toHaveBeenCalled();
    expect(res.rows.map((r) => r.engineerName)).not.toContain("Karthik");
  });

  it("scopes Project Activity the same way", async () => {
    await runCustomReport(SCOPED, { reportKey: "project_activity", filters: {} });

    const [filters] = inventoryRepo.findInventoryTxnPage.mock.calls[0]!;
    expect(filters.scopeWarehouseIds).toEqual(["wh-leeds"]);
    expect(engineerRepo.findEngineerTxnPage).not.toHaveBeenCalled();
  });

  it("a scoped actor with an EMPTY warehouse set sees nothing, not everything", async () => {
    // `[]` is a restricted actor assigned no warehouses. It must read as "matches nothing"; the bug
    // made it indistinguishable from unrestricted.
    const res = await runCustomReport(
      { ...SCOPED, assignedWarehouseIds: [] },
      { reportKey: "stock_movement", filters: {} },
    );

    const [filters] = inventoryRepo.findInventoryTxnPage.mock.calls[0]!;
    expect(filters.scopeWarehouseIds).toEqual([]);
    expect(res.rows).toHaveLength(0);
  });
});

describe("Stock Movement — unrestricted and customer behaviour is unchanged", () => {
  it("an unrestricted actor still reads company-wide, across every ledger", async () => {
    const res = await runCustomReport(UNRESTRICTED, { reportKey: "stock_movement", filters: {} });

    const [filters] = inventoryRepo.findInventoryTxnPage.mock.calls[0]!;
    expect(filters.scopeWarehouseIds).toBeUndefined();
    expect(engineerRepo.findEngineerTxnPage).toHaveBeenCalled();
    expect(gmRepo.findEngineerCustomerTxnPage).toHaveBeenCalled();
    expect(res.rows.map((r) => r.location)).toEqual(expect.arrayContaining(["Leeds Depot", "Bristol Depot"]));
  });

  it("a customer report stays isolated by customerId, on the customer ledgers only", async () => {
    // FLOW 9 isolation is `customerId` — forced from the session — not warehouse scope. It must
    // survive this change untouched: a customer principal is unrestricted for warehouses, so the
    // ledger set is chosen by `customerId` alone.
    const res = await runCustomReport(
      CUSTOMER,
      { reportKey: "stock_movement", filters: {} },
      { isCustomer: true, customerId: "c1" },
    );

    expect(gmRepo.findCustomerStockEntryIdsByCustomer).toHaveBeenCalledWith("c1");
    const [ecFilters] = gmRepo.findEngineerCustomerTxnPage.mock.calls[0]!;
    expect(ecFilters.customerStockEntryIds).toEqual(["cse1"]);
    // Company IRM warehouse ledgers are not a customer's data and are not queried for them.
    expect(inventoryRepo.findInventoryTxnPage).not.toHaveBeenCalled();
    expect(engineerRepo.findEngineerTxnPage).not.toHaveBeenCalled();
    expect(res.rows.every((r) => r.customerName === "BT")).toBe(true);
  });

  it("a customer cannot widen themselves by naming another customer in the query", async () => {
    await runCustomReport(
      CUSTOMER,
      { reportKey: "stock_movement", filters: { customerId: "c-other" } },
      { isCustomer: true, customerId: "c1" },
    );

    expect(gmRepo.findCustomerStockEntryIdsByCustomer).toHaveBeenCalledWith("c1");
    expect(gmRepo.findCustomerStockEntryIdsByCustomer).not.toHaveBeenCalledWith("c-other");
  });
});
