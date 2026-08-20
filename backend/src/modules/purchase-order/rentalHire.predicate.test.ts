import { describe, expect, it } from "vitest";

import { daysBetween } from "../../utils/calendar-day.js";
import {
  HIRE_STATUSES,
  atWarehouses,
  awaitingDeliveryWhere,
  computeNotifyOnDate,
  expiringSoonWhere,
  onHireWhere,
  overdueDeliveryWhere,
  overdueWhere,
} from "./rentalHire.predicate.js";

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("computeNotifyOnDate", () => {
  // The client's own example: a 30-day hire flagged on day 27.
  it("puts a 30-day hire's reminder on day 27", () => {
    const notifyOn = computeNotifyOnDate(day("2026-09-01"), day("2026-10-01"), 3);
    expect(notifyOn.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(daysBetween(day("2026-09-01"), notifyOn)).toBe(27);
  });

  it("returns the end date itself for a zero lead", () => {
    expect(computeNotifyOnDate(day("2026-09-01"), day("2026-10-01"), 0).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  // THE invariant: a reminder must never fall before the hire starts. A 2-day hire with the
  // default 3-day lead is reminded on its start date, not the day before it existed.
  it("clamps a lead longer than the hire to the start date", () => {
    expect(computeNotifyOnDate(day("2026-09-01"), day("2026-09-03"), 3).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("clamps rather than going negative for an absurd lead", () => {
    expect(computeNotifyOnDate(day("2026-09-01"), day("2026-09-03"), 365).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("never returns a date before the hire start, for any lead in range", () => {
    const start = day("2026-09-01");
    const end = day("2026-09-10");
    for (let lead = 0; lead <= 365; lead++) {
      expect(computeNotifyOnDate(start, end, lead).getTime()).toBeGreaterThanOrEqual(start.getTime());
    }
  });

  // Exact across DST because both ends are UTC midnights — see utils/calendar-day.ts.
  it("lands on the right calendar day across a DST transition", () => {
    expect(computeNotifyOnDate(day("2026-03-01"), day("2026-03-30"), 3).toISOString()).toBe(
      "2026-03-27T00:00:00.000Z",
    );
    expect(computeNotifyOnDate(day("2026-10-01"), day("2026-10-26"), 3).toISOString()).toBe(
      "2026-10-23T00:00:00.000Z",
    );
  });
});

describe("the hire predicates", () => {
  const todayStart = day("2026-09-28");

  it("scopes every predicate to live hires only", () => {
    for (const w of [expiringSoonWhere(todayStart), overdueWhere(todayStart), onHireWhere()]) {
      expect(w).toMatchObject({ hireStatus: "on_hire" });
    }
  });

  // Without the lower bound on hireEndDate every overdue hire also counts as expiring soon and one
  // line lands on BOTH badges, so the sidebar rollup double-counts it.
  it("excludes already-overdue hires from expiring-soon", () => {
    const w = expiringSoonWhere(todayStart) as { hireEndDate?: { gte?: Date } };
    expect(w.hireEndDate?.gte).toEqual(todayStart);
  });

  it("includes a reminder that came due earlier today, not just at midnight", () => {
    const w = expiringSoonWhere(todayStart) as { notifyOnDate: { lte: Date } };
    expect(w.notifyOnDate.lte.toISOString()).toBe("2026-09-28T23:59:59.999Z");
  });

  it("scopes overdue to live hires whose end date has passed", () => {
    const w = overdueWhere(todayStart) as { hireEndDate?: { lt?: Date } };
    expect(w.hireEndDate?.lt).toEqual(todayStart);
  });

  // The two sets must not overlap, or one line is counted by both badges.
  it("cannot put one line in both the expiring and overdue sets", () => {
    const soon = expiringSoonWhere(todayStart) as { hireEndDate: { gte: Date } };
    const late = overdueWhere(todayStart) as { hireEndDate: { lt: Date } };
    expect(soon.hireEndDate.gte.getTime()).toBe(late.hireEndDate.lt.getTime());
  });
});

describe("HIRE_STATUSES", () => {
  // One list, so validation, the predicates and the UI can never disagree about what a hire can be.
  // In LIFE ORDER: committed to the provider, in our hands, sent back.
  it("is exactly awaiting_delivery, on_hire and returned", () => {
    expect([...HIRE_STATUSES]).toEqual(["awaiting_delivery", "on_hire", "returned"]);
  });
});

// The receive step exists because a purchase order is a commitment, not a delivery. Everything below
// pins the consequence: a hire nobody has received raises NO deadline — it cannot be ending soon, and
// it cannot be overdue for a return that has not become possible yet.
describe("awaiting delivery", () => {
  const TODAY = new Date(Date.UTC(2026, 8, 15));

  // The queue asks about UNITS STILL TO COME, not about a status. A part-delivered line is already
  // `on_hire` — the units that are here are on hire — so a status-only queue dropped the outstanding
  // ones the moment the first unit arrived, and nothing chased them again.
  it("is a queue of outstanding UNITS, not of a status", () => {
    const w = awaitingDeliveryWhere();
    expect(w.fullyReceived).toBe(false);
    expect(w.hireStatus).toEqual({ not: "returned" });
    expect(onHireWhere().hireStatus).toBe("on_hire");
  });

  // A hire that went back is finished whatever its quantities say — without this a part-delivered,
  // then-returned line would sit in the receiving queue forever.
  it("excludes a returned hire even with units never delivered", () => {
    expect(awaitingDeliveryWhere().hireStatus).toEqual({ not: "returned" });
    // The chase badge asks for `awaiting_delivery` outright, so `returned` is excluded a fortiori —
    // and, unlike "not returned", it also stays clear of the two on_hire badges it shares a sidebar
    // row with. See "the three Inventory hire badges never count one line twice" below.
    expect(overdueDeliveryWhere(TODAY).hireStatus).toBe("awaiting_delivery");
  });

  // The three deadline predicates ask for `on_hire` and not merely "not returned" — which is what
  // keeps an unreceived hire off the badges and out of the reminder sweep.
  it("is excluded from the on-hire list, both deadline windows and the sweep", () => {
    for (const where of [onHireWhere(), expiringSoonWhere(TODAY), overdueWhere(TODAY)]) {
      expect(where.hireStatus).toBe("on_hire");
    }
  });

  // The one thing that must NOT go quiet: kit that should already be here and of which NOTHING has
  // arrived. A part delivery is chased by the warehouse's own receiving queue instead — a different
  // sidebar row, so the two cannot count one line twice.
  it("flags an undelivered hire only once its start date has passed", () => {
    const w = overdueDeliveryWhere(TODAY);
    expect(w.hireStatus).toBe("awaiting_delivery");
    expect(w.hireStartDate).toEqual({ lte: TODAY });
  });

  // Both queues carry the live-order guard, or a cancelled order would leave rows nobody can act on.
  it("keeps the live-order guard", () => {
    for (const where of [awaitingDeliveryWhere(), overdueDeliveryWhere(TODAY)]) {
      expect(where.purchaseOrder).toBeDefined();
    }
  });
});

// A hire goes back in PARTS, exactly as it arrives in them — so "is this hire's deadline still my
// problem" is a question about a QUANTITY, not about a status.
describe("everything we hold has gone back", () => {
  const TODAY = new Date(Date.UTC(2026, 8, 15));

  // Once the last unit we hold has been collected the deadline is nobody's work. It cannot be said
  // with the STATUS alone: a line can be legitimately `on_hire` with units that were never delivered,
  // and closing it would drop those out of the receiving queue forever.
  it("takes a fully-returned hire off the on-hire list and both deadline windows", () => {
    for (const where of [onHireWhere(), expiringSoonWhere(TODAY), overdueWhere(TODAY)]) {
      expect(where.fullyReturned).toBe(false);
      // Still `on_hire` as well — the pair is what makes "kit we are actually holding" exact.
      expect(where.hireStatus).toBe("on_hire");
    }
  });

  // The RECEIVING queue must not read it: units still to be delivered are still owed to us whatever
  // has already gone back, and a line dropped from here is a line nobody chases again.
  it("leaves the receiving queue alone", () => {
    expect(awaitingDeliveryWhere().fullyReturned).toBeUndefined();
    expect(overdueDeliveryWhere(TODAY).fullyReturned).toBeUndefined();
  });
});

// The client's rule: a hire follows the IRM flow exactly. Receiving is the half where that bites.
describe("a hire is received only from an ISSUED order, exactly as goods are", () => {
  const TODAY = new Date(Date.UTC(2026, 8, 15));
  const ISSUED = { in: ["sent", "supplier_accepted", "partially_received"] };

  // A draft order has not been sent, so kit arriving against it is kit arriving against an order the
  // supplier never got. It used to be allowed here, which put two Receive buttons with two different
  // rules on one purchase order.
  it("narrows the receiving queue and the chase badge to the issued window", () => {
    expect((awaitingDeliveryWhere().purchaseOrder as { is: { status: unknown } }).is.status).toEqual(ISSUED);
    expect((overdueDeliveryWhere(TODAY).purchaseOrder as { is: { status: unknown } }).is.status).toEqual(ISSUED);
  });

  // The DEADLINE predicates keep the wide guard. Once the kit is here its clock runs whatever the
  // order is doing — narrowing these would drop a live hire the moment its order was closed.
  it("leaves the deadline predicates on the live-order guard", () => {
    for (const where of [onHireWhere(), expiringSoonWhere(TODAY), overdueWhere(TODAY)]) {
      expect((where.purchaseOrder as { is: { status: unknown } }).is.status).toEqual({ not: "cancelled" });
    }
  });

  // Both windows still exclude a deleted order, whichever guard they carry.
  it("keeps the soft-delete guard on both", () => {
    for (const where of [awaitingDeliveryWhere(), onHireWhere()]) {
      expect((where.purchaseOrder as { is: { OR: unknown } }).is.OR).toEqual([
        { deletedAt: null },
        { deletedAt: { isSet: false } },
      ]);
    }
  });
});

// A deleted or cancelled order's hire is over. Without this the red badge counted a line nobody
// could act on — `softDelete` stamps the header only, so the line survives — while "mark returned"
// refused because the order could no longer be loaded. The badge became unclearable.
describe("the hire's order must still be live", () => {
  const todayStart = day("2026-09-28");

  it.each([
    ["expiring", expiringSoonWhere(todayStart)],
    ["overdue", overdueWhere(todayStart)],
    ["on hire", onHireWhere()],
  ])("%s excludes cancelled and deleted orders", (_label, where) => {
    const w = where as { purchaseOrder?: { is?: { status?: unknown; OR?: unknown[] } } };
    expect(w.purchaseOrder?.is?.status).toEqual({ not: "cancelled" });
    // Mongo: a row whose create omitted the field does not match `{ deletedAt: null }`.
    expect(w.purchaseOrder?.is?.OR).toEqual([{ deletedAt: null }, { deletedAt: { isSet: false } }]);
  });

  // Conversion lands an order in DRAFT and the hire it carries is already committed to the
  // provider, so excluding draft would silence the reminder for every freshly converted request.
  it("still counts a hire on a draft order", () => {
    const w = expiringSoonWhere(todayStart) as { purchaseOrder: { is: { status: { not: string } } } };
    expect(w.purchaseOrder.is.status.not).toBe("cancelled");
  });
});

// The warehouse's receiving pane and the badge that sends people to it MUST select the same rows.
// They were built separately — the pane merged the warehouse into the predicate inline — so one
// helper now does it for both. A hire the pane lists and the badge does not count is the exact
// failure this shares code to prevent.
describe("atWarehouses", () => {
  it("narrows a hire predicate to the orders addressed to those warehouses", () => {
    const w = atWarehouses(awaitingDeliveryWhere(), ["wh1", "wh2"]) as {
      purchaseOrder: { is: { warehouseId?: unknown; status?: unknown; OR?: unknown[] } };
      hireStatus?: unknown;
      fullyReceived?: boolean;
    };
    expect(w.purchaseOrder.is.warehouseId).toEqual({ in: ["wh1", "wh2"] });
    // ...without losing the order guard the CALLER asked for. The receiving queue carries the issued
    // window, and rebuilding this from the wide live-order clause would silently hand the warehouse
    // pane back the unissued orders the queue was just narrowed to exclude.
    expect(w.purchaseOrder.is.status).toEqual({ in: ["sent", "supplier_accepted", "partially_received"] });
    expect(w.purchaseOrder.is.OR).toEqual([{ deletedAt: null }, { deletedAt: { isSet: false } }]);
    // The queue's own terms survive the narrowing — it asks for outstanding UNITS, not for a status.
    expect(w.fullyReceived).toBe(false);
    expect(w.hireStatus).toEqual({ not: "returned" });
  });

  // An unscoped actor (an admin who can reach every warehouse) must not be narrowed to none.
  it("leaves the predicate alone when there is no warehouse scope", () => {
    expect(atWarehouses(awaitingDeliveryWhere(), undefined)).toEqual(awaitingDeliveryWhere());
  });

  // A DEADLINE predicate keeps the wide guard — once kit is in our hands its clock runs whatever the
  // order's paperwork is doing.
  it("keeps a deadline predicate's own wider order guard", () => {
    const w = atWarehouses(onHireWhere(), ["wh1"]) as { purchaseOrder: { is: { status?: unknown } } };
    expect(w.purchaseOrder.is.status).toEqual({ not: "cancelled" });
  });

  // A scope of NO warehouses is not "every warehouse": an actor scoped to zero sees zero.
  it("selects nothing for an empty scope", () => {
    const w = atWarehouses(awaitingDeliveryWhere(), []) as { purchaseOrder: { is: { warehouseId?: unknown } } };
    expect(w.purchaseOrder.is.warehouseId).toEqual({ in: [] });
  });
});

// Every rentals.* badge rolls up to the SAME sidebar row, so two of them matching one line makes the
// Inventory number count it twice — the exact reason expiringSoonWhere carries its hireEndDate upper
// bound. Widening awaitingDeliveryWhere to "not fully received" (so a part-delivered line keeps its
// outstanding units in the RECEIVING queue) quietly broke that for the chase badge: a part-delivered
// line is `on_hire`, so it began matching overdueDeliveryWhere and overdueWhere at once.
describe("the three Inventory hire badges never count one line twice", () => {
  const todayStart = new Date("2026-09-28T00:00:00.000Z");

  // A line's state, as the four predicates see it.
  const matches = (
    where: Record<string, unknown>,
    line: { hireStatus: string; fullyReceived: boolean },
  ): boolean => {
    const wanted = where.hireStatus;
    if (typeof wanted === "string") return wanted === line.hireStatus;
    if (wanted && typeof wanted === "object" && "not" in wanted) {
      return (wanted as { not: string }).not !== line.hireStatus;
    }
    return true;
  };

  const partDelivered = { hireStatus: "on_hire", fullyReceived: false };

  it("keeps the chase badge off a line that has started arriving", () => {
    expect(
      matches(overdueDeliveryWhere(todayStart) as Record<string, unknown>, partDelivered),
      "a part-delivered hire is on_hire, so it would also match the return-deadline badges",
    ).toBe(false);
  });

  // "Hires not yet received" has to mean what it says. Something HAS been received on a part
  // delivery; its outstanding units are the warehouse's receiving queue (wh.rental_intake), which is
  // a different sidebar row and so cannot double-count.
  it("still chases a hire where nothing at all has arrived", () => {
    expect(
      matches(overdueDeliveryWhere(todayStart) as Record<string, unknown>, {
        hireStatus: "awaiting_delivery",
        fullyReceived: false,
      }),
    ).toBe(true);
  });

  it("leaves the receiving queue broad — outstanding units stay somebody's job", () => {
    const w = awaitingDeliveryWhere() as Record<string, unknown>;
    expect(matches(w, partDelivered), "a part delivery still has units to receive").toBe(true);
    expect(w.fullyReceived).toBe(false);
  });

  it.each([
    ["expiring soon", expiringSoonWhere(new Date("2026-09-28T00:00:00.000Z"))],
    ["overdue for return", overdueWhere(new Date("2026-09-28T00:00:00.000Z"))],
  ])("is disjoint from %s by hire status alone", (_label, deadlineWhere) => {
    const chase = overdueDeliveryWhere(todayStart) as { hireStatus?: unknown };
    expect(chase.hireStatus).toBe("awaiting_delivery");
    expect((deadlineWhere as { hireStatus?: unknown }).hireStatus).toBe("on_hire");
  });
});
