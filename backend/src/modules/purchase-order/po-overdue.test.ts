import { describe, expect, it } from "vitest";

import { effectiveEta, isDeliveryOverdue } from "./po-overdue.js";

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
