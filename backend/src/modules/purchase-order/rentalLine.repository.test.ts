import { beforeEach, describe, expect, it, vi } from "vitest";

// A faithful-enough transaction client for the WRITE paths: every model the order writers touch is
// provided; touching any other model — an inventory balance, a stock transaction, a goods receipt —
// throws. That is the assertion behind this file: a hire raised on an order becomes a
// PurchaseOrderRentalLine row and nothing else.
const calls: { model: string; op: string; args: unknown }[] = [];
const model = (name: string, ops: Record<string, (args: unknown) => unknown>) =>
  new Proxy(
    {},
    {
      get(_t, op: string) {
        const fn = ops[op];
        if (!fn) throw new Error(`${name}.${op} is not part of the order writers' contract`);
        return (args: unknown) => {
          calls.push({ model: name, op, args });
          return Promise.resolve(fn(args));
        };
      },
    },
  );
const tx = new Proxy(
  {},
  {
    get(_t, name: string) {
      switch (name) {
        case "counter":
          return model(name, { update: () => ({ seq: 7 }) });
        case "purchaseOrder":
          return model(name, {
            create: (a) => ({ id: "po1", ...(a as { data: object }).data }),
            update: () => ({}),
            findUniqueOrThrow: () => ({ id: "po1" }),
            findMany: () => [{ id: "po1" }],
          });
        case "purchaseOrderItem":
          return model(name, { createMany: () => ({ count: 1 }), deleteMany: () => ({ count: 1 }) });
        case "purchaseOrderRentalLine":
          return model(name, { createMany: () => ({ count: 1 }), deleteMany: () => ({ count: 1 }) });
        default:
          throw new Error(`The order writers must never touch ${name}`);
      }
    },
  },
);

vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    counter: {
      update: () => Promise.resolve({ seq: 7 }),
      findUnique: () => Promise.resolve({ key: "PO", seq: 7 }),
    },
  },
  withTransaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  isWriteConflict: () => false,
}));

import { createManyWithCodes, createWithCode, replaceItemsAndTotals, type PoRentalLineRow } from "./purchase-order.repository.js";

const RNT_ID = "6a1d7f5bfa7d25704f02b963";
const hire: PoRentalLineRow = {
  rentalItemId: RNT_ID,
  itemName: "Fibre Tester",
  baseUnit: "Each",
  quantity: 2,
  hireStartDate: new Date("2026-09-01T00:00:00Z"),
  hireEndDate: new Date("2026-10-01T00:00:00Z"),
  notifyDaysBefore: 3,
  deliveryAddress: null,
  ratePeriod: "total",
  ratePence: null,
  priceOverridden: false,
  returnMode: "delivery",
  returnAddress: null,
  unitPricePence: 15000,
  vatRate: 20,
  lineTotalPence: 30000,
  sortOrder: 0,
  notes: null,
  hireStatus: "awaiting_delivery",
  notifyOnDate: new Date("2026-09-28T00:00:00Z"),
};
const item = {
  irmItemId: "c".repeat(24),
  itemName: "CAT6",
  sku: "C6",
  baseUnit: "Each",
  quantity: 5,
  unitPricePence: 1000,
  vatRate: 20,
  lineTotalPence: 5000,
  sortOrder: 0,
  notes: null,
};
const header = { supplierId: "a".repeat(24), warehouseId: "b".repeat(24), status: "draft" } as never;
const totals = { subtotalPence: 35000, vatPence: 7000, grandTotalPence: 42000 };

const writesTo = (m: string, op: string) => calls.filter((c) => c.model === m && c.op === op);

beforeEach(() => {
  calls.length = 0;
});

describe("createManyWithCodes — a group may carry hires as well as, or instead of, items", () => {
  it("writes the hires as rental-line rows on the order they belong to, and nothing else", async () => {
    await createManyWithCodes([{ header, lines: [item], rentalLines: [hire] }]);
    const [rental] = writesTo("purchaseOrderRentalLine", "createMany");
    expect(rental).toBeDefined();
    expect((rental!.args as { data: unknown[] }).data).toEqual([{ purchaseOrderId: "po1", ...hire }]);
    expect(writesTo("purchaseOrderItem", "createMany")).toHaveLength(1);
    // Every write went to an order table. The tx proxy would have thrown on anything else.
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(["counter", "purchaseOrder", "purchaseOrderItem", "purchaseOrderRentalLine"]));
  });

  it("a hire-only group writes no item rows at all", async () => {
    await createManyWithCodes([{ header, lines: [], rentalLines: [hire] }]);
    expect(writesTo("purchaseOrderItem", "createMany")).toHaveLength(0);
    expect(writesTo("purchaseOrderRentalLine", "createMany")).toHaveLength(1);
  });

  it("a group with no hires writes no rental rows — the pre-existing shape is untouched", async () => {
    await createManyWithCodes([{ header, lines: [item] }]);
    expect(writesTo("purchaseOrderRentalLine", "createMany")).toHaveLength(0);
  });
});

describe("createWithCode — the single-order create takes hires the same way", () => {
  it("writes the rental rows against the new order", async () => {
    await createWithCode(header, [item], [hire]);
    expect((writesTo("purchaseOrderRentalLine", "createMany")[0]!.args as { data: unknown[] }).data).toEqual([
      { purchaseOrderId: "po1", ...hire },
    ]);
  });

  it("defaults to no hires, so every existing caller is unchanged", async () => {
    await createWithCode(header, [item]);
    expect(writesTo("purchaseOrderRentalLine", "createMany")).toHaveLength(0);
  });
});

describe("replaceItemsAndTotals — each kind of line is replaced only when it is sent", () => {
  it("replaces the hires when given, leaving the items alone when they are not", async () => {
    await replaceItemsAndTotals("po1", undefined, totals, {}, [hire]);
    expect(writesTo("purchaseOrderRentalLine", "deleteMany")).toHaveLength(1);
    expect(writesTo("purchaseOrderRentalLine", "createMany")).toHaveLength(1);
    expect(writesTo("purchaseOrderItem", "deleteMany")).toHaveLength(0);
    expect(writesTo("purchaseOrderItem", "createMany")).toHaveLength(0);
    // The header roll-up is always written.
    expect((writesTo("purchaseOrder", "update")[0]!.args as { data: object }).data).toMatchObject(totals);
  });

  it("replaces the items when given, leaving the hires exactly as stored when they are not", async () => {
    await replaceItemsAndTotals("po1", [item], totals, {});
    expect(writesTo("purchaseOrderItem", "deleteMany")).toHaveLength(1);
    expect(writesTo("purchaseOrderItem", "createMany")).toHaveLength(1);
    expect(writesTo("purchaseOrderRentalLine", "deleteMany")).toHaveLength(0);
    expect(writesTo("purchaseOrderRentalLine", "createMany")).toHaveLength(0);
  });

  it("an empty hire array clears the hires — that is a replacement, not an omission", async () => {
    await replaceItemsAndTotals("po1", [item], totals, {}, []);
    expect(writesTo("purchaseOrderRentalLine", "deleteMany")).toHaveLength(1);
    expect(writesTo("purchaseOrderRentalLine", "createMany")).toHaveLength(0);
  });
});
