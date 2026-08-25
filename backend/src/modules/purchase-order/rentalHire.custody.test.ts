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
/** Orderable value as a number, or null when it isn't one — dates included, like Mongo. */
const cmp = (v: unknown): number | null =>
  typeof v === "number" ? v : v instanceof Date ? v.getTime() : null;

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
        // Mongo orders dates as well as numbers, and the hire-window guard compares one. `cmp`
        // returns null for anything not comparable, which keeps the rule this file exists to pin:
        // an absent (or wrong-typed) field satisfies NO range comparison.
        const a = cmp(value);
        const b = cmp(operand);
        const ok = present && a !== null && b !== null;
        if (op === "lte" && !(ok && a! <= b!)) return false;
        if (op === "gte" && !(ok && a! >= b!)) return false;
        if (op === "gt" && !(ok && a! > b!)) return false;
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

// ── The hire window, asserted in the same write ───────────────────────────────────────────────
//
// A read-side availability filter cannot close this on its own: the scan preview and the post are two
// requests, and a browser tab can sit open across the deadline. Putting the window in the conditional
// `where` makes the check and the commitment ONE operation, so a stale tab's post fails exactly the
// way an over-quantity post does.
describe("adjustHireIssuedQtyTx — the hire window", () => {
  const TODAY = new Date("2026-09-28T00:00:00Z");
  const dated = (end: string, over: Doc = {}) => hire({ hireEndDate: new Date(`${end}T00:00:00Z`), ...over });

  it("lends from a hire whose period is still running", async () => {
    const tx = fakeTx(dated("2026-10-15"));
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 2, TODAY)).resolves.toBe(true);
    expect(tx.store!.issuedQuantity).toBe(2);
  });

  // A hire is valid THROUGH its end date — `gte`, not `gt`. Getting this backwards would silently
  // shorten every hire in the system by a day.
  it("lends from a hire that ends TODAY", async () => {
    const tx = fakeTx(dated("2026-09-28"));
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 1, TODAY)).resolves.toBe(true);
  });

  it("REFUSES a hire that ended yesterday, and writes nothing", async () => {
    const tx = fakeTx(dated("2026-09-27"));
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 1, TODAY)).resolves.toBe(false);
    expect(tx.store!.issuedQuantity).toBe(0);
  });

  // The stale-tab case stated directly: the units are all there, the quantity guard would pass, and
  // the ONLY thing refusing the write is the window.
  it("refuses a stale post even when the quantity is perfectly available", async () => {
    const tx = fakeTx(dated("2026-09-01", { receivedQuantity: 5, issuedQuantity: 0 }));
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 1, TODAY)).resolves.toBe(false);
  });

  // An extension is just this column moving forward, so the same hire becomes issuable with no other
  // change anywhere — which is what makes "extend it and try again" a real answer for the warehouse.
  it("lends again once the hire has been extended past today", async () => {
    const expired = fakeTx(dated("2026-09-27"));
    await expect(adjustHireIssuedQtyTx(expired as never, LINE_ID, 1, TODAY)).resolves.toBe(false);
    const extended = fakeTx(dated("2026-11-30"));
    await expect(adjustHireIssuedQtyTx(extended as never, LINE_ID, 1, TODAY)).resolves.toBe(true);
  });

  // THE ASYMMETRY, and the reason the parameter is optional rather than required. An expired hire is
  // the one that most needs to come back; asserting the window on a return would strand overdue kit
  // in a van with no way to book it in.
  it("ALWAYS allows a return, however long the hire has been expired", async () => {
    const tx = fakeTx(dated("2020-01-01", { issuedQuantity: 3 }));
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, -3)).resolves.toBe(true);
    expect(tx.store!.issuedQuantity).toBe(0);
  });

  // Passing the date on a return must not accidentally start gating it either — belt to the braces
  // above, since the caller signature makes it possible.
  it("allows a return even if a date is passed in", async () => {
    const tx = fakeTx(dated("2020-01-01", { issuedQuantity: 2 }));
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, -2, TODAY)).resolves.toBe(true);
  });

  // Every existing caller that omits the date keeps its old behaviour exactly.
  it("does not gate the window when no date is supplied", async () => {
    const tx = fakeTx(dated("2020-01-01"));
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 1)).resolves.toBe(true);
  });

  // A row written before the deadline column existed has no `hireEndDate` at all. It satisfies no
  // range comparison (the rule this file exists to pin), so it is REFUSED rather than lent — the safe
  // direction for a hire whose period nobody can establish.
  it("refuses a legacy row that has no hireEndDate at all", async () => {
    const tx = fakeTx(hire());
    expect(Object.hasOwn(tx.store!, "hireEndDate")).toBe(false);
    await expect(adjustHireIssuedQtyTx(tx as never, LINE_ID, 1, TODAY)).resolves.toBe(false);
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
