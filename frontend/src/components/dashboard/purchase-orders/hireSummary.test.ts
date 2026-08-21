import { describe, expect, it } from "vitest";

import { hireSummary } from "./poStatus";

// The fact `po.status` cannot carry. "Fully Received" means every unit turned up and stays true
// forever; a hire then has to go BACK, so an order whose kit was returned days ago read "Fully
// Received" at the top with nothing beside it, and the only word saying otherwise was a small badge
// inside the rental table.

const line = (over: Partial<Parameters<typeof hireSummary>[0][number]> = {}) => ({
  hireStatus: "on_hire",
  quantity: 5,
  receivedQuantity: 5,
  returnedQuantity: 0,
  hireEndDate: "2026-08-22T00:00:00.000Z",
  ...over,
});

describe("the hire state chip", () => {
  // A goods-only order has nothing to say here, and an empty chip is worse than no chip.
  it("says nothing about an order with no hires", () => {
    expect(hireSummary([])).toBeNull();
  });

  it("says the kit is back once every hire is returned", () => {
    expect(hireSummary([line({ hireStatus: "returned" }), line({ hireStatus: "returned" })])).toEqual({
      label: "Hire returned",
      tone: "done",
    });
  });

  // One line still out is enough — the order is not finished, whatever the others did.
  it("reports still-out kit even when other lines are back", () => {
    const s = hireSummary([line({ hireStatus: "returned" }), line({ quantity: 3, receivedQuantity: 3 })]);
    expect(s?.tone).toBe("live");
    expect(s?.label).toContain("3 of 8");
  });

  // UNITS, not lines: an order can carry one line of five testers, and "1 of 1" would be a lie about
  // what is standing in the yard.
  it("counts units held, not lines", () => {
    expect(hireSummary([line({ returnedQuantity: 2 })])?.label).toContain("3 of 5");
  });

  // A reversal can give returned units back, and bad data must not print a negative.
  it("never reports negative units held", () => {
    expect(hireSummary([line({ receivedQuantity: 1, returnedQuantity: 4 })])?.label).toContain("0 of 5");
  });

  // The SOONEST deadline among the lines actually out — the one that matters first. Lines already
  // back cannot supply it.
  it("names the earliest deadline of the hires that are still out", () => {
    const s = hireSummary([
      line({ hireStatus: "returned", hireEndDate: "2026-01-01T00:00:00.000Z" }),
      line({ hireEndDate: "2026-09-30T00:00:00.000Z" }),
      line({ hireEndDate: "2026-08-22T00:00:00.000Z" }),
    ]);
    expect(s?.label).toContain("22");
    expect(s?.label).not.toContain("2026-01");
  });

  it("says so when nothing has arrived yet", () => {
    expect(hireSummary([line({ hireStatus: "awaiting_delivery", receivedQuantity: 0 })])).toEqual({
      label: "Hire awaiting delivery",
      tone: "wait",
    });
  });

  // Whether a hire is OVERDUE is decided server-side in the company timezone, by the same predicate
  // the attention badges count. Re-deciding it here from the browser clock is how a chip and a badge
  // come to disagree by a day — so this states the date and no judgement.
  it("states a date, never a verdict", () => {
    const label = hireSummary([line({ hireEndDate: "2020-01-01T00:00:00.000Z" })])?.label ?? "";
    expect(label).not.toMatch(/overdue|late|days? over/i);
  });
});

// ── Written-off units ───────────────────────────────────────────────────────────────────────────
//
// This summary predates `cancelled`, and both halves of it were left describing a world with three
// hire states. A short close writes units off; nothing here read that column, so the chip kept
// promising a delivery that had been formally abandoned.
describe("hireSummary and units nobody is waiting for", () => {
  // "4 of 5" says one more is coming. It is not: it was written off, with a reason, on the record.
  // The honest denominator is what the hire will EVER hold — and once it equals what is held, the
  // denominator is dropped entirely (see the block below), so the fix shows up as the ABSENCE of a
  // "of 5" rather than as a "4 of 4".
  it("counts the ordered total net of what was written off", () => {
    expect(
      hireSummary([line({ quantity: 5, receivedQuantity: 4, returnedQuantity: 0, cancelledQuantity: 1 })])!.label,
    ).not.toContain("of 5");
  });

  it("leaves an ordinary part-delivered hire reading as short", () => {
    expect(
      hireSummary([line({ quantity: 5, receivedQuantity: 4, returnedQuantity: 0, cancelledQuantity: 0 })])!.label,
    ).toContain("4 of 5");
  });

  // A hire nothing ever arrived against is FINISHED, not waiting. Falling through to "awaiting
  // delivery" told the reader to expect equipment that is never coming — the exact confusion the
  // fourth state exists to remove.
  it("calls a cancelled hire cancelled, not awaiting delivery", () => {
    const s = hireSummary([line({ hireStatus: "cancelled", receivedQuantity: 0, cancelledQuantity: 5 })])!;
    expect(s.label).toBe("Hire cancelled");
    expect(s.tone).toBe("done");
  });

  // Mixed terminal states: one went back, one never came. Neither is pending, so neither reading is
  // "awaiting" — and `every(returned)` was false, which is how it got there.
  it("calls a mixed finished order finished", () => {
    const s = hireSummary([
      line({ hireStatus: "returned", returnedQuantity: 5 }),
      line({ hireStatus: "cancelled", receivedQuantity: 0, cancelledQuantity: 5 }),
    ])!;
    expect(s.tone).toBe("done");
    expect(s.label).not.toMatch(/awaiting/i);
  });

  it("still says awaiting while a hire genuinely has not arrived", () => {
    const s = hireSummary([line({ hireStatus: "awaiting_delivery", receivedQuantity: 0 })])!;
    expect(s.label).toBe("Hire awaiting delivery");
    expect(s.tone).toBe("wait");
  });
});

