import { describe, expect, it } from "vitest";

import { summariseShortfall } from "./stockRequestShortfall";
import type { PortalWarehouseAssignment } from "@/types/customer";

type Leg = PortalWarehouseAssignment;

const leg = (over: Partial<Leg> = {}): Leg => ({
  warehouseName: "London Fulfillment Centre",
  quantity: 20,
  receivedQuantity: 20,
  status: "received",
  closureReason: null,
  closedAt: null,
  ...over,
});

const closedShort = (over: Partial<Leg> = {}): Leg =>
  leg({ status: "closed_short", receivedQuantity: 15, closureReason: "Customer shipped 15 only", ...over });

describe("summariseShortfall", () => {
  it("returns null when nothing was closed short", () => {
    expect(summariseShortfall([])).toBeNull();
    expect(summariseShortfall([leg(), leg({ warehouseName: "Leeds Depot" })])).toBeNull();
  });

  it("ignores legs still open — stock in transit is not a shortfall", () => {
    expect(summariseShortfall([leg({ status: "pending", receivedQuantity: 0 })])).toBeNull();
    expect(summariseShortfall([leg({ status: "partially_received", receivedQuantity: 5 })])).toBeNull();
  });

  it("reports what arrived, what didn't, and why", () => {
    expect(summariseShortfall([closedShort()])).toEqual({
      units: 5,
      received: 15,
      total: 20,
      reasons: ["Customer shipped 15 only"],
    });
  });

  it("totals the shortfall across warehouses and keeps both reasons in leg order", () => {
    const result = summariseShortfall([
      closedShort({ quantity: 20, receivedQuantity: 15, closureReason: "Customer shipped 15 only" }),
      closedShort({ warehouseName: "Leeds Depot", quantity: 10, receivedQuantity: 0, closureReason: "Lost in transit" }),
    ]);
    expect(result).toEqual({
      units: 15,
      received: 15,
      total: 30,
      reasons: ["Customer shipped 15 only", "Lost in transit"],
    });
  });

  it("de-duplicates an identical reason given on two legs", () => {
    const result = summariseShortfall([closedShort(), closedShort({ warehouseName: "Leeds Depot" })]);
    expect(result).toEqual({ units: 10, received: 30, total: 40, reasons: ["Customer shipped 15 only"] });
  });

  it("counts a received leg's units as arrived, not missing", () => {
    const result = summariseShortfall([leg(), closedShort({ quantity: 10, receivedQuantity: 4 })]);
    expect(result).toEqual({ units: 6, received: 24, total: 30, reasons: ["Customer shipped 15 only"] });
  });

  it("counts an OPEN leg's units in the totals but never in the shortfall", () => {
    // 20 assigned to a leg still pending: nothing about it has failed, so it must not be reported
    // as missing — but its units are still part of what the customer submitted.
    const result = summariseShortfall([
      leg({ status: "pending", quantity: 20, receivedQuantity: 0 }),
      closedShort({ warehouseName: "Leeds Depot", quantity: 10, receivedQuantity: 4 }),
    ]);
    expect(result).toEqual({ units: 6, received: 4, total: 30, reasons: ["Customer shipped 15 only"] });
  });

  it("returns null when a short-close left nothing outstanding", () => {
    // Closed at the exact moment the last unit landed — terminal, but nothing is missing to explain.
    expect(summariseShortfall([closedShort({ quantity: 20, receivedQuantity: 20 })])).toBeNull();
  });

  it("never lets an over-received leg cancel out a real shortfall elsewhere", () => {
    const result = summariseShortfall([
      closedShort({ quantity: 5, receivedQuantity: 9, closureReason: "Miscount corrected" }),
      closedShort({ warehouseName: "Leeds Depot", quantity: 10, receivedQuantity: 2, closureReason: "Lost in transit" }),
    ]);
    expect(result).toEqual({
      units: 8,
      received: 11,
      total: 15,
      reasons: ["Miscount corrected", "Lost in transit"],
    });
  });

  it("still reports the shortfall when the reason is blank or whitespace", () => {
    // The reason is enforced on the way in, so this is defensive — but a missing explanation must
    // never swallow the fact that units are missing.
    const expected = { units: 5, received: 15, total: 20, reasons: [] };
    expect(summariseShortfall([closedShort({ closureReason: "   " })])).toEqual(expected);
    expect(summariseShortfall([closedShort({ closureReason: null })])).toEqual(expected);
  });

  it("adds up: on a finished submission received + missing IS the total", () => {
    // The property the copy rests on. Both figures are printed side by side, so if they ever failed
    // to reconcile against each other the customer would be the one to notice.
    const result = summariseShortfall([
      leg({ quantity: 12, receivedQuantity: 12 }),
      closedShort({ warehouseName: "Leeds Depot", quantity: 13, receivedQuantity: 2 }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.received + result!.units).toBe(result!.total);
    expect(result).toEqual({ units: 11, received: 14, total: 25, reasons: ["Customer shipped 15 only"] });
  });
});
