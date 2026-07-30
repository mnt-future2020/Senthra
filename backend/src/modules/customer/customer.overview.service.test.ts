import { describe, expect, it } from "vitest";

// `shapeStockByWarehouse` is pure, so it needs none of the repository/audit mocking the other
// customer-service suites set up — it is imported directly.
import { shapeStockByWarehouse } from "./customer.service.js";

type Grouped = { warehouseId: string; units: number; entries: number };
type Wh = { id: string; name: string; code: string } | null;

const LONDON = { id: "w1", name: "London Fulfillment Centre", code: "WH-0009" };
const LEEDS = { id: "w2", name: "Leeds Depot", code: "WH-0002" };

describe("shapeStockByWarehouse", () => {
  it("returns nothing for a customer holding no stock", () => {
    expect(shapeStockByWarehouse([], [])).toEqual([]);
  });

  it("names each grouped row from the matching warehouse, and keeps its id", () => {
    const grouped: Grouped[] = [{ warehouseId: "w1", units: 40, entries: 3 }];
    expect(shapeStockByWarehouse(grouped, [LONDON])).toEqual([
      {
        // The id rides along so the dashboard row can link to My Stock filtered to this warehouse.
        // Filtering by name instead would break the moment a warehouse is renamed.
        warehouseId: "w1",
        warehouseName: "London Fulfillment Centre",
        warehouseCode: "WH-0009",
        units: 40,
        entries: 3,
      },
    ]);
  });

  it("orders by units held, biggest first — not by the order the grouping returned", () => {
    const grouped: Grouped[] = [
      { warehouseId: "w2", units: 12, entries: 1 },
      { warehouseId: "w1", units: 90, entries: 5 },
    ];
    const result = shapeStockByWarehouse(grouped, [LEEDS, LONDON]);
    expect(result.map((r) => r.warehouseName)).toEqual(["London Fulfillment Centre", "Leeds Depot"]);
  });

  it("matches warehouses by id, not by position in the array", () => {
    // The service resolves names with Promise.all over the grouped rows, so the arrays happen to line
    // up today — pairing on that rather than on id would silently mislabel every row the day it stops.
    const grouped: Grouped[] = [{ warehouseId: "w2", units: 5, entries: 1 }];
    expect(shapeStockByWarehouse(grouped, [LONDON, LEEDS])[0]?.warehouseName).toBe("Leeds Depot");
  });

  it("DROPS a row whose warehouse no longer resolves", () => {
    // Mongo has no foreign keys: a deleted warehouse leaves entries pointing at nothing. Rendering an
    // unnamed row carrying a unit count is worse for the customer than not showing it.
    const grouped: Grouped[] = [
      { warehouseId: "w1", units: 40, entries: 2 },
      { warehouseId: "gone", units: 7, entries: 1 },
    ];
    const result = shapeStockByWarehouse(grouped, [LONDON, null]);
    expect(result).toHaveLength(1);
    expect(result[0]?.warehouseName).toBe("London Fulfillment Centre");
  });

  it("keeps a zero-unit warehouse rather than hiding it", () => {
    // A warehouse holding 0 units still has entries on file (everything drawn down, or drafts at 0).
    // The customer's stock IS listed there, so the panel shouldn't claim the warehouse isn't involved.
    const grouped: Grouped[] = [
      { warehouseId: "w1", units: 0, entries: 2 },
      { warehouseId: "w2", units: 3, entries: 1 },
    ];
    const result = shapeStockByWarehouse(grouped, [LONDON, LEEDS]);
    expect(result.map((r) => r.units)).toEqual([3, 0]);
  });

  it("does not mutate the caller's array", () => {
    // `.sort()` is in-place; shaping the dashboard must not reorder the repository's result for
    // whatever else in the request happens to be holding it.
    const grouped: Grouped[] = [
      { warehouseId: "w2", units: 1, entries: 1 },
      { warehouseId: "w1", units: 99, entries: 1 },
    ];
    shapeStockByWarehouse(grouped, [LEEDS, LONDON]);
    expect(grouped.map((g) => g.warehouseId)).toEqual(["w2", "w1"]);
  });

  it("tolerates a warehouse list that resolved to nothing at all", () => {
    const grouped: Grouped[] = [{ warehouseId: "w1", units: 40, entries: 2 }];
    const none: Wh[] = [null];
    expect(shapeStockByWarehouse(grouped, none)).toEqual([]);
  });
});
