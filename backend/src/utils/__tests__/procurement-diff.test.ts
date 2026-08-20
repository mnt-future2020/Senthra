import { describe, it, expect } from "vitest";

import { diffProcurementChanges } from "../procurement-diff.js";

// A minimal existing/incoming shape — only the fields the diff inspects.
// `lineKey` is the pairing identity. For an IRM line it IS the item id; a rental line supplies the
// (item, period, address) composite instead, because the same rental item may appear twice.
const line = (irmItemId: string, quantity: number, unitPricePence: number, vatRate: number, itemName = irmItemId) => ({
  lineKey: irmItemId,
  irmItemId,
  itemName,
  quantity,
  unitPricePence,
  vatRate,
});

describe("diffProcurementChanges — header fields", () => {
  it("records a supplier change with a human-readable label", () => {
    const changes = diffProcurementChanges(
      { supplierId: "s1", supplierName: "Alpha", warehouseId: "w1", items: [] },
      { supplierId: "s2", supplierName: "Beta", warehouseId: "w1", items: [] },
    );
    expect(changes).toEqual([{ field: "supplier", from: "Alpha", to: "Beta", label: "Supplier: Alpha → Beta" }]);
  });

  it("records a warehouse change by id when no name is available", () => {
    const changes = diffProcurementChanges(
      { supplierId: "s1", supplierName: "Alpha", warehouseId: "w1", items: [] },
      { supplierId: "s1", supplierName: "Alpha", warehouseId: "w2", items: [] },
    );
    expect(changes).toEqual([{ field: "warehouse", from: "w1", to: "w2", label: "Delivery warehouse changed" }]);
  });

  it("returns an empty array when nothing financial changed", () => {
    const same = { supplierId: "s1", supplierName: "Alpha", warehouseId: "w1", items: [line("i1", 5, 185, 20)] };
    expect(diffProcurementChanges(same, { ...same, items: [line("i1", 5, 185, 20)] })).toEqual([]);
  });
});

describe("diffProcurementChanges — line-level financial fields (readable £ / % labels)", () => {
  it("formats a unit-price change as pounds, not pence", () => {
    const changes = diffProcurementChanges(
      { supplierId: "s1", supplierName: "A", warehouseId: "w1", items: [line("i1", 5, 185, 20, "Fibre")] },
      { supplierId: "s1", supplierName: "A", warehouseId: "w1", items: [line("i1", 5, 201, 20, "Fibre")] },
    );
    expect(changes).toEqual([
      { field: "line.unitPrice", item: "Fibre", from: "£1.85", to: "£2.01", label: "Fibre — Unit price: £1.85 → £2.01" },
    ]);
  });

  it("records a quantity change", () => {
    const changes = diffProcurementChanges(
      { supplierId: "s1", supplierName: "A", warehouseId: "w1", items: [line("i1", 5, 185, 20, "Fibre")] },
      { supplierId: "s1", supplierName: "A", warehouseId: "w1", items: [line("i1", 10, 185, 20, "Fibre")] },
    );
    expect(changes).toEqual([{ field: "line.quantity", item: "Fibre", from: 5, to: 10, label: "Fibre — Quantity: 5 → 10" }]);
  });

  it("records a VAT-rate change with a percent label", () => {
    const changes = diffProcurementChanges(
      { supplierId: "s1", supplierName: "A", warehouseId: "w1", items: [line("i1", 5, 185, 20, "Fibre")] },
      { supplierId: "s1", supplierName: "A", warehouseId: "w1", items: [line("i1", 5, 185, 0, "Fibre")] },
    );
    expect(changes).toEqual([{ field: "line.vatRate", item: "Fibre", from: "20%", to: "0%", label: "Fibre — VAT: 20% → 0%" }]);
  });

  it("records multiple changed fields on the same line", () => {
    const changes = diffProcurementChanges(
      { supplierId: "s1", supplierName: "A", warehouseId: "w1", items: [line("i1", 5, 185, 20, "Fibre")] },
      { supplierId: "s1", supplierName: "A", warehouseId: "w1", items: [line("i1", 8, 150, 0, "Fibre")] },
    );
    expect(changes).toEqual([
      { field: "line.quantity", item: "Fibre", from: 5, to: 8, label: "Fibre — Quantity: 5 → 8" },
      { field: "line.unitPrice", item: "Fibre", from: "£1.85", to: "£1.50", label: "Fibre — Unit price: £1.85 → £1.50" },
      { field: "line.vatRate", item: "Fibre", from: "20%", to: "0%", label: "Fibre — VAT: 20% → 0%" },
    ]);
  });

  it("records an added line with a readable summary label", () => {
    const changes = diffProcurementChanges(
      { supplierId: "s1", supplierName: "A", warehouseId: "w1", items: [line("i1", 5, 185, 20, "Fibre")] },
      { supplierId: "s1", supplierName: "A", warehouseId: "w1", items: [line("i1", 5, 185, 20, "Fibre"), line("i2", 2, 6800, 20, "Connector")] },
    );
    expect(changes).toEqual([
      { field: "line.added", item: "Connector", from: null, to: "2 × £68.00 (VAT 20%)", label: "Line added: Connector — 2 × £68.00 (VAT 20%)" },
    ]);
  });

  it("records a removed line with a readable summary label", () => {
    const changes = diffProcurementChanges(
      { supplierId: "s1", supplierName: "A", warehouseId: "w1", items: [line("i1", 5, 185, 20, "Fibre"), line("i2", 2, 6800, 20, "Connector")] },
      { supplierId: "s1", supplierName: "A", warehouseId: "w1", items: [line("i1", 5, 185, 20, "Fibre")] },
    );
    expect(changes).toEqual([
      { field: "line.removed", item: "Connector", from: "2 × £68.00 (VAT 20%)", to: null, label: "Line removed: Connector — 2 × £68.00 (VAT 20%)" },
    ]);
  });
});

describe("diffProcurementChanges — when items are not part of the update", () => {
  it("skips line diffing entirely when incoming.items is undefined (header-only patch)", () => {
    const changes = diffProcurementChanges(
      { supplierId: "s1", supplierName: "Alpha", warehouseId: "w1", items: [line("i1", 5, 185, 20, "Fibre")] },
      { supplierId: "s2", supplierName: "Beta", warehouseId: "w1", items: undefined },
    );
    expect(changes).toEqual([{ field: "supplier", from: "Alpha", to: "Beta", label: "Supplier: Alpha → Beta" }]);
  });
});
