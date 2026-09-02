import { describe, expect, it } from "vitest";

import {
  DUPLICATE_RENTAL_LINE_MESSAGE,
  hasAnyLine,
  rentalItemsField,
  rentalLineSchema,
  splitRentalItemsField,
  splitRentalLineSchema,
} from "./rentalLine.validation.js";
import { rentalLineSchema as prfRentalLineSchema } from "#modules/purchase-request/purchase-request.validation.js";

const RNT_ID = "6a1d7f5bfa7d25704f02b963";
const WH_ID = "b".repeat(24);
const WH_ID_2 = "e".repeat(24);

const line = {
  rentalItemId: RNT_ID,
  quantity: 1,
  hireStartDate: "2026-09-01",
  hireEndDate: "2026-10-01",
  unitPricePence: 15000,
};
const split = { ...line, warehouseId: WH_ID };

// The request and the order validate a hire through ONE schema object — not two copies that happen
// to agree today. The PRF's export is the purchase-order module's, re-exported.
describe("one rental-line schema for both documents", () => {
  it("the purchase request re-exports the purchase-order module's schema, not a copy", () => {
    expect(prfRentalLineSchema).toBe(rentalLineSchema);
  });
});

describe("splitRentalLineSchema — the line plus its destination warehouse", () => {
  it("accepts a hire that names its warehouse", () => {
    expect(splitRentalLineSchema.safeParse(split).success).toBe(true);
  });

  it("refuses a hire with no warehouse, or a malformed one", () => {
    const { warehouseId: _drop, ...noWarehouse } = split;
    void _drop;
    expect(splitRentalLineSchema.safeParse(noWarehouse).success).toBe(false);
    expect(splitRentalLineSchema.safeParse({ ...split, warehouseId: "leeds" }).success).toBe(false);
  });

  // The whole reason the rules are applied through a function rather than inherited from
  // `.extend()`: every cross-field rule the request enforces has to hold on the order's line too.
  it("keeps every cross-field rule of the base line", () => {
    expect(splitRentalLineSchema.safeParse({ ...split, hireEndDate: "2026-09-01" }).success).toBe(false);
    expect(splitRentalLineSchema.safeParse({ ...split, hireEndDate: "2026-08-01" }).success).toBe(false);
    expect(splitRentalLineSchema.safeParse({ ...split, ratePeriod: "day" }).success).toBe(false);
    expect(splitRentalLineSchema.safeParse({ ...split, ratePeriod: "day", ratePence: 5500 }).success).toBe(true);
    expect(splitRentalLineSchema.safeParse({ ...split, returnMode: "other" }).success).toBe(false);
    expect(splitRentalLineSchema.safeParse({ ...split, returnMode: "other", returnAddress: "Unit 4" }).success).toBe(true);
    expect(
      splitRentalLineSchema.safeParse({ ...split, quantity: 10_000_000, unitPricePence: 1_000_000_000 }).success,
    ).toBe(false);
  });

  it("normalises the hire dates to calendar days, like the base line", () => {
    const r = splitRentalLineSchema.parse({ ...split, hireStartDate: "2026-09-01T09:30:00Z" });
    expect(r.hireStartDate.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("drops what the server computes — a client cannot file its own total, reminder date or hire state", () => {
    const r = splitRentalLineSchema.parse({
      ...split,
      lineTotalPence: 1,
      notifyOnDate: "2026-09-28",
      hireStatus: "on_hire",
      receivedQuantity: 5,
    }) as Record<string, unknown>;
    expect(r).not.toHaveProperty("lineTotalPence");
    expect(r).not.toHaveProperty("notifyOnDate");
    expect(r).not.toHaveProperty("hireStatus");
    expect(r).not.toHaveProperty("receivedQuantity");
  });
});

describe("splitRentalItemsField — identity is per warehouse", () => {
  it("refuses the same hire twice for the same warehouse", () => {
    const res = splitRentalItemsField.safeParse([split, { ...split, quantity: 2 }]);
    expect(res.success).toBe(false);
  });

  it("allows the same hire to two different warehouses — two orders", () => {
    expect(splitRentalItemsField.safeParse([split, { ...split, warehouseId: WH_ID_2 }]).success).toBe(true);
  });

  it("allows the same item to the same warehouse with a different period", () => {
    expect(splitRentalItemsField.safeParse([split, { ...split, hireEndDate: "2026-10-15" }]).success).toBe(true);
  });

  it("a different pricing basis does not make it a separate line", () => {
    expect(splitRentalItemsField.safeParse([split, { ...split, ratePeriod: "day", ratePence: 5500 }]).success).toBe(
      false,
    );
  });
});

describe("rentalItemsField — the order's edit uses the request's duplicate rule, word for word", () => {
  it("refuses an identical (item, period, address) twice, naming what does not count", () => {
    const res = rentalItemsField.safeParse([line, { ...line, ratePeriod: "week", ratePence: 30000 }]);
    expect(res.success).toBe(false);
    expect(res.success ? "" : res.error.issues[0]!.message).toBe(DUPLICATE_RENTAL_LINE_MESSAGE);
  });

  it("allows the same item to two addresses", () => {
    expect(rentalItemsField.safeParse([line, { ...line, deliveryAddress: "12 Site Road" }]).success).toBe(true);
  });
});

describe("hasAnyLine — a line of EITHER kind", () => {
  it("is false with no lines at all", () => {
    expect(hasAnyLine({})).toBe(false);
    expect(hasAnyLine({ items: [], rentalItems: [] })).toBe(false);
  });

  it("is true with only hires, and with only items", () => {
    expect(hasAnyLine({ rentalItems: [line] })).toBe(true);
    expect(hasAnyLine({ items: [{}] })).toBe(true);
  });
});
