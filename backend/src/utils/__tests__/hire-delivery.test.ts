import { describe, expect, it } from "vitest";

import { lateHireDelivery, publicLateHireDelivery } from "../hire-delivery.js";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const hire = (start: string) => ({ hireStartDate: day(start) });

describe("lateHireDelivery", () => {
  // The order that prompted this: hire runs 18→19 Aug but the supplier is told to deliver on the
  // 19th. The 18th is billed with nothing on site, and the app's own "awaiting delivery, hire has
  // started" alert fires the day the order is raised.
  it("reports a delivery that lands after the hire has started", () => {
    expect(lateHireDelivery(day("2026-08-19"), [hire("2026-08-18")])).toEqual({
      earliestHireStart: day("2026-08-18"),
      daysLate: 1,
    });
  });

  it("is silent when the kit arrives on the day the hire starts", () => {
    expect(lateHireDelivery(day("2026-08-18"), [hire("2026-08-18")])).toBeNull();
  });

  it("is silent when the kit arrives before the hire starts", () => {
    expect(lateHireDelivery(day("2026-08-16"), [hire("2026-08-18")])).toBeNull();
  });

  // A one-day hire is perfectly ordinary — the rule is about the DELIVERY date, never the length
  // of the hire, and must not make short hires harder to raise.
  it("accepts a one-day hire delivered on its start date", () => {
    expect(lateHireDelivery(day("2026-08-18"), [{ hireStartDate: day("2026-08-18") }])).toBeNull();
  });

  // Several hires on one order: the EARLIEST start is the one the delivery date has to satisfy.
  it("measures against the earliest hire on the order", () => {
    const found = lateHireDelivery(day("2026-08-20"), [hire("2026-08-25"), hire("2026-08-18"), hire("2026-09-01")]);
    expect(found).toEqual({ earliestHireStart: day("2026-08-18"), daysLate: 2 });
  });

  it("stays silent when only the later hires start after delivery", () => {
    expect(lateHireDelivery(day("2026-08-20"), [hire("2026-08-25"), hire("2026-08-20")])).toBeNull();
  });

  it("has nothing to say about an order with no hires", () => {
    expect(lateHireDelivery(day("2026-08-19"), [])).toBeNull();
  });

  it("has nothing to say when no delivery date is set yet", () => {
    expect(lateHireDelivery(null, [hire("2026-08-18")])).toBeNull();
    expect(lateHireDelivery(undefined, [hire("2026-08-18")])).toBeNull();
  });

  // Hire dates are stored as UTC-midnight calendar days; the delivery date is not normalised at the
  // schema boundary. Comparing the raw instants would make a late-evening delivery date read as a
  // day later than the user picked — the off-by-one this codebase normalises everywhere else.
  it("compares calendar days, not instants", () => {
    expect(lateHireDelivery(new Date("2026-08-18T23:30:00.000Z"), [hire("2026-08-18")])).toBeNull();
    expect(lateHireDelivery(new Date("2026-08-19T00:30:00.000Z"), [hire("2026-08-18")])).toEqual({
      earliestHireStart: day("2026-08-18"),
      daysLate: 1,
    });
  });

  // An unparseable date must not throw on a read path — every PRF and PO list would 500.
  it("stays silent rather than throwing on an unusable date", () => {
    expect(lateHireDelivery(new Date("nonsense"), [hire("2026-08-18")])).toBeNull();
    expect(lateHireDelivery(day("2026-08-19"), [{ hireStartDate: new Date("nonsense") }])).toBeNull();
  });
});

// Both documents put this on the wire in the SAME shape — two hand-written mappings would
// eventually disagree about the field names for the same order.
describe("publicLateHireDelivery", () => {
  it("serialises the hire start as an ISO instant", () => {
    expect(publicLateHireDelivery(day("2026-08-19"), [hire("2026-08-18")])).toEqual({
      earliestHireStart: "2026-08-18T00:00:00.000Z",
      daysLate: 1,
    });
  });

  it("is null whenever there is nothing to warn about", () => {
    expect(publicLateHireDelivery(day("2026-08-18"), [hire("2026-08-18")])).toBeNull();
    expect(publicLateHireDelivery(null, [hire("2026-08-18")])).toBeNull();
    expect(publicLateHireDelivery(day("2026-08-19"), [])).toBeNull();
  });
});
