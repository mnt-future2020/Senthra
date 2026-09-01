import { describe, expect, it } from "vitest";

import {
  OPEN_PO_STATUSES,
  buildWhere as buildPoWhere,
  receivableWhere,
} from "#modules/purchase-order/purchase-order.repository.js";
import { expectedWindowEnd, isDeliveryDueSoon } from "#modules/purchase-order/po-overdue.js";
import { buildWhere as buildJobWhere } from "#modules/job/job.repository.js";
import { OVERDUE_ELIGIBLE_STATUSES } from "#modules/job/job-overdue.js";
import { filterPositions, type StockPosition } from "#modules/inventory/stock-position.js";

// ── "The number opens its own rows" ────────────────────────────────────────────────────────────
//
// Every Overview KPI card is a count taken one way and a link taken another. This file pins the
// join: for each card, the destination filter must select the SAME set the count measured.
//
// Four of them didn't. They opened the bare module list — `/dashboard/purchase-orders`,
// `/dashboard/jobs`, `/dashboard/goods-in` — or a single stored status that was one slice of the
// queue ("Expected This Week" → `?status=sent`). A card reading 18 landing on every job ever raised
// is the same broken promise the attention catalog documents for `?status=rework` and `?status=draft`,
// and it fails in the same silent way: nothing errors, the list is simply not the thing counted.
//
// These are pure where-builders and pure filters — no Prisma I/O — matching the contract
// po.filters.test.ts and job.filters.test.ts already run under.

const DAY_START = new Date("2026-08-08T00:00:00.000Z");
const andClauses = (w: { AND?: unknown }) => (Array.isArray(w.AND) ? w.AND : w.AND ? [w.AND] : []);

describe("Open POs → ?status=open", () => {
  // The card counts through `openSummary`, which selects `status in OPEN_PO_STATUSES`. Both read the
  // one exported constant, so the card and the list cannot name different statuses.
  it("selects exactly the statuses the card counts", () => {
    expect(buildPoWhere({ status: "open" }).status).toEqual({ in: [...OPEN_PO_STATUSES] });
  });

  it("leaves finished work out — closed, cancelled and fully_received are not open", () => {
    const open = [...OPEN_PO_STATUSES] as string[];
    for (const terminal of ["closed", "cancelled", "fully_received"]) {
      expect(open, terminal).not.toContain(terminal);
    }
  });

  it("still composes with the other filters, so a card click can be narrowed further", () => {
    const where = buildPoWhere({ status: "open", supplierId: "S1", priority: "high" });
    expect(where.status).toEqual({ in: [...OPEN_PO_STATUSES] });
    expect(where.supplierId).toBe("S1");
    expect(where.priority).toBe("high");
  });
});

describe("Expected This Week → ?status=due_this_week", () => {
  const where = buildPoWhere({ status: "due_this_week", dayStart: DAY_START });

  // The card counts `expectedDeliveries`, which selects through `receivableWhere()` — three statuses
  // AND at least one goods line, so a hire-only order (nothing to receive) is in neither.
  it("selects the receivable set the card counts, goods-line requirement included", () => {
    expect(where.status).toEqual(receivableWhere().status);
    expect(where.items).toEqual({ some: {} });
  });

  it("bounds the window at today and at the last day the card counts", () => {
    const window = { gte: DAY_START, lte: expectedWindowEnd(DAY_START) };
    expect(andClauses(where)).toEqual([
      {
        OR: [
          { confirmedDeliveryDate: window },
          {
            OR: [{ confirmedDeliveryDate: null }, { confirmedDeliveryDate: { isSet: false } }],
            expectedDeliveryDate: window,
          },
        ],
      },
    ]);
  });

  // The Mongo trap the overdue branch already carries a warning about: nothing writes
  // `confirmedDeliveryDate` on create, so on every un-acknowledged PO the field is ABSENT — and
  // absent is not null. Asking for only one of the two spellings hides exactly the orders that have
  // not been acknowledged, which are the ones worth chasing.
  it("asks for BOTH spellings of an unset confirmed date", () => {
    const json = JSON.stringify(andClauses(where));
    expect(json).toContain('"isSet":false');
    expect(json).toContain('"confirmedDeliveryDate":null');
  });

  // Loud, like the overdue branch: a quiet default would answer with a window measured from the
  // server's UTC midnight and silently disagree with the card by up to a day.
  it("refuses to run without the company-timezone day start", () => {
    expect(() => buildPoWhere({ status: "due_this_week" })).toThrow(/dayStart/);
  });

  it("composes with the warehouse scope rather than being replaced by it", () => {
    const scoped = buildPoWhere({ status: "due_this_week", dayStart: DAY_START, warehouseIds: ["W1"] });
    const clauses = andClauses(scoped);
    expect(clauses).toContainEqual({ warehouseId: { in: ["W1"] } });
    expect(clauses.some((c) => JSON.stringify(c).includes("confirmedDeliveryDate"))).toBe(true);
  });
});

