import { describe, expect, it, vi } from "vitest";

// The atomic guard that decides whether hired units may leave the warehouse, tested against a fake
// that reproduces MongoDB's ABSENT-FIELD semantics.
//
// This file exists because of a shipped bug. `issuedQuantity` was added to a table that already held
// 41 rows. It carries `@default(0)`, but a Prisma default is applied by the CLIENT on create — it is
// not a stored value, and `prisma db push` never writes one into rows that already exist. In MongoDB
// a range comparison does not match a document that lacks the field, so the guard's
// `{ issuedQuantity: { lte: n } }` matched nothing on every pre-existing hire, and the warehouse was
// told "those units are no longer available on this hire — stock changed" while sixty of them sat on
// the shelf.
//
// A stub that models a missing field as 0 would pass on the broken code and prove nothing. So the
// fake below distinguishes the three states Mongo distinguishes: a stored number, an explicit null,
// and an absent key.

vi.mock("../../lib/prisma.js", () => ({ prisma: {}, withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));

import { adjustHireIssuedQtyTx } from "./purchase-order.repository.js";

const LINE_ID = "a".repeat(24);

type Doc = Record<string, unknown>;

/** Does one document satisfy one Mongo-style condition? */
function matches(doc: Doc, where: Doc): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Doc[]).some((arm) => matches(doc, arm))) return false;
      continue;
    }
    // `$not` of a comparison matches a document the comparison did not match — INCLUDING one that
    // lacks the field entirely. That asymmetry with `lte` is the whole point of the guard under test.
    if (key === "NOT") {
      if (matches(doc, cond as Doc)) return false;
      continue;
    }
    const present = Object.hasOwn(doc, key);
    const value = doc[key];
    if (cond !== null && typeof cond === "object") {
      for (const [op, operand] of Object.entries(cond as Doc)) {
        // The whole point of this file: an absent field satisfies NO range comparison.
        if (op === "lte" && !(present && typeof value === "number" && value <= (operand as number))) return false;
        if (op === "gte" && !(present && typeof value === "number" && value >= (operand as number))) return false;
        if (op === "gt" && !(present && typeof value === "number" && value > (operand as number))) return false;
      }
      continue;
    }
    if (!present || value !== cond) return false;
  }
  return true;
}

/** A one-document stand-in for the collection, with `findUnique` + conditional `updateMany` + `$inc`. */
function fakeTx(doc: Doc | null) {
  const store = doc;
  return {
    store,
    purchaseOrderRentalLine: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        store && where.id === LINE_ID ? { ...store } : null,
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Doc; data: Doc }) => {
        if (!store || where.id !== LINE_ID) return { count: 0 };
        const { id: _id, ...conds } = where;
        if (!matches(store, conds)) return { count: 0 };
        for (const [field, op] of Object.entries(data)) {
          const inc = (op as { increment?: number }).increment;
          // $inc on a missing field creates it at the increment value — Mongo's own behaviour.
          if (typeof inc === "number") store[field] = ((store[field] as number | undefined) ?? 0) + inc;
        }
        return { count: 1 };
      }),
    },
  };
}

/** A hire with 3 delivered and none gone back — the shape that broke. */
const hire = (over: Doc = {}): Doc => ({ receivedQuantity: 3, returnedQuantity: 0, issuedQuantity: 0, ...over });

/** The same hire as it actually sits in a database written before the column existed. */
const legacyHire = (over: Doc = {}): Doc => {
  const d = hire(over);
  delete d.issuedQuantity;
  return d;
};

describe("adjustHireIssuedQtyTx — issuing hired units", () => {
  let tx: ReturnType<typeof fakeTx>;

  it("lends units when the hire has them", async () => {
    tx = fakeTx(hire());
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 2)).resolves.toBe(true);
    expect(tx.store!.issuedQuantity).toBe(2);
  });

  // THE REGRESSION. Absent must behave exactly like a stored 0.
  it("lends units on a hire row written before the column existed", async () => {
    tx = fakeTx(legacyHire());
    expect(Object.hasOwn(tx.store!, "issuedQuantity")).toBe(false);
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 2)).resolves.toBe(true);
    expect(tx.store!.issuedQuantity).toBe(2);
  });

  it("refuses more than the hire holds — stored or absent alike", async () => {
    tx = fakeTx(hire());
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 4)).resolves.toBe(false);
    tx = fakeTx(legacyHire());
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 4)).resolves.toBe(false);
    expect(Object.hasOwn(tx.store!, "issuedQuantity")).toBe(false); // refused ⇒ nothing written
  });

  it("counts units already gone back to the provider against what is lendable", async () => {
    tx = fakeTx(hire({ receivedQuantity: 3, returnedQuantity: 2 }));
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 2)).resolves.toBe(false);
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 1)).resolves.toBe(true);
  });

  it("refuses a hire that has nothing delivered yet, absent column included", async () => {
    tx = fakeTx(legacyHire({ receivedQuantity: 0 }));
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 1)).resolves.toBe(false);
  });

  it("lets the last unit go exactly once", async () => {
    tx = fakeTx(hire({ receivedQuantity: 1 }));
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 1)).resolves.toBe(true);
    // The second caller read "1 available" too; only one can win.
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 1)).resolves.toBe(false);
    expect(tx.store!.issuedQuantity).toBe(1);
  });
});

