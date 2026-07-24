import { describe, expect, it } from "vitest";

import {
  approveVanStockRequestSchema,
  closeShortSchema,
  createVanStockRequestSchema,
  fulfilVanStockRequestSchema,
  walkInSchema,
} from "./van-stock-request.validation.js";

const oid = "a".repeat(24);
const line = { irmItemId: oid, itemName: "Cable Ties", qty: 100 };

describe("createVanStockRequestSchema", () => {
  it("accepts a restock with a preferred (collection) warehouse", () => {
    const r = createVanStockRequestSchema.safeParse({ type: "restock", reason: "van low", preferredWarehouseId: oid, lines: [line] });
    expect(r.success).toBe(true);
  });
  it("REQUIRES the preferred warehouse on a restock (it routes the request)", () => {
    const r = createVanStockRequestSchema.safeParse({ type: "restock", reason: "van low", lines: [line] });
    expect(r.success).toBe(false);
  });
  it("rejects a restock carrying a final warehouseId", () => {
    const r = createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", preferredWarehouseId: oid, warehouseId: oid, lines: [line] });
    expect(r.success).toBe(false);
  });
  it("requires warehouseId on a return and rejects preferredWarehouseId", () => {
    expect(createVanStockRequestSchema.safeParse({ type: "return", reason: "excess", lines: [line] }).success).toBe(false);
    expect(createVanStockRequestSchema.safeParse({ type: "return", reason: "excess", warehouseId: oid, lines: [line] }).success).toBe(true);
    expect(createVanStockRequestSchema.safeParse({ type: "return", reason: "excess", warehouseId: oid, preferredWarehouseId: oid, lines: [line] }).success).toBe(false);
  });
  it("rejects duplicate items across lines", () => {
    const r = createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", preferredWarehouseId: oid, lines: [line, { ...line, qty: 5 }] });
    expect(r.success).toBe(false);
  });
  it("defaults priority to normal and rejects unknown priorities", () => {
    const ok = createVanStockRequestSchema.parse({ type: "restock", reason: "x", preferredWarehouseId: oid, lines: [line] });
    expect(ok.priority).toBe("normal");
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", preferredWarehouseId: oid, priority: "asap", lines: [line] }).success).toBe(false);
  });
  it("rejects qty < 1 and non-integers", () => {
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", preferredWarehouseId: oid, lines: [{ ...line, qty: 0 }] }).success).toBe(false);
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", preferredWarehouseId: oid, lines: [{ ...line, qty: 1.5 }] }).success).toBe(false);
  });
});

describe("approveVanStockRequestSchema", () => {
  it("requires the final warehouse", () => {
    expect(approveVanStockRequestSchema.safeParse({}).success).toBe(false);
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid }).success).toBe(true);
  });
  it("accepts per-line trims with qty ≥ 1", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 60 }] }).success).toBe(true);
  });
  it("accepts approvedQty 0 (exclude a line)", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 0 }] }).success).toBe(true);
  });
  it("rejects a negative approvedQty", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: -1 }] }).success).toBe(false);
  });
  it("accepts an optional per-line sourceWarehouseId", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 2, sourceWarehouseId: oid }] }).success).toBe(true);
  });
  it("rejects a malformed sourceWarehouseId", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 2, sourceWarehouseId: "nope" }] }).success).toBe(false);
  });
});

describe("fulfilVanStockRequestSchema", () => {
  it("requires photo + reason on damaged entries", () => {
    const good = { lineId: oid, qty: 5, condition: "good", scannedCode: "IRM-0002" };
    const damagedBad = { lineId: oid, qty: 5, condition: "damaged", scannedCode: "IRM-0002" };
    const damagedOk = { ...damagedBad, damagePhotoUrl: "https://res.cloudinary.com/x/d.jpg", damageReason: "crushed" };
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [good] }).success).toBe(true);
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [damagedBad] }).success).toBe(false);
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [damagedOk] }).success).toBe(true);
  });
  // The issuing warehouse (the tab) is required — the service uses it to enforce a line is only posted
  // out of the warehouse it's sourced to (even for an admin).
  it("requires a warehouseId", () => {
    expect(fulfilVanStockRequestSchema.safeParse({ entries: [{ lineId: oid, qty: 1, condition: "good", scannedCode: "IRM-0002" }] }).success).toBe(false);
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: "nope", entries: [{ lineId: oid, qty: 1, condition: "good", scannedCode: "IRM-0002" }] }).success).toBe(false);
  });
  it("rejects an empty posting", () => {
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [] }).success).toBe(false);
  });
  // Scan-only posting (mirrors Goods Management): an entry with no scannedCode is stock nobody read off
  // the item, so the API must refuse it — the UI having no manual-add button is not the enforcement.
  it("rejects an entry with no scannedCode", () => {
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [{ lineId: oid, qty: 1, condition: "good" }] }).success).toBe(false);
  });
  it("rejects a blank/whitespace scannedCode", () => {
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [{ lineId: oid, qty: 1, condition: "good", scannedCode: "   " }] }).success).toBe(false);
  });
  // An item with no printed barcode is still scannable by its IRM code (lookup resolves code|barcode|sku).
  it("accepts an IRM code as the scanned value", () => {
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [{ lineId: oid, qty: 1, condition: "good", scannedCode: "IRM-0002" }] }).success).toBe(true);
  });
});

describe("closeShortSchema", () => {
  it("requires a note AND the warehouseId being closed short from", () => {
    expect(closeShortSchema.safeParse({}).success).toBe(false);
    expect(closeShortSchema.safeParse({ warehouseId: oid, note: "supplier discontinued" }).success).toBe(true);
    // note without warehouseId is rejected — the service uses warehouseId to scope the write-off to one tab.
    expect(closeShortSchema.safeParse({ note: "supplier discontinued" }).success).toBe(false);
    expect(closeShortSchema.safeParse({ warehouseId: "nope", note: "x" }).success).toBe(false);
  });
});

describe("walkInSchema", () => {
  it("requires engineer + warehouse + lines", () => {
    expect(walkInSchema.safeParse({ engineerId: oid, warehouseId: oid, reason: "counter", lines: [line] }).success).toBe(true);
    expect(walkInSchema.safeParse({ engineerId: oid, reason: "counter", lines: [line] }).success).toBe(false);
  });
  it("rejects duplicate items across lines", () => {
    expect(walkInSchema.safeParse({ engineerId: oid, warehouseId: oid, reason: "counter", lines: [line, { ...line, qty: 5 }] }).success).toBe(false);
  });
});
