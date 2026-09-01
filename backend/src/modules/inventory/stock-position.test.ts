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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: any = {
    id: "b1", irmItemId: "i1", warehouseId: "w1", quantityOnHand: 10, quantityReserved: 2,
    irmItem: { code: "IRM-0001", name: "Cable", sku: "SKU1", baseUnit: "Each", reorderLevel: 5,
      standardCostPence: 100, category: { name: "Tools" } },
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = { id: "d1", warehouseId: "w1", ownerType: "customer", irmItemId: null,
      customerStockEntryId: "c1", customerId: "cu1", itemName: "Patch lead", quantity: 2,
      warehouse: { name: "London Hub", code: "WH-0001" }, updatedAt: new Date("2026-06-29T00:00:00Z") };
    const p = fromDamagedBalance(row);
    expect(p.ownership).toBe("customer");
    expect(p.locationType).toBe("damaged");
    expect(p.status).toBe("damaged");
    expect(p.valuePence).toBeNull();
  });
});

import { filterPositions, sortPositions, paginate } from "./stock-position.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sample = (over: Partial<any>) => ({
  itemName: "X", itemCode: "", sku: null, ownership: "company", locationType: "warehouse",
  status: "in_stock", quantity: 1, locationId: "w1", categoryName: "Tools", customerId: null, ...over,
});

describe("filterPositions", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = [
    sample({ itemName: "Cable", ownership: "company", locationType: "warehouse" }),
    sample({ itemName: "Router", ownership: "customer", locationType: "engineer" }),
    sample({ itemName: "Broken", ownership: "company", locationType: "damaged", status: "damaged" }),
  ];
  it("filters by ownership", () => expect(filterPositions(rows, { ownership: "customer" })).toHaveLength(1));
  it("filters by location", () => expect(filterPositions(rows, { locationType: "damaged" })).toHaveLength(1));
  it("search matches name", () => expect(filterPositions(rows, { search: "rout" })).toHaveLength(1));
});

describe("sortPositions", () => {
  it("sorts by itemName then locationLabel", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = [
      { ...sample({ itemName: "Zebra", locationLabel: "A" }), locationLabel: "A" },
      { ...sample({ itemName: "Apple", locationLabel: "B" }), locationLabel: "B" },
    ];
    const sorted = sortPositions(rows);
    expect(sorted[0].itemName).toBe("Apple");
    expect(sorted[1].itemName).toBe("Zebra");
  });
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
