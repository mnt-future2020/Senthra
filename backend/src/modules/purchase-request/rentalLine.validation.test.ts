import { describe, expect, it } from "vitest";

import {
  createPurchaseRequestSchema,
  rentalLineSchema,
} from "./purchase-request.validation.js";

const OID = "6a1d7f5bfa7d25704f02b963";
const line = {
  rentalItemId: OID,
  quantity: 1,
  hireStartDate: "2026-09-01",
  hireEndDate: "2026-10-01",
  unitPricePence: 15000,
};

describe("rentalLineSchema — shared rules mirror the IRM line", () => {
  it("accepts a well-formed line", () => {
    expect(rentalLineSchema.safeParse(line).success).toBe(true);
  });

  it("refuses quantity zero", () => {
    expect(rentalLineSchema.safeParse({ ...line, quantity: 0 }).success).toBe(false);
  });

  it("refuses a negative unit price but accepts zero (a free loan is a real case)", () => {
    expect(rentalLineSchema.safeParse({ ...line, unitPricePence: -1 }).success).toBe(false);
    expect(rentalLineSchema.safeParse({ ...line, unitPricePence: 0 }).success).toBe(true);
  });

  it("refuses VAT outside 0–100", () => {
    expect(rentalLineSchema.safeParse({ ...line, vatRate: 101 }).success).toBe(false);
    expect(rentalLineSchema.safeParse({ ...line, vatRate: -1 }).success).toBe(false);
  });

  it("refuses a line total beyond the safe-integer range", () => {
    expect(
      rentalLineSchema.safeParse({ ...line, quantity: 10_000_000, unitPricePence: 1_000_000_000 }).success,
    ).toBe(false);
  });
});