// ── "of N" earns its place, or it is not there ──────────────────────────────────────────────────
//
// The denominator says ONE thing: some units are not with us. When they all are, it says nothing and
// costs a reader two numbers to compare instead of one to read. Every other quantity on this module's
// screens already works this way — the warehouse queue only writes "of 5 · 4 already here" once some
// have arrived, the on-hire row only writes "2 here" once they differ, "1 cancelled" only once there
// is a cancellation. The chip was the one place that printed it unconditionally.
describe("hireSummary drops the denominator when nothing is missing", () => {
  it("reads as a plain count when every unit is with us", () => {
    expect(hireSummary([line({ quantity: 5, receivedQuantity: 5, returnedQuantity: 0 })])!.label).toBe(
      "On hire · 5 · due 22 Aug 2026",
    );
  });

  // A short close makes held equal the net total, so the same rule applies — and this is the case
  // that read "4 of 4" and sent a reader looking for a fifth unit that had been written off.
  it("reads as a plain count once the shortfall is written off", () => {
    expect(
      hireSummary([line({ quantity: 5, receivedQuantity: 4, returnedQuantity: 0, cancelledQuantity: 1 })])!.label,
    ).toBe("On hire · 4 · due 22 Aug 2026");
  });

  it("still says `of N` while units are genuinely elsewhere", () => {
    expect(hireSummary([line({ quantity: 5, receivedQuantity: 4, returnedQuantity: 0 })])!.label).toContain("4 of 5");
    expect(hireSummary([line({ quantity: 5, receivedQuantity: 5, returnedQuantity: 3 })])!.label).toContain("2 of 5");
  });

  // Against the NET total, so a partly-returned short-closed hire counts against what it will ever
  // hold — "2 of 5" would have a reader hunting three units when only two went back.
  it("measures what is missing against the net total, not the original order", () => {
    expect(
      hireSummary([line({ quantity: 5, receivedQuantity: 4, returnedQuantity: 2, cancelledQuantity: 1 })])!.label,
    ).toContain("2 of 4");
  });
});

// The chip is the ANSWER; the order's own lines are the arithmetic. On the detail page the chip sits
// directly above a line reading "5 Each · 4 received · 1 cancelled", and a reader should not have to
// reconcile 4 against 5 in their head. The hover says how they add up, at no cost to the layout.
describe("hireSummary explains itself on hover", () => {
  it("spells out the whole sum when units were written off", () => {
    expect(
      hireSummary([line({ quantity: 5, receivedQuantity: 4, returnedQuantity: 0, cancelledQuantity: 1 })])!.title,
    ).toBe("5 ordered · 1 written off · 4 on hire");
  });

  it("says what went back when some has", () => {
    expect(hireSummary([line({ quantity: 5, receivedQuantity: 5, returnedQuantity: 3 })])!.title).toBe(
      "5 ordered · 3 back · 2 on hire",
    );
  });

  // `back` was once inferred as `ordered - held`, which also swallowed everything the supplier had
  // not sent yet and reported it as returned kit. Every case above happens to be fully received, so
  // the subtraction agreed with the truth and the lie only showed on a part delivery.
  it("does not report units that never arrived as having come back", () => {
    expect(hireSummary([line({ quantity: 5, receivedQuantity: 2, returnedQuantity: 0 })])!.title).toBe(
      "5 ordered · 3 not yet delivered · 2 on hire",
    );
  });

  it("tells units still to arrive apart from units already back", () => {
    expect(hireSummary([line({ quantity: 5, receivedQuantity: 3, returnedQuantity: 1 })])!.title).toBe(
      "5 ordered · 2 not yet delivered · 1 back · 2 on hire",
    );
  });

  // Nothing to explain — an unqualified count is its own explanation, and a tooltip repeating the
  // label is noise a reader learns to ignore.
  it("has no tooltip when the label already says everything", () => {
    expect(hireSummary([line({ quantity: 5, receivedQuantity: 5, returnedQuantity: 0 })])!.title).toBeUndefined();
  });
});