// Not a card of its own — the "Deliveries overdue" chip in Awaiting Your Action, and the red half of
// the Expected This Week card's secondary line. It shares this file because it is the same join, and
// because it is the half that had drifted: the count selects through `receivableWhere()` (statuses
// AND a goods line), the list asked only for the statuses, so the chip said 9 and opened 12 — the
// extra three being hire-only orders with nothing for Goods In to receive.
describe("Deliveries overdue → ?status=overdue", () => {
  const where = buildPoWhere({ status: "overdue", overdueBefore: DAY_START });

  it("selects the same population the count does, goods-line requirement included", () => {
    expect(where.status).toEqual(receivableWhere().status);
    expect(where.items).toEqual({ some: {} });
  });

  // The registry declares this key a strict subset of "Deliveries to receive". It can only BE one if
  // both filters select from the same set and this one merely narrows it by date.
  it("is a strict narrowing of the receivable list", () => {
    const receivable = buildPoWhere({ status: "receivable" });
    expect(where.status).toEqual(receivable.status);
    expect(where.items).toEqual(receivable.items);
    expect(andClauses(where)).toHaveLength(1); // the date predicate, and nothing else
  });

  it("still refuses to run without the company-timezone day start", () => {
    expect(() => buildPoWhere({ status: "overdue" })).toThrow(/overdueBefore/);
  });
});

describe("Active Jobs → ?status=active", () => {
  // The card counts `countActive`, which selects ACTIVE_JOB_STATUSES — re-exported from job-overdue
  // so the active list, the overdue narrowing and the card all mean one thing by "in flight".
  it("selects exactly the statuses the card counts", () => {
    expect(buildJobWhere({ status: "active" }).status).toEqual({ in: [...OVERDUE_ELIGIBLE_STATUSES] });
  });

  it("does not narrow by date — active is a status question, not a due-date one", () => {
    expect(buildJobWhere({ status: "active" }).completionDate).toBeUndefined();
  });

  // The same three statuses "overdue" narrows within, so the overdue jobs on the card's secondary
  // line are a strict subset of the rows the card itself opens.
  it("contains every status the overdue filter can match", () => {
    const active = buildJobWhere({ status: "active" }).status as { in: string[] };
    const overdue = buildJobWhere({ status: "overdue", overdueBefore: DAY_START }).status as { in: string[] };
    for (const s of overdue.in) expect(active.in).toContain(s);
  });

  it("still ANDs the other dimensions", () => {
    const where = buildJobWhere({ status: "active", assignedEngineerId: "E1", priority: "high" });
    expect(where.status).toEqual({ in: [...OVERDUE_ELIGIBLE_STATUSES] });
    expect(where.assignedEngineerId).toBe("E1");
    expect(where.priority).toBe("high");
  });
});

describe("Low Stock → ?status=below_reorder", () => {
  const pos = (id: string, status: StockPosition["status"]): StockPosition =>
    ({ id, status, itemName: id, itemCode: id, sku: null, ownership: "company", locationType: "warehouse" }) as StockPosition;

  const rows = [
    pos("low", "low_stock"),
    pos("empty", "out_of_stock"),
    pos("healthy", "in_stock"),
    pos("van", "on_van"),
    pos("broken", "damaged"),
  ];

  // The card counts every balance row at or BELOW its reorder level, and an empty shelf is the most
  // severe case of that. `?status=low_stock` alone dropped the empty ones — the card said 9 and the
  // list showed 6, with the worst three missing.
  it("selects low AND out of stock, which is what the card counts", () => {
    expect(filterPositions(rows, { status: "below_reorder" }).map((r) => r.id)).toEqual(["low", "empty"]);
  });

  it("does not reach past the stock statuses into van or damaged rows", () => {
    const ids = filterPositions(rows, { status: "below_reorder" }).map((r) => r.id);
    expect(ids).not.toContain("van");
    expect(ids).not.toContain("broken");
  });

  it("leaves the individual statuses filtering exactly as before", () => {
    expect(filterPositions(rows, { status: "low_stock" }).map((r) => r.id)).toEqual(["low"]);
    expect(filterPositions(rows, { status: "out_of_stock" }).map((r) => r.id)).toEqual(["empty"]);
    expect(filterPositions(rows, { status: "on_van" }).map((r) => r.id)).toEqual(["van"]);
  });

  // The card is scoped to company stock sitting in a warehouse — the only rows whose status is
  // derived from a reorder level at all — so its link pins those two dimensions and the filter has
  // to keep honouring them.
  it("still ANDs the ownership and location the card's link pins", () => {
    const mixed = [
      pos("company", "low_stock"),
      { ...pos("engineerHeld", "low_stock"), locationType: "engineer" as const },
      { ...pos("customerOwned", "low_stock"), ownership: "customer" as const },
    ];
    const ids = filterPositions(mixed, {
      status: "below_reorder",
      ownership: "company",
      locationType: "warehouse",
    }).map((r) => r.id);
    expect(ids).toEqual(["company"]);
  });
});

