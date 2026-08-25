import { describe, expect, it } from "vitest";

import { isOpen, sourceOf } from "./HireCustodyTimeline";
import type { HireCustodyExit } from "@/types/rental";

const exit = (over: Partial<HireCustodyExit> = {}): HireCustodyExit => ({
  id: "x1",
  purchaseOrderRentalLineId: "l1",
  purchaseOrderId: "p1",
  poCode: "PO-0073",
  warehouseId: "w1",
  kind: "damage",
  qty: 1,
  itemName: "Fibre Tester",
  custodyState: "held_damaged",
  settlementState: "unsettled",
  reason: "Screen cracked",
  notes: null,
  photoUrl: null,
  jobId: null,
  jobNumber: null,
  engineerId: null,
  engineerName: null,
  declaredBy: "wm@x.co",
  declaredAt: "2026-08-24T00:00:00.000Z",
  settledByReceiptId: null,
  settledAt: null,
  recoveredBy: null,
  recoveredAt: null,
  recoveryNotes: null,
  settledByCode: null,
  settledCharge: null,
  attachments: [],
  attachmentsReceiptId: null,
  sourceReceiptId: null,
  sourceCode: null,
  ...over,
});

// Three things end up in one list and they are not the same work: an engineer's report of damage, a
// fault found here, and a loss. The old panel showed the difference only by whether a job number
// happened to be present, which reads as an accident rather than a distinction.
describe("sourceOf", () => {
  it("calls an engineer's report what it is", () => {
    expect(sourceOf(exit({ jobNumber: "JOB-2026-0041" }))).toBe("job");
  });

  it("calls damage with no job behind it a warehouse find", () => {
    expect(sourceOf(exit())).toBe("here");
  });

  it("never files a loss under damage, whatever job it came off", () => {
    // A loss is not a fault on equipment somebody can look at, and grouping it with damage is what
    // put "1 declared lost" under a heading about broken kit.
    expect(sourceOf(exit({ kind: "loss", custodyState: "lost", jobNumber: "JOB-2026-0041" }))).toBe("loss");
  });
});

// The header count, the row tag and the row's action all read this. Three readings of "is there work
// here" that could disagree is how a panel ends up saying "1 to charge" over a list with no button.
describe("isOpen", () => {
  it("is work while nobody has put it to the provider", () => {
    expect(isOpen(exit())).toBe(true);
  });

  it("is not work once it has been charged or dismissed", () => {
    expect(isOpen(exit({ settlementState: "settled" }))).toBe(false);
    expect(isOpen(exit({ settlementState: "dismissed" }))).toBe(false);
  });

  it("is not work when the report was withdrawn — it never happened", () => {
    expect(isOpen(exit({ custodyState: "withdrawn" }))).toBe(false);
  });

  it("is not work when a lost unit turned up — nothing is owed for it", () => {
    expect(isOpen(exit({ kind: "loss", custodyState: "recovered" }))).toBe(false);
  });
});
