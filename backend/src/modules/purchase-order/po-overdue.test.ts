import { describe, expect, it } from "vitest";

import { effectiveEta, expectedWindowEnd, isDeliveryDueSoon, isDeliveryOverdue } from "./po-overdue.js";

// The badge counts overdue deliveries in memory; the list filters them in Mongo. Two halves of one
// rule that cannot share an implementation — JavaScript on one side, a Prisma `where` on the other —
// so each is written down and both are tested against the same cases.
//
// They drifted exactly where Mongo invites it. The where clause said `confirmedDeliveryDate: null`,
// which matches only an EXPLICIT null; nothing writes that field on create (recordSupplierAcceptance
// is the only path that sets it), so on every PO still awaiting acknowledgement it is ABSENT. The
// in-memory `confirmed ?? expected` never noticed. "Deliveries overdue 8" opened six rows — all
// Supplier Accepted — and silently hid the un-acknowledged ones, which are the ones worth chasing.

const DAY_START = new Date("2026-08-08T00:00:00.000Z");
const past = new Date("2026-07-21T00:00:00.000Z");
const future = new Date("2026-08-25T00:00:00.000Z");

describe("effectiveEta", () => {
  it("prefers the supplier's confirmed date once given", () => {
    expect(effectiveEta(future, past)).toBe(future);
  });

  it("falls back to the expected date until then", () => {
    expect(effectiveEta(null, past)).toBe(past);
    // ABSENT, not null — the state every un-acknowledged PO is actually in.
    expect(effectiveEta(undefined, past)).toBe(past);
  });

  it("is null when neither date exists — no ETA is neither due nor late", () => {
    expect(effectiveEta(null, null)).toBeNull();
    expect(effectiveEta(undefined, undefined)).toBeNull();
  });
});

describe("isDeliveryOverdue", () => {
  // THE case the filter was missing. A `sent` PO carries no confirmed date at all.
  it("is late on a past expected date when the confirmed date was never written", () => {
    expect(isDeliveryOverdue(undefined, past, DAY_START)).toBe(true);
  });

  it("is late the same way when the confirmed date is explicitly null", () => {
    expect(isDeliveryOverdue(null, past, DAY_START)).toBe(true);
  });

  // Both spellings of "unset" must behave identically, because the database contains both and only
  // one of them was matching.
  it("treats absent and null identically", () => {
    for (const expected of [past, future, null]) {
      expect(isDeliveryOverdue(undefined, expected, DAY_START)).toBe(
        isDeliveryOverdue(null, expected, DAY_START),
      );
    }
  });

  // The reason the fallback is gated on the confirmed date being unset at all: a supplier who
  // re-confirmed for next week has fixed it, and the stale original date must not keep it red.
  it("clears a PO the supplier re-confirmed for later, however old its expected date", () => {
    expect(isDeliveryOverdue(future, past, DAY_START)).toBe(false);
  });

  it("is late when the CONFIRMED date itself has passed", () => {
    expect(isDeliveryOverdue(past, future, DAY_START)).toBe(true);
  });

  // `lt`, not `lte` — matching buildWhere. A delivery due today is due, not late.
  it("does not call a delivery due today late", () => {
    expect(isDeliveryOverdue(null, DAY_START, DAY_START)).toBe(false);
    expect(isDeliveryOverdue(DAY_START, null, DAY_START)).toBe(false);
  });

  it("leaves a PO with no ETA alone", () => {
    expect(isDeliveryOverdue(null, null, DAY_START)).toBe(false);
    expect(isDeliveryOverdue(undefined, undefined, DAY_START)).toBe(false);
  });

  // The boundary is the COMPANY's midnight, handed in — never the server's clock. Passing a different
  // day flips the same row, which is what would happen if either half derived it locally.
  it("follows the day boundary it is given", () => {
    expect(isDeliveryOverdue(null, past, new Date("2026-07-01T00:00:00.000Z"))).toBe(false);
    expect(isDeliveryOverdue(null, past, DAY_START)).toBe(true);
  });
});

// ── The other half of the same split: "due soon" ──────────────────────────────────────────────
//
// `expectedDeliveries` divides the open receivable set in two — already late, and due inside the
// window — and the dashboard prints both. Only the late half had a list: "Expected This Week" opened
// `?status=sent`, which is one of three receivable statuses and takes no notice of a date at all, so
// a card reading 4 opened every sent order regardless of when it is due. `due_this_week` is the
// missing filter, and this is the in-memory half it mirrors.

describe("isDeliveryDueSoon", () => {
  const inWindow = new Date("2026-08-12T00:00:00.000Z"); // 4 days out
  const justPastWindow = new Date("2026-08-16T00:00:00.000Z"); // day 8

  it("counts an order due inside the window", () => {
    expect(isDeliveryDueSoon(undefined, inWindow, DAY_START)).toBe(true);
  });

  it("counts one due TODAY — today is due, not late", () => {
    expect(isDeliveryDueSoon(undefined, DAY_START, DAY_START)).toBe(true);
  });

  // The bound the card has always counted with, pinned so a refactor can't quietly shift it by a day.
  it("includes the last day of the window and excludes the one after it", () => {
    expect(isDeliveryDueSoon(undefined, expectedWindowEnd(DAY_START), DAY_START)).toBe(true);
    expect(isDeliveryDueSoon(undefined, justPastWindow, DAY_START)).toBe(false);
  });

  it("does not count one that is already late — that is the overdue half", () => {
    expect(isDeliveryDueSoon(undefined, past, DAY_START)).toBe(false);
  });

  it("does not count an order with no ETA at all", () => {
    expect(isDeliveryDueSoon(null, null, DAY_START)).toBe(false);
    expect(isDeliveryDueSoon(undefined, undefined, DAY_START)).toBe(false);
  });

  it("follows the supplier's confirmed date when there is one", () => {
    // Expected next month, but re-confirmed for Wednesday: it IS due this week.
    expect(isDeliveryDueSoon(inWindow, future, DAY_START)).toBe(true);
    // And the reverse — confirmed for later clears it out of the window.
    expect(isDeliveryDueSoon(future, inWindow, DAY_START)).toBe(false);
  });

  it("treats absent and null confirmed dates identically, like the overdue half", () => {
    for (const expected of [past, inWindow, future, null]) {
      expect(isDeliveryDueSoon(undefined, expected, DAY_START)).toBe(
        isDeliveryDueSoon(null, expected, DAY_START),
      );
    }
  });
});

// THE invariant the dashboard depends on: every open receivable order lands on at most ONE of the
// two badges. If these ever overlapped, one delivery would be counted twice on the Overview and the
// two lists would return intersecting sets.
describe("the two halves never claim the same order", () => {
  const dates = [past, DAY_START, new Date("2026-08-12T00:00:00.000Z"), expectedWindowEnd(DAY_START), future, null, undefined];
  it("is never both overdue and due soon", () => {
    for (const confirmed of dates) {
      for (const expected of dates) {
        const late = isDeliveryOverdue(confirmed, expected, DAY_START);
        const soon = isDeliveryDueSoon(confirmed, expected, DAY_START);
        expect(late && soon, `${String(confirmed)} / ${String(expected)}`).toBe(false);
      }
    }
  });
});