// ── "Expected This Week" — does the clause actually SELECT anything? ───────────────────────────
//
// The shape assertions above pin what the `where` is made of; they cannot tell you what it MATCHES.
// That gap is not academic: live data currently has no receivable order due inside the window, so
// `?status=due_this_week` returns 0 — which is correct, and indistinguishable from a predicate that
// silently selects nothing. A card that reads 4 and opens an empty list is the exact defect this
// whole file exists to prevent, and it would look like this.
//
// So the Mongo half is EVALUATED here against the same table of rows the in-memory half is run over,
// the way po-overdue.test.ts already does for the overdue pair. Both must name the same set.

/** Mongo semantics for exactly the clause `due_this_week` builds — no more, no less. */
interface PoRow {
  status: string;
  /** Whether the order has at least one goods line (`items: { some: {} }`). */
  hasItems: boolean;
  /** `undefined` models an ABSENT field, `null` an explicitly-null one. Mongo tells them apart. */
  confirmed?: Date | null;
  expected?: Date | null;
}

function matchesWhere(where: Record<string, unknown>, row: PoRow): boolean {
  const status = where.status as { in: string[] } | undefined;
  if (status && !status.in.includes(row.status)) return false;
  if (where.items && !row.hasItems) return false;

  const inWindow = (d: Date | null | undefined, w: { gte: Date; lte: Date }) =>
    d instanceof Date && d.getTime() >= w.gte.getTime() && d.getTime() <= w.lte.getTime();

  for (const clause of andClauses(where) as Array<{ OR?: Array<Record<string, unknown>> }>) {
    const branches = clause.OR;
    if (!branches) continue;
    const hit = branches.some((b) => {
      // Branch A — a supplier-confirmed date inside the window.
      if (b.confirmedDeliveryDate && !("OR" in b)) {
        return inWindow(row.confirmed, b.confirmedDeliveryDate as { gte: Date; lte: Date });
      }
      // Branch B — no confirmed date at all (null OR absent), expected date inside the window.
      const unset = row.confirmed === null || row.confirmed === undefined;
      return unset && inWindow(row.expected, b.expectedDeliveryDate as { gte: Date; lte: Date });
    });
    if (!hit) return false;
  }
  return true;
}

describe("Expected This Week — the clause selects the rows the card counts", () => {
  const where = buildPoWhere({ status: "due_this_week", dayStart: DAY_START }) as Record<string, unknown>;
  const match = (row: PoRow) => matchesWhere(where, row);
  const inside = new Date("2026-08-12T00:00:00.000Z"); // 4 days out
  const lastDay = expectedWindowEnd(DAY_START); // day 7 — inclusive
  const outside = new Date("2026-08-20T00:00:00.000Z");
  const past = new Date("2026-07-21T00:00:00.000Z");
  const base = { status: "sent", hasItems: true } as const;

  // THE positive case that live data cannot currently demonstrate.
  it("INCLUDES a receivable order with goods, not late, due inside the window", () => {
    expect(match({ ...base, expected: inside })).toBe(true);
    expect(match({ ...base, status: "supplier_accepted", expected: inside })).toBe(true);
    expect(match({ ...base, status: "partially_received", expected: inside })).toBe(true);
  });

  it("includes it whether the confirmed date is ABSENT or explicitly null", () => {
    expect(match({ ...base, expected: inside })).toBe(true); // absent — every un-acknowledged PO
    expect(match({ ...base, confirmed: null, expected: inside })).toBe(true);
  });

  it("follows the supplier's confirmed date over the buyer's expectation", () => {
    expect(match({ ...base, confirmed: inside, expected: outside })).toBe(true);
    expect(match({ ...base, confirmed: outside, expected: inside })).toBe(false);
  });

  it("includes today and the last day of the window, and excludes the day after", () => {
    expect(match({ ...base, expected: DAY_START })).toBe(true);
    expect(match({ ...base, expected: lastDay })).toBe(true);
    expect(match({ ...base, expected: new Date(lastDay.getTime() + 86_400_000) })).toBe(false);
  });

  it("EXCLUDES what the card excludes — late, out of window, no ETA, wrong status, no goods lines", () => {
    expect(match({ ...base, expected: past })).toBe(false); // the overdue half
    expect(match({ ...base, expected: outside })).toBe(false);
    expect(match({ ...base })).toBe(false); // no ETA at all
    expect(match({ ...base, status: "draft", expected: inside })).toBe(false);
    expect(match({ ...base, status: "fully_received", expected: inside })).toBe(false);
    expect(match({ ...base, hasItems: false, expected: inside })).toBe(false); // hire-only order
  });

  // The two halves are one computation seen twice — a row the badge counts is a row the list opens.
  it("agrees with the in-memory predicate the card counts with, row for row", () => {
    const dates: Array<Date | null | undefined> = [past, DAY_START, inside, lastDay, outside, null, undefined];
    for (const confirmed of dates) {
      for (const expected of dates) {
        const row: PoRow = { ...base, confirmed, expected };
        expect(match(row), `${String(confirmed)} / ${String(expected)}`).toBe(
          isDeliveryDueSoon(confirmed, expected, DAY_START),
        );
      }
    }
  });
});
