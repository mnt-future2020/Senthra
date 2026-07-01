// movement.test.ts — unified Stock Ledger DTO mappers, label map, and cursor codec.
import { describe, it, expect } from "vitest";
import {
  fromInventoryTxn,
  fromEngineerTxn,
  fromEngineerCustomerTxn,
  fromDamagedTxn,
  labelFor,
  encodeCursor,
  decodeCursor,
} from "./movement.js";
import { movementFiltersFrom } from "./movement.service.js";

const D = new Date("2026-06-29T00:00:00Z");

describe("fromInventoryTxn", () => {
  it("maps a transfer_out warehouse leg (negative delta)", () => {
    const m = fromInventoryTxn({
      id: "t1", createdAt: D, type: "transfer_out", quantityDelta: -5, balanceAfter: 20,
      sourceCode: "TRF-0001", sourceType: "stock_transfer", sourceId: "s1", createdBy: "a@b.com",
      irmItemId: "i1", warehouseId: "w1",
      irmItem: { code: "IRM-0001", name: "Cable", sku: "SKU1" }, warehouse: { name: "London Hub" },
    });
    expect(m.id).toBe("inv:t1");
    expect(m.ownership).toBe("company");
    expect(m.locationType).toBe("warehouse");
    expect(m.locationLabel).toBe("London Hub");
    expect(m.quantityDelta).toBe(-5);
    expect(m.balanceAfter).toBe(20);
    expect(m.fromLabel).toBe("London Hub");
    expect(m.toLabel).toBeNull();
    expect(m.reference).toBe("TRF-0001");
    expect(m.label).toBe("Transfer Out");
  });
});

describe("fromEngineerTxn", () => {
  it("maps an engineer-van company leg with resolved name", () => {
    const m = fromEngineerTxn({
      id: "e1", createdAt: D, type: "transfer_in", quantityDelta: 3, balanceAfter: 3,
      sourceCode: "ENG-0001", sourceType: "engineer_transfer", sourceId: "s2", createdBy: null,
      irmItemId: "i1", engineerId: "eng1", irmItem: { code: "IRM-0001", name: "Cable" },
    }, "Sam Lee");
    expect(m.id).toBe("eng:e1");
    expect(m.locationType).toBe("engineer");
    expect(m.locationLabel).toBe("Eng: Sam Lee");
    expect(m.engineerId).toBe("eng1");
    expect(m.toLabel).toBe("Eng: Sam Lee");
    expect(m.label).toBe("Transfer In");
  });
});

describe("fromEngineerCustomerTxn", () => {
  it("maps a customer consignment leg from resolved meta", () => {
    const m = fromEngineerCustomerTxn({
      id: "c1", createdAt: D, type: "job_issue", quantityDelta: 2, balanceAfter: 2,
      sourceCode: "GM-0001", sourceType: "goods_management", sourceId: "s3", createdBy: "wm@x.com",
      engineerId: "eng1", customerStockEntryId: "cse1",
    }, { engineerName: "Sam Lee", itemName: "Router", sku: "RT-1", customerId: "cust1", customerName: "Acme" });
    expect(m.ownership).toBe("customer");
    expect(m.itemKind).toBe("customer_stock");
    expect(m.itemName).toBe("Router");
    expect(m.customerName).toBe("Acme");
    expect(m.locationLabel).toBe("Eng: Sam Lee");
    expect(m.label).toBe("Job Issue");
  });
});

describe("fromDamagedTxn", () => {
  it("derives write_off for a positive delta", () => {
    const m = fromDamagedTxn({
      id: "d1", createdAt: D, quantityDelta: 4, balanceAfter: 4, ownerType: "company",
      sourceCode: "GM-0002", sourceType: "goods_management_return", sourceId: "s4", createdBy: null,
      warehouseId: "w1", irmItemId: "i1", customerId: null,
    }, { itemCode: "IRM-0001", itemName: "Cable", warehouseName: "London Hub" });
    expect(m.type).toBe("write_off");
    expect(m.label).toBe("Marked Damaged");
    expect(m.locationType).toBe("damaged");
    expect(m.ownership).toBe("company");
  });
  it("derives restore for a negative delta", () => {
    const m = fromDamagedTxn({
      id: "d2", createdAt: D, quantityDelta: -2, balanceAfter: 0, ownerType: "customer",
      sourceCode: null, sourceType: "damaged_restore", sourceId: "s5", createdBy: null,
      warehouseId: "w1", customerStockEntryId: "cse1", customerId: "cust1",
    }, { itemCode: "", itemName: "Router", warehouseName: "London Hub" });
    expect(m.type).toBe("restore");
    expect(m.label).toBe("Restored from Damaged");
    expect(m.ownership).toBe("customer");
  });
});

describe("labelFor", () => {
  it("humanises known and unknown types", () => {
    expect(labelFor("goods_in")).toBe("Goods In");
    expect(labelFor("job_consume")).toBe("Consumed on Job");
    expect(labelFor("some_new_verb")).toBe("Some New Verb");
  });
});

describe("cursor codec", () => {
  it("round-trips a cursor", () => {
    const c = { t: 1782795825101, id: "6a41fd523dac14de58a4e113" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it("returns null for empty/garbage", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
  });
  it("rejects a cursor whose id is not a 24-hex ObjectId (would 500 the keyset)", () => {
    const tampered = Buffer.from("123:not-an-objectid", "utf8").toString("base64url");
    expect(decodeCursor(tampered)).toBeNull();
  });
});

describe("movementFiltersFrom date bounds", () => {
  it("treats a date-only `to` as the inclusive end of the day", () => {
    expect(movementFiltersFrom({ dateTo: "2026-06-30" }).dateTo?.toISOString()).toBe("2026-06-30T23:59:59.999Z");
  });
  it("keeps a date-only `from` at the start of the day", () => {
    expect(movementFiltersFrom({ dateFrom: "2026-06-30" }).dateFrom?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
  });
  it("honours a full datetime `to` verbatim", () => {
    expect(movementFiltersFrom({ dateTo: "2026-06-30T08:15:00.000Z" }).dateTo?.toISOString()).toBe("2026-06-30T08:15:00.000Z");
  });
  it("drops junk date values", () => {
    expect(movementFiltersFrom({ dateTo: "not-a-date" }).dateTo).toBeUndefined();
  });
});
