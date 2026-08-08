import { describe, expect, it } from "vitest";

import { acceptedWording, lineSummary } from "./acceptedWording";

// The bug, as it was found: a CANCELLED receipt's footer read "Accepted into stock 1" while the
// Quality & inventory card on the same page read "Stock impact: None (cancelled)". Read together
// that says a unit entered stock and was then cancelled out of it — which cannot happen here, since
// a completed receipt has no transition to cancelled. Nothing had entered stock; only the verb was
// wrong. The NUMBER stays visible in every state; the claim about stock is what depends on status.

describe("acceptedWording", () => {
  it("promises nothing on a draft — completing is what posts stock", () => {
    const w = acceptedWording("draft");
    expect(w.total).toBe("To accept into stock");
    expect(w.column).toBe("To accept");
    expect(w.hint).toMatch(/nothing has been posted/i);
  });

  it("states it plainly once the receipt is completed", () => {
    expect(acceptedWording("completed").total).toBe("Accepted into stock");
    expect(acceptedWording("completed").column).toBe("Accepted");
  });

  // The one the screen got wrong.
  it("says NOT accepted on a cancelled receipt", () => {
    const w = acceptedWording("cancelled");
    expect(w.total).toBe("Not accepted into stock");
    expect(w.column).toBe("Not accepted");
    expect(w.hint).toMatch(/none of these units entered stock/i);
  });

  // The totals row renders "<label> <number>". A label carrying its own clause ("Not accepted —
  // receipt cancelled 1") strands the figure behind an em-dash and stops it reading as a number, so
  // the reason lives in the hint and every label ends on the same two words.
  it("keeps all three totals parallel, so the number always lands in the same place", () => {
    for (const status of ["draft", "completed", "cancelled"] as const) {
      const { total } = acceptedWording(status);
      expect(total.endsWith("into stock"), `"${total}" doesn't end on the figure`).toBe(true);
      expect(total).not.toMatch(/[—–:(]/);
    }
  });

  // A row of one-word headers (Ordered, Prev., Received, Damaged) — a three-word past-conditional
  // ("Was to accept") reads as grammar rather than as a column.
  it("keeps the column header to at most two words", () => {
    for (const status of ["draft", "completed", "cancelled"] as const) {
      expect(acceptedWording(status).column.split(" ").length).toBeLessThanOrEqual(2);
    }
  });

  it("only ever claims stock moved for a completed receipt", () => {
    for (const status of ["draft", "cancelled"] as const) {
      // "into stock" may appear, but never as a completed fact — the draft wording is future tense
      // ("To accept into stock") and the cancelled one is negated.
      expect(acceptedWording(status).total).not.toBe("Accepted into stock");
    }
  });

  // An unrecognised status must fall back to the unposted wording. Claiming stock moved when it may
  // not have is the failure worth defaulting away from.
  it("treats an unknown status as unfinished, not as posted", () => {
    expect(acceptedWording("something_new" as never).total).toBe("To accept into stock");
  });
});

describe("lineSummary", () => {
  it("uses the right verb for each status", () => {
    expect(lineSummary(2, 3, "completed")).toBe("2 lines · 3 accepted");
    expect(lineSummary(2, 3, "draft")).toBe("2 lines · 3 to accept");
    expect(lineSummary(2, 3, "cancelled")).toBe("2 lines · 3 not accepted");
  });

  it("keeps the line count singular for one line", () => {
    expect(lineSummary(1, 1, "completed")).toBe("1 line · 1 accepted");
  });

  // "0 accepted" beside a line count is noise, and on an empty draft it is the normal state.
  it("drops the tail when nothing is accepted", () => {
    expect(lineSummary(1, 0, "draft")).toBe("1 line");
    expect(lineSummary(3, 0, "cancelled")).toBe("3 lines");
  });
});