describe("adjustHireIssuedQtyTx — taking hired units back", () => {
  it("releases units back into the hire's pool", async () => {
    const tx = fakeTx(hire({ issuedQuantity: 2 }));
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, -2)).resolves.toBe(true);
    expect(tx.store!.issuedQuantity).toBe(0);
  });

  it("refuses to credit back more than went out", async () => {
    const tx = fakeTx(hire({ issuedQuantity: 1 }));
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, -2)).resolves.toBe(false);
  });

  // A return against a row with no stored count is a return of units that were never issued — the
  // absent field must NOT be read as "fine, go ahead" the way the issue arm treats it as zero.
  it("refuses a return on a row that never recorded an issue", async () => {
    const tx = fakeTx(legacyHire());
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, -1)).resolves.toBe(false);
  });
});

describe("adjustHireIssuedQtyTx — edges", () => {
  it("is a no-op for zero, without touching the row", async () => {
    const tx = fakeTx(hire());
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 0)).resolves.toBe(true);
    expect(tx.purchaseOrderRentalLine.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a hire that no longer exists", async () => {
    const tx = fakeTx(null);
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 1)).resolves.toBe(false);
  });

  it("refuses when a delivery lands between the read and the write", async () => {
    // The ceiling was computed from receivedQuantity 3; the row now says 5, so the guard's equality
    // arms no longer match and the write is invalidated rather than applied against stale arithmetic.
    const tx = fakeTx(hire());
    tx.purchaseOrderRentalLine.findUnique = vi.fn(async () => ({ receivedQuantity: 5, returnedQuantity: 0 })) as never;
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 1)).resolves.toBe(false);
  });
});

// ── Which hires a job may draw on ───────────────────────────────────────────────────────────────
//
// `findLiveHiresByRentalItems` shipped matching on `hireStatus: "on_hire"` alone. That is NOT what
// "live" means in this module: a hire's ORDER must still be live too, and on the real database 15 of
// 31 on_hire lines hung off a SOFT-DELETED purchase order. Every one was offered to the scan panel as
// collectable kit, inflating "available" by a third and resolving scans onto an order that the
// supplier-return path cannot even load — so the kit could be issued and then never settled.
//
// The badge, the on-hire list and the reminder sweep all compose `onHireWhere()`. This asserts the
// job path composes the SAME predicate rather than restating a weaker version of it — the drift the
// design's "ONE predicate, two readers" rule exists to prevent.
describe("findLiveHiresByRentalItems — the predicate it composes", () => {
  it("requires a live ORDER, not just an on_hire line", async () => {
    const seen: Record<string, unknown>[] = [];
    const { prisma } = await import("../../lib/prisma.js");
    (prisma as unknown as Record<string, unknown>).purchaseOrderRentalLine = {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => { seen.push(args.where); return []; }),
    };
    const { findLiveHiresByRentalItems } = await import("./purchase-order.repository.js");
    await findLiveHiresByRentalItems(["d".repeat(24)]);

    const where = seen[0]!;
    expect(where.hireStatus).toBe("on_hire");
    // The order guard: not cancelled, and not soft-deleted (null OR absent — a row whose create
    // omitted the field does not match `{ deletedAt: null }` on Mongo).
    const po = (where.purchaseOrder as { is: Record<string, unknown> }).is;
    expect(po.status).toEqual({ not: "cancelled" });
    expect(po.OR).toEqual([{ deletedAt: null }, { deletedAt: { isSet: false } }]);
  });

  it("keeps the order guard when a warehouse scope is applied", async () => {
    // The scope merges INTO the predicate's purchaseOrder clause. Spread as a sibling key it would
    // overwrite it, silently dropping the live-order guard exactly where scoping is tightest.
    const seen: Record<string, unknown>[] = [];
    const { prisma } = await import("../../lib/prisma.js");
    (prisma as unknown as Record<string, unknown>).purchaseOrderRentalLine = {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => { seen.push(args.where); return []; }),
    };
    const { findLiveHiresByRentalItems } = await import("./purchase-order.repository.js");
    await findLiveHiresByRentalItems(["d".repeat(24)], ["b".repeat(24)]);

    const po = (seen[0]!.purchaseOrder as { is: Record<string, unknown> }).is;
    expect(po.warehouseId).toEqual({ in: ["b".repeat(24)] });
    expect(po.status).toEqual({ not: "cancelled" });
    expect(po.OR).toBeDefined();
  });

  it("short-circuits with no items, without querying", async () => {
    const { findLiveHiresByRentalItems } = await import("./purchase-order.repository.js");
    await expect(findLiveHiresByRentalItems([])).resolves.toEqual([]);
  });
});
