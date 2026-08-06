import { describe, expect, it } from "vitest";

import { lineStatus, type StatusKitLine } from "./lineStatus";

const line = (over: Partial<StatusKitLine> = {}): StatusKitLine =>
  ({ lineType: "irm", plannedQty: 6, issuedQty: 0, usedQty: 0, ...over });

describe("lineStatus — the ordinary lifecycle", () => {
  it("is not issued until something goes out", () => {
    expect(lineStatus(line(), "not_issued", 0, 0)).toBe("not_issued");
  });

  it("is partial while some of the line is still to be collected", () => {
    expect(lineStatus(line({ issuedQty: 3 }), "partially_issued", 0, 0)).toBe("partially_issued");
  });

  // Out with the engineer, who is still working — not something the warehouse is waiting on yet.
  it("is issued once the whole line has gone out", () => {
    expect(lineStatus(line({ issuedQty: 6 }), "issued", 0, 0)).toBe("issued");
  });

  it("becomes awaiting return once the job is in the return phase and stock is still held", () => {
    expect(lineStatus(line({ issuedQty: 6 }), "awaiting_return", 0, 6)).toBe("awaiting_return");
  });

  it("settles to returned / used once nothing is held", () => {
    expect(lineStatus(line({ issuedQty: 6 }), "awaiting_return", 6, 0)).toBe("returned");
    expect(lineStatus(line({ issuedQty: 6, usedQty: 6 }), "awaiting_return", 0, 0)).toBe("used");
  });

  it("treats misc as issuance-only", () => {
    expect(lineStatus(line({ lineType: "misc", issuedQty: 6 }), "awaiting_return", 0, 6)).toBe("issued");
  });
});

// "Partial" reads as "the rest is still to come". On a cancelled job the rest is never coming: issuing
// is refused outright and the pending handovers are withdrawn on cancel. So a half-collected line was
// being labelled as outstanding warehouse work when its only remaining move is BACK.
describe("lineStatus — a cancelled job is never 'partial'", () => {
  const halfCollected = () => line({ plannedQty: 6, issuedQty: 3 });

  it("reads as awaiting return, not partial, while the engineer still holds it", () => {
    expect(lineStatus(halfCollected(), "awaiting_return", 0, 3)).toBe("partially_issued");
    expect(lineStatus(halfCollected(), "awaiting_return", 0, 3, true)).toBe("awaiting_return");
  });

  it("settles the same way once the stock is back", () => {
    expect(lineStatus(halfCollected(), "awaiting_return", 3, 0, true)).toBe("returned");
    expect(lineStatus(line({ plannedQty: 6, issuedQty: 3, usedQty: 3 }), "awaiting_return", 0, 0, true)).toBe("used");
  });

  // Belt and braces: openReturnsOnCancel is best-effort, so a cancelled job could in principle still
  // be sitting at "issued". "Issued" is then the honest label — the stock IS out — and never "Partial".
  it("says issued, not partial, if the job never reached the return phase", () => {
    expect(lineStatus(halfCollected(), "issued", 0, 3, true)).toBe("issued");
  });

  // A line nothing ever went out against is still not issued — no amount of cancelling changes that,
  // and those lines are filtered out of the queue anyway (see kitLineVisibility).
  it("leaves a never-issued line alone", () => {
    expect(lineStatus(line(), "awaiting_return", 0, 0, true)).toBe("not_issued");
  });

  it("does not change a live job", () => {
    expect(lineStatus(halfCollected(), "awaiting_return", 0, 3, false)).toBe("partially_issued");
  });
});