describe("rentalLineSchema — the hire period", () => {
  it("refuses an end date before or equal to the start", () => {
    expect(rentalLineSchema.safeParse({ ...line, hireEndDate: "2026-08-01" }).success).toBe(false);
    expect(rentalLineSchema.safeParse({ ...line, hireEndDate: line.hireStartDate }).success).toBe(false);
  });

  // Normalisation. Without it the DB's compound unique index could be sidestepped by sending the
  // same calendar day with a time on it.
  it("normalises both dates to UTC midnight", () => {
    const r = rentalLineSchema.parse({
      ...line,
      hireStartDate: "2026-09-01T09:30:00Z",
      hireEndDate: "2026-10-01T18:00:00Z",
    });
    expect(r.hireStartDate.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(r.hireEndDate.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("refuses a same-day hire even when the times differ", () => {
    expect(
      rentalLineSchema.safeParse({
        ...line,
        hireStartDate: "2026-09-01T08:00:00Z",
        hireEndDate: "2026-09-01T18:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("refuses an unparseable date", () => {
    expect(rentalLineSchema.safeParse({ ...line, hireEndDate: "next tuesday" }).success).toBe(false);
  });
});

describe("rentalLineSchema — the reminder lead", () => {
  it("bounds the lead to 0–365", () => {
    expect(rentalLineSchema.safeParse({ ...line, notifyDaysBefore: -1 }).success).toBe(false);
    expect(rentalLineSchema.safeParse({ ...line, notifyDaysBefore: 366 }).success).toBe(false);
    expect(rentalLineSchema.safeParse({ ...line, notifyDaysBefore: 0 }).success).toBe(true);
  });

  // A lead LONGER than the hire is legitimate — it is clamped to the start date when stored, not
  // refused. Refusing it would make every hire shorter than four days unsavable, because the lead
  // defaults to 3.
  it("accepts a reminder lead longer than the hire itself", () => {
    const twoDay = { ...line, hireStartDate: "2026-09-01", hireEndDate: "2026-09-03" };
    expect(rentalLineSchema.safeParse({ ...twoDay, notifyDaysBefore: 5 }).success).toBe(true);
  });
});

describe("rentalLineSchema — the delivery address", () => {
  it("refuses an address over 300 characters", () => {
    expect(rentalLineSchema.safeParse({ ...line, deliveryAddress: "x".repeat(301) }).success).toBe(false);
  });

  it("turns a blank address into null rather than an empty string", () => {
    expect(rentalLineSchema.parse({ ...line, deliveryAddress: "   " }).deliveryAddress).toBeNull();
  });

  it("keeps a multiline address, matching the PO delivery-address shape", () => {
    expect(rentalLineSchema.parse({ ...line, deliveryAddress: "Unit 4\nLeeds" }).deliveryAddress).toBe("Unit 4\nLeeds");
  });
});

describe("rentalLineSchema — server-computed fields", () => {
  // Accepting either is how a stored total stops matching its own quantity x price.
  it("ignores a client-supplied line total and notify date", () => {
    const r = rentalLineSchema.parse({ ...line, lineTotalPence: 999, notifyOnDate: "2026-01-01" }) as Record<
      string,
      unknown
    >;
    expect(r.lineTotalPence).toBeUndefined();
    expect(r.notifyOnDate).toBeUndefined();
  });
});

describe("the request body — rental lines alongside items", () => {
  const header = {
    supplierId: OID,
    warehouseId: OID,
    requiredByDate: "2026-09-01",
  };
  const irmLine = { irmItemId: OID, quantity: 1, unitPricePence: 100 };

  it("accepts a request with only rental lines", () => {
    expect(createPurchaseRequestSchema.safeParse({ ...header, rentalItems: [line] }).success).toBe(true);
  });

  it("accepts a request with only IRM lines, exactly as before", () => {
    expect(createPurchaseRequestSchema.safeParse({ ...header, items: [irmLine] }).success).toBe(true);
  });

  it("accepts a request carrying both kinds", () => {
    expect(
      createPurchaseRequestSchema.safeParse({ ...header, items: [irmLine], rentalItems: [line] }).success,
    ).toBe(true);
  });

  it("refuses a request with no lines of either kind", () => {
    expect(createPurchaseRequestSchema.safeParse({ ...header, items: [], rentalItems: [] }).success).toBe(false);
    expect(createPurchaseRequestSchema.safeParse({ ...header }).success).toBe(false);
  });

  // The same triple the DB's compound unique index refuses — checked here for a readable message.
  it("refuses the same item, period and address twice", () => {
    expect(createPurchaseRequestSchema.safeParse({ ...header, rentalItems: [line, line] }).success).toBe(false);
  });

  it("allows the same item twice with different periods", () => {
    const second = { ...line, hireEndDate: "2026-09-08" };
    expect(createPurchaseRequestSchema.safeParse({ ...header, rentalItems: [line, second] }).success).toBe(true);
  });

  it("allows the same item and period to two different addresses", () => {
    const a = { ...line, deliveryAddress: "Site A" };
    const b = { ...line, deliveryAddress: "Site B" };
    expect(createPurchaseRequestSchema.safeParse({ ...header, rentalItems: [a, b] }).success).toBe(true);
  });

  // Price is what a hire COSTS, not what it is: two lines differing only in basis describe one
  // delivery and one collection, and would bill the same kit twice. They also collide on the unique
  // index, and share a key in the audit diff — which pairs a line's before with its after by exactly
  // this composite, so two of them make the change log report edits nobody made.
  it("refuses a duplicate whose only difference is the pricing basis or the price", () => {
    const perDay = { ...line, ratePeriod: "day", ratePence: 100 };
    const perMonth = { ...line, ratePeriod: "month", ratePence: 100 };
    expect(createPurchaseRequestSchema.safeParse({ ...header, rentalItems: [perDay, perMonth] }).success).toBe(false);
    expect(
      createPurchaseRequestSchema.safeParse({ ...header, rentalItems: [line, { ...line, unitPricePence: 99 }] }).success,
    ).toBe(false);
  });

  // Nor the return leg — the mode is deliberately outside the key (see the schema): including it
  // would let the same hire be added twice by changing only where it goes back.
  it("refuses a duplicate whose only difference is the return mode", () => {
    const a = { ...line, returnMode: "delivery" };
    const b = { ...line, returnMode: "warehouse" };
    expect(createPurchaseRequestSchema.safeParse({ ...header, rentalItems: [a, b] }).success).toBe(false);
  });

  // The mistake is nearly always "but I DID change something", so the message names what it ignores.
  it("says which fields do not make a line separate", () => {
    const parsed = createPurchaseRequestSchema.safeParse({ ...header, rentalItems: [line, line] });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/pricing basis, rate and return details/i);
  });

  // `""` and a missing address are the same address, so a pair of them is still a duplicate — the DB's
  // index would treat null and "" as two different values, and only this check stands between them.
  it("treats an empty address and no address as the same address", () => {
    const blank = { ...line, deliveryAddress: "" };
    expect(createPurchaseRequestSchema.safeParse({ ...header, rentalItems: [line, blank] }).success).toBe(false);
  });

  // Trimmed on the way in, so spaces cannot smuggle a duplicate past the check either.
  it("ignores surrounding whitespace in the address", () => {
    const a = { ...line, deliveryAddress: "Site A" };
    const b = { ...line, deliveryAddress: "  Site A  " };
    expect(createPurchaseRequestSchema.safeParse({ ...header, rentalItems: [a, b] }).success).toBe(false);
  });
});


// A hire is a round trip. "Other" is the only mode with nothing to fall back to, so it is the only
// one that can be stored as an empty promise — hence the one rule here.
describe("rentalLineSchema — where the hire goes back", () => {
  it("defaults to the delivery address when the client says nothing", () => {
    const parsed = rentalLineSchema.parse(line);
    expect(parsed.returnMode).toBeUndefined(); // absent → the service stores "delivery"
  });

  it("accepts each mode", () => {
    for (const mode of ["delivery", "warehouse"]) {
      expect(rentalLineSchema.safeParse({ ...line, returnMode: mode }).success).toBe(true);
    }
    expect(rentalLineSchema.safeParse({ ...line, returnMode: "other", returnAddress: "Yard 7" }).success).toBe(true);
  });

  it("refuses a mode it does not know", () => {
    expect(rentalLineSchema.safeParse({ ...line, returnMode: "somewhere" }).success).toBe(false);
  });

  it("refuses OTHER with no address — the one mode with no fallback", () => {
    const r = rentalLineSchema.safeParse({ ...line, returnMode: "other" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/address the hire is collected from/i);
  });

  it("treats a blank address as absent, so whitespace cannot satisfy the rule", () => {
    expect(rentalLineSchema.safeParse({ ...line, returnMode: "other", returnAddress: "   " }).success).toBe(false);
  });

  it("bounds the return address like the delivery one", () => {
    expect(rentalLineSchema.safeParse({ ...line, returnMode: "other", returnAddress: "x".repeat(301) }).success).toBe(false);
  });
});


// The rate is an input BASIS; the money stays `unitPricePence`. The schema's job is to refuse a
// basis that cannot produce a figure — the service does the arithmetic.
describe("rentalLineSchema — the pricing basis", () => {
  it("defaults to the whole-hire figure when the client says nothing", () => {
    expect(rentalLineSchema.parse(line).ratePeriod).toBeUndefined();
  });

  it("accepts every basis with a rate", () => {
    for (const p of ["day", "week", "month"]) {
      expect(rentalLineSchema.safeParse({ ...line, ratePeriod: p, ratePence: 5500 }).success).toBe(true);
    }
  });

  it("refuses a basis it does not know", () => {
    expect(rentalLineSchema.safeParse({ ...line, ratePeriod: "fortnight", ratePence: 100 }).success).toBe(false);
  });

  it("refuses a rate basis with no rate — the price could not be arrived at", () => {
    const r = rentalLineSchema.safeParse({ ...line, ratePeriod: "day" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/rate for the chosen pricing basis/i);
  });

  it("still accepts the total basis with no rate", () => {
    expect(rentalLineSchema.safeParse({ ...line, ratePeriod: "total" }).success).toBe(true);
  });

  // A free loan is a real case, exactly as it is for the price itself.
  it("accepts a zero rate but not a negative or fractional one", () => {
    expect(rentalLineSchema.safeParse({ ...line, ratePeriod: "day", ratePence: 0 }).success).toBe(true);
    expect(rentalLineSchema.safeParse({ ...line, ratePeriod: "day", ratePence: -1 }).success).toBe(false);
    expect(rentalLineSchema.safeParse({ ...line, ratePeriod: "day", ratePence: 12.5 }).success).toBe(false);
  });
});
