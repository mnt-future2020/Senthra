import { beforeEach, describe, expect, it, vi } from "vitest";

// The unified movement ledger must be narrowed to the caller's WAREHOUSE SCOPE. It wasn't: the
// controller never passed an actor, so a warehouse-restricted user holding `inventory.history` could
// read — and CSV-export — any warehouse's history by passing `?warehouse=<other>`. The UI never offers
// that, but the endpoint is callable directly.
//
// Each ledger is mocked to record the filters it was handed, so these tests assert the SCOPE reaching
// the queries rather than any database behaviour.
const inventoryPage = vi.fn(() => Promise.resolve([]));
const damagedPage = vi.fn(() => Promise.resolve([]));
const engineerPage = vi.fn(() => Promise.resolve([]));
const engineerCustomerPage = vi.fn(() => Promise.resolve([]));

vi.mock("./inventory.repository.js", () => ({
  findInventoryTxnPage: (...a: unknown[]) => inventoryPage(...(a as [])),
  findIrmMetaByIds: () => Promise.resolve(new Map()),
  findWarehouseNamesByIds: () => Promise.resolve(new Map()),
}));
vi.mock("#modules/engineer/engineer.repository.js", () => ({
  findEngineerTxnPage: (...a: unknown[]) => engineerPage(...(a as [])),
  findEngineerNamesByIds: () => Promise.resolve(new Map()),
}));
// The CSV export renders timestamps in the COMPANY timezone, so it reads Settings — which goes to
// Prisma. Stubbed to keep this a unit test (otherwise it silently requires a live MongoDB).
vi.mock("#modules/settings/settings.service.js", () => ({
  getRegionalSettings: vi.fn(async () => ({ timezone: "Europe/London", dateFormat: "DD/MM/YYYY", timeFormat: "24h" })),
}));
// The engineer-CUSTOMER ledger lives on the goods-management repo, not the engineer one.
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({
  findEngineerCustomerTxnPage: (...a: unknown[]) => engineerCustomerPage(...(a as [])),
  findDamagedTxnPage: (...a: unknown[]) => damagedPage(...(a as [])),
  findCustomerStockEntryIdsByCustomer: () => Promise.resolve([]),
  findCustomerEntryMetaByIds: () => Promise.resolve(new Map()),
}));

const { listMovements, exportMovementsCsv } = await import("./movement.service.js");

/** A warehouse-scoped staff user — the principal shape requireAuth builds for a scoped role. */
const scopedTo = (ids: string[]) => ({ type: "user", assignedWarehouseIds: ids });
/** Super-admin / non-scoped role — `assignedWarehouseIds` absent means unrestricted. */
const UNRESTRICTED = { type: "user" };

const filtersOf = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls[0]?.[0] as Record<string, unknown>;

beforeEach(() => {
  inventoryPage.mockClear();
  damagedPage.mockClear();
  engineerPage.mockClear();
  engineerCustomerPage.mockClear();
});

describe("listMovements — warehouse scope", () => {
  it("passes the actor's warehouses to the warehouse-located ledgers", async () => {
    await listMovements({}, null, 25, scopedTo(["w1", "w2"]));
    expect(filtersOf(inventoryPage).scopeWarehouseIds).toEqual(["w1", "w2"]);
    expect(filtersOf(damagedPage).scopeWarehouseIds).toEqual(["w1", "w2"]);
  });

  it("does NOT constrain an unrestricted actor", async () => {
    // `undefined` must mean company-wide — an empty array here would silently return nothing for
    // every admin.
    await listMovements({}, null, 25, UNRESTRICTED);
    expect(filtersOf(inventoryPage).scopeWarehouseIds).toBeUndefined();
  });

  it("treats a missing actor as unrestricted, preserving the existing internal callers", async () => {
    await listMovements({}, null, 25);
    expect(filtersOf(inventoryPage).scopeWarehouseIds).toBeUndefined();
  });

  it("SKIPS the engineer ledgers entirely for a scoped actor", async () => {
    // Engineer/van rows carry no warehouseId, so there is nothing to check them against. Returning
    // them unfiltered would hand a warehouse-restricted user the company-wide field ledger — a wider
    // leak than the one being closed.
    await listMovements({}, null, 25, scopedTo(["w1"]));
    expect(engineerPage).not.toHaveBeenCalled();
    expect(engineerCustomerPage).not.toHaveBeenCalled();
    expect(inventoryPage).toHaveBeenCalled();
  });

  it("still queries the engineer ledgers for an unrestricted actor", async () => {
    await listMovements({}, null, 25, UNRESTRICTED);
    expect(engineerPage).toHaveBeenCalled();
    expect(engineerCustomerPage).toHaveBeenCalled();
  });

  it("keeps the requested warehouse ALONGSIDE the scope, never instead of it", async () => {
    // Asking for a warehouse inside the scope must not drop the scope — otherwise the guard is
    // bypassed by the very parameter it exists to police.
    await listMovements({ warehouseId: "w1" }, null, 25, scopedTo(["w1", "w2"]));
    const f = filtersOf(inventoryPage);
    expect(f.warehouseId).toBe("w1");
    expect(f.scopeWarehouseIds).toEqual(["w1", "w2"]);
  });

  it("a request for a warehouse OUTSIDE the scope resolves to no rows", async () => {
    // Both constraints are ANDed, so `warehouseId: w9` ∩ `scope: [w1]` is empty — the caller gets an
    // empty page rather than another warehouse's ledger.
    await listMovements({ warehouseId: "w9" }, null, 25, scopedTo(["w1"]));
    const f = filtersOf(inventoryPage);
    expect(f.warehouseId).toBe("w9");
    expect(f.scopeWarehouseIds).toEqual(["w1"]);
  });

  it("an actor scoped to NO warehouses matches nothing rather than everything", async () => {
    // The empty array must survive as `in: []`. Collapsing it to `undefined` would read as
    // "unrestricted" and hand this actor the whole ledger.
    await listMovements({}, null, 25, scopedTo([]));
    expect(filtersOf(inventoryPage).scopeWarehouseIds).toEqual([]);
  });

  it("ignores a scope supplied by the CALLER, taking it only from the actor", async () => {
    // Belt and braces: `movementFiltersFrom(req.query)` never reads this key, and even if a filters
    // object arrives carrying one it is overwritten by the actor's real scope.
    await listMovements({ scopeWarehouseIds: ["attacker"] }, null, 25, scopedTo(["w1"]));
    expect(filtersOf(inventoryPage).scopeWarehouseIds).toEqual(["w1"]);
  });
});

describe("exportMovementsCsv — warehouse scope", () => {
  it("applies the same scope as the list read", async () => {
    // An export that ignored the scope would be the easier way to take what the list refuses to show.
    await exportMovementsCsv({}, scopedTo(["w1"]));
    expect(filtersOf(inventoryPage).scopeWarehouseIds).toEqual(["w1"]);
    expect(engineerPage).not.toHaveBeenCalled();
  });

  it("stays company-wide for an unrestricted actor", async () => {
    await exportMovementsCsv({}, UNRESTRICTED);
    expect(filtersOf(inventoryPage).scopeWarehouseIds).toBeUndefined();
  });
});
