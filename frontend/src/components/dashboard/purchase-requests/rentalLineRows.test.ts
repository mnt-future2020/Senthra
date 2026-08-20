import { describe, expect, it } from "vitest";

import {
  agreedUnitPrice,
  applyBasisChange,
  billablePeriods,
  blankRentalLine,
  calculatedUnitPrice,
  capNotifyLead,
  duplicateRentalRowKeys,
  hireRangeError,
  MAX_NOTIFY_DAYS,
  notifyLeadMax,
  RATE_PERIOD_OPTIONS,
  reminderDate,
  RETURN_MODE_OPTIONS,
  returnModeOptions,
  hireDateNotice,
  rentalSubtotalPence,
  rowHireDays,
  toRentalPayload,
  validateRentalLines,
} from "./rentalLineRows";

const OID = "6a1d7f5bfa7d25704f02b963";
const row = (over: Partial<ReturnType<typeof blankRentalLine>> = {}) => ({
  ...blankRentalLine(),
  rentalItemId: OID,
  quantity: "1",
  hireStartDate: "2026-09-01",
  hireEndDate: "2026-10-01",
  unitPrice: "150.00",
  ...over,
});

describe("validateRentalLines", () => {
  it("passes a well-formed row", () => {
    expect(validateRentalLines([row()])).toBeUndefined();
  });

  // A spare blank row is how the grid works — it must never be validated.
  it("ignores rows with no item picked", () => {
    expect(validateRentalLines([blankRentalLine()])).toBeUndefined();
  });

  it("catches an end date before or equal to the start", () => {
    expect(validateRentalLines([row({ hireEndDate: "2026-08-01" })])).toMatch(/after the start date/i);
    expect(validateRentalLines([row({ hireEndDate: "2026-09-01" })])).toMatch(/after the start date/i);
  });

  it("catches a missing date", () => {
    expect(validateRentalLines([row({ hireStartDate: "" })])).toMatch(/hire start date/i);
    expect(validateRentalLines([row({ hireEndDate: "" })])).toMatch(/hire end date/i);
  });

  it("catches quantity below one and a negative price", () => {
    expect(validateRentalLines([row({ quantity: "0" })])).toMatch(/at least 1/i);
    expect(validateRentalLines([row({ unitPrice: "-1" })])).toMatch(/can't be negative/i);
  });

  it("catches VAT outside 0–100 and a reminder lead outside 0–365", () => {
    expect(validateRentalLines([row({ vatRate: "101" })])).toMatch(/0–100/);
    expect(validateRentalLines([row({ notifyDaysBefore: "400" })])).toMatch(/between 0 and 365/i);
  });

  it("catches an address over 300 characters", () => {
    expect(validateRentalLines([row({ deliveryAddress: "x".repeat(301) })])).toMatch(/too long/i);
  });

  // The server CLAMPS a lead longer than the hire rather than refusing it — so must this, or the
  // form would block a request the API would happily accept.
  it("accepts a reminder lead longer than the hire", () => {
    expect(validateRentalLines([row({ hireEndDate: "2026-09-03", notifyDaysBefore: "5" })])).toBeUndefined();
  });

  // The same triple the DB's compound unique index refuses.
  it("catches an identical item, period and address twice", () => {
    expect(validateRentalLines([row(), row()])).toMatch(/only be added once/i);
  });

  it("allows the same item twice with different periods", () => {
    expect(validateRentalLines([row(), row({ hireEndDate: "2026-09-08" })])).toBeUndefined();
  });

  it("allows the same item and period to two different addresses", () => {
    expect(
      validateRentalLines([row({ deliveryAddress: "Site A" }), row({ deliveryAddress: "Site B" })]),
    ).toBeUndefined();
  });

  // Price is what a hire COSTS, not what it is. Two lines differing only in basis are one delivery and
  // one collection billed twice — and they would collide on the DB's unique index, and pair the wrong
  // before with the wrong after in the audit diff, which keys lines by the same composite.
  it("still catches a duplicate when only the pricing basis differs", () => {
    expect(
      validateRentalLines([
        row({ ratePeriod: "day", rate: "1" }),
        row({ ratePeriod: "month", rate: "1" }),
      ]),
    ).toMatch(/only be added once/i);
  });

  // The mistake this fires on is nearly always "but I DID change something" — so the message says
  // which somethings don't count.
  it("names the fields that do not make a line separate", () => {
    expect(validateRentalLines([row(), row()])).toMatch(/pricing basis, rate and return details/i);
  });
});

// Said on the row, not only in the banner under the section — with four hire lines on screen the
// banner announces that something is duplicated and leaves the reader to work out which two.
describe("duplicateRentalRowKeys", () => {
  const keyed = (over = {}) => ({ ...row(), _key: "k", ...over });

  it("marks the SECOND of a pair and not the first", () => {
    const a = keyed({ _key: "first" });
    const b = keyed({ _key: "second" });
    expect([...duplicateRentalRowKeys([a, b])]).toEqual(["second"]);
  });

  it("marks every repeat after the first", () => {
    const rows = [keyed({ _key: "a" }), keyed({ _key: "b" }), keyed({ _key: "c" })];
    expect([...duplicateRentalRowKeys(rows)]).toEqual(["b", "c"]);
  });

  it("marks nothing when the period or the address differs", () => {
    expect(duplicateRentalRowKeys([keyed({ _key: "a" }), keyed({ _key: "b", hireEndDate: "2026-09-08" })]).size).toBe(0);
    expect(duplicateRentalRowKeys([keyed({ _key: "a" }), keyed({ _key: "b", deliveryAddress: "Site B" })]).size).toBe(0);
  });

  it("marks a row whose only difference is the pricing basis or price", () => {
    const rows = [keyed({ _key: "a", ratePeriod: "day" as const, rate: "1" }), keyed({ _key: "b", unitPrice: "999" })];
    expect([...duplicateRentalRowKeys(rows)]).toEqual(["b"]);
  });

  // The server trims and turns "" into null before it compares, so an address differing only in
  // spaces is the same address on both sides of the wire.
  it("ignores surrounding whitespace in the address", () => {
    const rows = [keyed({ _key: "a", deliveryAddress: "Site A" }), keyed({ _key: "b", deliveryAddress: "  Site A  " })];
    expect([...duplicateRentalRowKeys(rows)]).toEqual(["b"]);
  });

  // An empty row is a row someone is still filling in, not a duplicate of another empty one.
  it("ignores rows with no item picked", () => {
    const rows = [keyed({ _key: "a", rentalItemId: "" }), keyed({ _key: "b", rentalItemId: "" })];
    expect(duplicateRentalRowKeys(rows).size).toBe(0);
  });

  // The banner and the row marker must agree to the letter: one of them saying nothing while the
  // other refuses the submit is the failure mode this shares a key function to avoid.
  it("agrees with validateRentalLines about which rows collide", () => {
    const rows = [keyed({ _key: "a" }), keyed({ _key: "b" })];
    expect(duplicateRentalRowKeys(rows).size).toBe(1);
    expect(validateRentalLines(rows)).toMatch(/only be added once/i);
    const distinct = [keyed({ _key: "a" }), keyed({ _key: "b", hireStartDate: "2026-08-01" })];
    expect(duplicateRentalRowKeys(distinct).size).toBe(0);
    expect(validateRentalLines(distinct)).toBeUndefined();
  });
});

describe("rowHireDays", () => {
  it("counts whole days once both dates are set", () => {
    expect(rowHireDays(row())).toBe(30);
  });

  it("is null while a date is missing", () => {
    expect(rowHireDays(row({ hireEndDate: "" }))).toBeNull();
  });
});

describe("toRentalPayload", () => {
  it("converts pounds to pence and drops empty rows", () => {
    expect(toRentalPayload([row({ unitPrice: "150.00" }), blankRentalLine()])).toEqual([
      expect.objectContaining({ unitPricePence: 15000, quantity: 1 }),
    ]);
  });

  it("sends no delivery address when the field was left blank", () => {
    expect(toRentalPayload([row({ deliveryAddress: "  " })])[0]).not.toHaveProperty("deliveryAddress");
  });

  it("sends a multiline address as typed", () => {
    expect(toRentalPayload([row({ deliveryAddress: "Unit 4\nLeeds" })])[0]!.deliveryAddress).toBe("Unit 4\nLeeds");
  });

  // Server-computed. Sending either invites the stored total to drift from its own line.
  it("never sends a line total or a notify date", () => {
    const p = toRentalPayload([row()])[0] as unknown as Record<string, unknown>;
    expect(p.lineTotalPence).toBeUndefined();
    expect(p.notifyOnDate).toBeUndefined();
  });

  it("rounds pounds to whole pence", () => {
    expect(toRentalPayload([row({ unitPrice: "10.005" })])[0]!.unitPricePence).toBe(1001);
  });
});

describe("rentalSubtotalPence", () => {
  it("sums quantity x price across filled rows only", () => {
    expect(rentalSubtotalPence([row({ quantity: "2", unitPrice: "150.00" }), blankRentalLine()])).toBe(30000);
  });

  it("is zero for an empty grid", () => {
    expect(rentalSubtotalPence([blankRentalLine()])).toBe(0);
  });
});


// Back-dating is legitimate — kit went out last week, the paperwork is catching up — so this NEVER
// blocks. It exists because the alternative is silent: a mistyped year produces an order that is
// overdue the moment it exists, on the red badge, with its reminder already due.
describe("hireDateNotice — the non-blocking past-date warning", () => {
  const TODAY = "2026-08-14";
  const period = (from: string, to: string) => ({ ...row(), hireStartDate: from, hireEndDate: to });

  it("says nothing about a hire that starts today", () => {
    expect(hireDateNotice(period(TODAY, "2026-09-30"), TODAY)).toBeUndefined();
  });

  it("says nothing about a future hire", () => {
    expect(hireDateNotice(period("2026-09-01", "2026-09-30"), TODAY)).toBeUndefined();
  });

  it("flags a hire that has already started but is still running", () => {
    expect(hireDateNotice(period("2026-08-01", "2026-09-30"), TODAY)).toMatch(/already started/i);
  });

  // The stronger case: this one lands straight on the overdue badge.
  it("flags a period that has already ENDED, and says why it matters", () => {
    expect(hireDateNotice(period("2026-08-01", "2026-08-10"), TODAY)).toMatch(/already ended.*overdue/i);
  });

  it("prefers the ended message over the started one — a finished hire is both", () => {
    expect(hireDateNotice(period("2026-08-01", "2026-08-10"), TODAY)).not.toMatch(/already started/i);
  });

  it("stays quiet while the dates are still being typed", () => {
    expect(hireDateNotice({ ...row(), hireStartDate: "", hireEndDate: "" }, TODAY)).toBeUndefined();
    expect(hireDateNotice(period("not-a-date", "2026-09-30"), TODAY)).toBeUndefined();
  });
});


// The return leg. A MODE, not an optional address: an optional box is blank on nearly every line,
// and a blank answers nothing — which is the state this replaces.
describe("the return-at-end-of-hire mode", () => {
  it("defaults to the delivery address, so the common line needs no thought", () => {
    expect(blankRentalLine().returnMode).toBe("delivery");
  });

  it("offers exactly the three the server accepts", () => {
    expect(RETURN_MODE_OPTIONS.map((o) => o.value)).toEqual(["delivery", "warehouse", "other"]);
  });

  // "Collect from warehouse" never said WHICH warehouse — and on a line delivered to a site, the depot
  // is nowhere in the row to be read off.
  it("names the selected warehouse in the collect option", () => {
    const opts = returnModeOptions("test work");
    expect(opts.map((o) => o.label)).toEqual([
      "Same as delivery",
      "Collect from warehouse (test work)",
      "Other address…",
    ]);
    // The values are the contract with the server — a label change must never touch them.
    expect(opts.map((o) => o.value)).toEqual(["delivery", "warehouse", "other"]);
  });

  it("keeps the plain label until a warehouse is chosen", () => {
    expect(returnModeOptions(null)).toEqual(RETURN_MODE_OPTIONS);
    expect(returnModeOptions("   ")).toEqual(RETURN_MODE_OPTIONS);
  });

  // A depot with a long name must not stretch the select past its column.
  it("truncates a long warehouse name", () => {
    const label = returnModeOptions("Manchester Central Distribution Depot")[1].label;
    expect(label).toBe("Collect from warehouse (Manchester Central Di…)");
    expect(label.length).toBeLessThan("Collect from warehouse (Manchester Central Distribution Depot)".length);
  });

  it("refuses OTHER with no address — word for word the server's message", () => {
    const rows = [{ ...row(), returnMode: "other" as const, returnAddress: "" }];
    expect(validateRentalLines(rows)).toBe("Enter the address the hire is collected from.");
  });

  it("accepts OTHER once an address is typed", () => {
    const rows = [{ ...row(), returnMode: "other" as const, returnAddress: "Yard 7" }];
    expect(validateRentalLines(rows)).toBeUndefined();
  });

  it("bounds the address like the delivery one", () => {
    const rows = [{ ...row(), returnMode: "other" as const, returnAddress: "x".repeat(301) }];
    expect(validateRentalLines(rows)).toMatch(/too long/i);
  });

  it("sends the mode always, and the address ONLY with the mode that uses it", () => {
    const [kept] = toRentalPayload([{ ...row(), returnMode: "other", returnAddress: " Yard 7 " }]);
    expect(kept).toMatchObject({ returnMode: "other", returnAddress: "Yard 7" });

    // Switched away from "other": the stale address must not travel, or the stored line and the
    // mode it is filed under disagree.
    const [dropped] = toRentalPayload([{ ...row(), returnMode: "warehouse", returnAddress: "Yard 7" }]);
    expect(dropped.returnMode).toBe("warehouse");
    expect(dropped.returnAddress).toBeUndefined();
  });
});


// The picker used to let you choose an end date BEFORE the start; nothing said so until Create draft,
// and then it was one banner under a section holding three hire lines. This is the same rule, on the
// row it belongs to.
describe("hireRangeError — said on the row, not in a banner", () => {
  const period = (from: string, to: string) => ({ ...row(), hireStartDate: from, hireEndDate: to });

  it("flags an end date BEFORE the start", () => {
    expect(hireRangeError(period("2026-08-17", "2026-08-16"))).toBe("The hire end date must be after the start date.");
  });

  // A same-day hire is not a hire — and it is the exact case the server also refuses.
  it("flags an end date EQUAL to the start", () => {
    expect(hireRangeError(period("2026-08-17", "2026-08-17"))).toBeDefined();
  });

  it("says nothing about a valid period", () => {
    expect(hireRangeError(period("2026-08-17", "2026-08-18"))).toBeUndefined();
  });

  it("stays quiet while a date is still empty", () => {
    expect(hireRangeError({ ...row(), hireStartDate: "2026-08-17", hireEndDate: "" })).toBeUndefined();
    expect(hireRangeError({ ...row(), hireStartDate: "", hireEndDate: "2026-08-16" })).toBeUndefined();
  });

  // Word for word what validateRentalLines and the server say, so one rule never reads two ways.
  it("uses the same wording as the blocking validator", () => {
    const rows = [period("2026-08-17", "2026-08-16")];
    expect(validateRentalLines(rows)).toBe(hireRangeError(rows[0]!));
  });
});


// "3" beside a date field answers "three days before what?" only if you already know. The row shows
// the DAY the reminder lands on, so the lead needs no explaining.
describe("reminderDate — the day the row promises", () => {
  const period = (from: string, to: string, lead: string) => ({ ...row(), hireStartDate: from, hireEndDate: to, notifyDaysBefore: lead });
  const iso = (d: Date | null) => d?.toISOString().slice(0, 10);

  it("counts back from the END date", () => {
    expect(iso(reminderDate(period("2026-09-01", "2026-10-01", "3")))).toBe("2026-09-28");
  });

  it("lands ON the end date when the lead is zero", () => {
    expect(iso(reminderDate(period("2026-09-01", "2026-10-01", "0")))).toBe("2026-10-01");
  });

  // The server clamps rather than refusing — the lead defaults to 3, so a two-day hire would
  // otherwise be unsavable. The form must show the same day the server will store.
  it("clamps to the START when the lead is longer than the hire", () => {
    expect(iso(reminderDate(period("2026-09-01", "2026-09-02", "30")))).toBe("2026-09-01");
  });

  // Clearing the box does not mean "on the day" — the field is optional on the wire and the server
  // stores its default, so the row has to promise the day that will really be stored.
  it("uses the server's default when the box is cleared", () => {
    expect(iso(reminderDate(period("2026-09-01", "2026-10-01", "")))).toBe("2026-09-28");
  });

  it("says nothing while the row is incomplete or impossible", () => {
    expect(reminderDate(period("", "2026-10-01", "3"))).toBeNull();
    expect(reminderDate(period("2026-10-01", "2026-09-01", "3"))).toBeNull();
    expect(reminderDate(period("2026-09-01", "2026-10-01", "x"))).toBeNull();
  });

  // Rather than EXPLAINING a lead the hire can't honour, the box can't offer one — the treatment
  // Hire end's `min` gives an impossible date and the kit-request modal gives an impossible quantity.
  describe("the lead the hire can honour", () => {
    it("ceilings the box at the hire's own length", () => {
      expect(notifyLeadMax(2)).toBe(2);
      expect(notifyLeadMax(30)).toBe(30);
    });

    // Never cap on a guess: with no usable range there is nothing to measure against.
    it("leaves the wire's 365 in place while the dates are unknown", () => {
      expect(notifyLeadMax(null)).toBe(MAX_NOTIFY_DAYS);
      expect(notifyLeadMax(0)).toBe(MAX_NOTIFY_DAYS);
    });

    it("never offers more than the wire accepts, however long the hire", () => {
      expect(notifyLeadMax(900)).toBe(MAX_NOTIFY_DAYS);
      expect(capNotifyLead("900", 900)).toBe("365");
    });

    it("caps a lead longer than the hire", () => {
      expect(capNotifyLead("30", 2)).toBe("2");
    });

    // A lead landing EXACTLY on the start date is what was asked for — two days before the end of a
    // two-day hire is day one — so it is not capped.
    it("leaves a lead that fits exactly alone", () => {
      expect(capNotifyLead("2", 2)).toBe("2");
      expect(capNotifyLead("0", 2)).toBe("0");
    });

    // A value that already fits is returned UNTOUCHED — reformatting "03" under someone mid-edit is
    // its own bug.
    it("does not reformat a value it accepts", () => {
      expect(capNotifyLead("03", 30)).toBe("03");
    });

    it("leaves a blank box blank — that means the server's default, not a number", () => {
      expect(capNotifyLead("", 1)).toBe("");
      expect(capNotifyLead("  ", 1)).toBe("  ");
    });

    it("leaves garbage for validateRentalLines to speak about", () => {
      expect(capNotifyLead("x", 2)).toBe("x");
    });

    it("does not cap while the dates cannot say how long the hire is", () => {
      expect(capNotifyLead("30", null)).toBe("30");
    });

    // The number on screen and the number in the body are the same by construction. Sending the
    // larger one would store a lead the form never showed, and the field would change value on the
    // next load.
    it("sends the lead the BOX shows, not the one behind it", () => {
      const [payload] = toRentalPayload([
        row({ rentalItemId: OID, hireStartDate: "2026-09-01", hireEndDate: "2026-09-03", notifyDaysBefore: "30" }),
      ]);
      expect(payload.notifyDaysBefore).toBe(2);
    });

    // The date is identical either way — which is why capping costs nothing. The server clamps a lead
    // this long to the start date; the cap arrives at that same day from the other direction.
    it("agrees with the date the row already promised", () => {
      const short = period("2026-09-01", "2026-09-03", "30");
      expect(iso(reminderDate(short))).toBe("2026-09-01");
      expect(iso(reminderDate({ ...short, notifyDaysBefore: capNotifyLead("30", 2) }))).toBe("2026-09-01");
    });
  });
});


// The same table of cases the server's rental-pricing module is tested against. The two must agree:
// the form shows a figure, the server stores one, and a user who sees £2,475 and gets £2,585 saved
// has been lied to by whichever side is wrong.
describe("pricing basis — mirrors the server's rules", () => {
  const line = (over: Partial<ReturnType<typeof blankRentalLine>>) => ({
    ...row(),
    hireStartDate: "2026-08-17",
    hireEndDate: "2026-10-01", // 45 days
    ...over,
  });

  it("offers exactly the four bases the server accepts", () => {
    expect(RATE_PERIOD_OPTIONS.map((o) => o.value)).toEqual(["total", "day", "week", "month"]);
  });

  it("defaults to the whole-hire figure, so today's lines are unchanged", () => {
    expect(blankRentalLine().ratePeriod).toBe("total");
    expect(blankRentalLine().priceOverridden).toBe(false);
  });

  it("counts days, whole weeks and CALENDAR months", () => {
    expect(billablePeriods(line({ ratePeriod: "day" }))).toBe(45);
    expect(billablePeriods(line({ ratePeriod: "week" }))).toBe(7); // ceil(45 / 7)
    expect(billablePeriods(line({ ratePeriod: "month" }))).toBe(2); // 17 Aug → 17 Sep, then part
  });

  // `ceil(days / 30)` would bill two months for a whole 31-day month.
  it("charges ONE month for 1 Jan → 1 Feb", () => {
    expect(billablePeriods(line({ ratePeriod: "month", hireStartDate: "2026-01-01", hireEndDate: "2026-02-01" }))).toBe(1);
    expect(billablePeriods(line({ ratePeriod: "month", hireStartDate: "2026-01-01", hireEndDate: "2026-02-02" }))).toBe(2);
  });

  it("clamps the anniversary into a short month, leap year included", () => {
    expect(billablePeriods(line({ ratePeriod: "month", hireStartDate: "2026-01-31", hireEndDate: "2026-02-28" }))).toBe(1);
    expect(billablePeriods(line({ ratePeriod: "month", hireStartDate: "2028-01-31", hireEndDate: "2028-02-29" }))).toBe(1);
  });

  it("multiplies the rate by the periods", () => {
    expect(calculatedUnitPrice(line({ ratePeriod: "day", rate: "55" }))).toBe(2475);
    expect(calculatedUnitPrice(line({ ratePeriod: "week", rate: "300" }))).toBe(2100);
    expect(calculatedUnitPrice(line({ ratePeriod: "month", rate: "900" }))).toBe(1800);
  });

  it("calculates nothing without a usable rate, or on the total basis", () => {
    expect(calculatedUnitPrice(line({ ratePeriod: "day", rate: "" }))).toBeNull();
    expect(calculatedUnitPrice(line({ ratePeriod: "day", rate: "-5" }))).toBeNull();
    expect(calculatedUnitPrice(line({ ratePeriod: "total", rate: "55" }))).toBeNull();
  });

  it("saves the CALCULATED price on a rate basis", () => {
    expect(agreedUnitPrice(line({ ratePeriod: "day", rate: "55", unitPrice: "1" }))).toBe(2475);
  });

  // A negotiated price is a commercial fact, not arithmetic.
  it("saves the TYPED price once the line is overridden", () => {
    expect(agreedUnitPrice(line({ ratePeriod: "day", rate: "55", unitPrice: "2300", priceOverridden: true }))).toBe(2300);
  });

  it("saves the typed price on the total basis, override flag or not", () => {
    expect(agreedUnitPrice(line({ ratePeriod: "total", unitPrice: "55" }))).toBe(55);
  });

  it("refuses a rate basis with no rate — word for word the server's message", () => {
    expect(validateRentalLines([line({ ratePeriod: "day", rate: "" })])).toBe("Enter the rate for the chosen pricing basis.");
  });

  it("sends the rate in PENCE, and only with a basis that uses it", () => {
    const [byRate] = toRentalPayload([line({ ratePeriod: "day", rate: "55.50" })]);
    expect(byRate).toMatchObject({ ratePeriod: "day", ratePence: 5550 });
    // £55.50/day × 45 days, in pence — no floating point drift.
    expect(byRate.unitPricePence).toBe(249_750);

    const [byTotal] = toRentalPayload([line({ ratePeriod: "total", rate: "55", unitPrice: "165" })]);
    expect(byTotal.ratePence).toBeUndefined();
    expect(byTotal.unitPricePence).toBe(16_500);
  });
});

/**
 * Switching the pricing basis to "Total for hire period" must not silently blank the money.
 *
 * On a RATE basis the price box shows the CALCULATED figure while `unitPrice` itself stays "" —
 * it is only written when someone types over it. "Total" has no rate to derive from, so
 * `agreedUnitPrice` falls straight through to `Number("" || 0)`, and `validateRentalLines` skips
 * its price check whenever `unitPrice` is empty. A £55/day × 10-day line therefore saved at
 * `unitPricePence: 0` — with the switch itself being the only thing the user did.
 */
describe("switching the pricing basis", () => {
  it("carries the calculated figure into the price box when moving to a total", () => {
    const r = row({ ratePeriod: "day", rate: "55", unitPrice: "", hireStartDate: "2026-09-01", hireEndDate: "2026-09-11" });
    const next = { ...r, ...applyBasisChange(r, "total") };
    expect(next.unitPrice).toBe("550.00");
    expect(agreedUnitPrice(next)).toBe(550);
  });

  it("leaves the price box alone when the user had already typed one", () => {
    const r = row({ ratePeriod: "day", rate: "55", unitPrice: "480", priceOverridden: true });
    // The patch does not restate a value it is not changing, so assert on the merged row.
    expect({ ...r, ...applyBasisChange(r, "total") }.unitPrice).toBe("480");
  });

  // Nothing to carry over — the rate was never entered. The rule below is what stops it saving at 0.
  it("leaves the price box empty when there is no figure to carry", () => {
    const r = row({ ratePeriod: "day", rate: "", unitPrice: "" });
    expect({ ...r, ...applyBasisChange(r, "total") }.unitPrice).toBe("");
  });

  // Moving BACK to a rate basis re-derives from the rate, so a stale total must not linger as an
  // override — that is the existing `priceOverridden: false` reset, kept.
  it("clears the override when moving to a total", () => {
    expect(applyBasisChange(row({ priceOverridden: true }), "total").priceOverridden).toBe(false);
  });

  it("refuses a total basis with no price — the basis has no rate to fall back on", () => {
    expect(validateRentalLines([row({ ratePeriod: "total", rate: "", unitPrice: "" })])).toBe(
      "Enter the agreed price for the hire period.",
    );
  });

  // An explicit zero is a real answer (kit lent at no charge) and must survive the rule above.
  it("accepts an explicit zero on the total basis", () => {
    expect(validateRentalLines([row({ ratePeriod: "total", unitPrice: "0" })])).toBeUndefined();
  });
});
