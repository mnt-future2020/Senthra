import { describe, expect, it } from "vitest";

import {
  billableDays,
  billableMonths,
  billablePeriods,
  calculateUnitPricePence,
  extensionChargePence,
  RATE_PERIODS,
  rateBasisLabel,
} from "../rental-pricing.js";

// Money rules, so every case is spelled out rather than sampled. A wrong rounding rule here is not a
// visual bug — it is an invoice nobody can reconcile.

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("billableDays — the return date is not charged", () => {
  it("counts one day for a one-night hire", () => {
    expect(billableDays(day("2026-09-01"), day("2026-09-02"))).toBe(1);
  });

  it("counts ten days for a ten-day hire", () => {
    expect(billableDays(day("2026-09-01"), day("2026-09-11"))).toBe(10);
  });

  it("spans month ends without drifting", () => {
    // 14 left in August (17th→31st), 30 in September, 1 into October.
    expect(billableDays(day("2026-08-17"), day("2026-10-01"))).toBe(45);
  });
});

describe("weeks — a part week is a whole week", () => {
  const weeks = (from: string, to: string) => billablePeriods("week", day(from), day(to));

  it("charges one week for seven days or fewer", () => {
    expect(weeks("2026-09-01", "2026-09-08")).toBe(1);
    expect(weeks("2026-09-01", "2026-09-04")).toBe(1);
  });

  it("charges two weeks for eight", () => {
    expect(weeks("2026-09-01", "2026-09-09")).toBe(2);
  });

  it("charges two weeks for fourteen, three for fifteen", () => {
    expect(weeks("2026-09-01", "2026-09-15")).toBe(2);
    expect(weeks("2026-09-01", "2026-09-16")).toBe(3);
  });
});

// CALENDAR months, not 30-day blocks — `ceil(days / 30)` bills two months for 1 Jan → 1 Feb.
describe("months — calendar months, part month charged in full", () => {
  const months = (from: string, to: string) => billableMonths(day(from), day(to));

  it("charges one month for a whole 31-day month", () => {
    expect(months("2026-01-01", "2026-02-01")).toBe(1);
  });

  it("charges two months for one day past the anniversary", () => {
    expect(months("2026-01-01", "2026-02-02")).toBe(2);
  });

  it("clamps the anniversary into a short month", () => {
    // 31 Jan + 1 month is 28 Feb, so the hire ends exactly on it: one month.
    expect(months("2026-01-31", "2026-02-28")).toBe(1);
    expect(months("2026-01-31", "2026-03-01")).toBe(2);
  });

  it("clamps into a LEAP February", () => {
    expect(months("2028-01-31", "2028-02-29")).toBe(1);
    expect(months("2028-01-31", "2028-03-01")).toBe(2);
  });

  it("counts several whole months", () => {
    expect(months("2026-01-15", "2026-04-15")).toBe(3);
    expect(months("2026-01-15", "2026-04-16")).toBe(4);
  });

  it("charges a month for anything shorter than one", () => {
    expect(months("2026-09-01", "2026-09-02")).toBe(1);
  });

  it("charges nothing for an empty or reversed period", () => {
    expect(months("2026-09-01", "2026-09-01")).toBe(0);
    expect(months("2026-09-10", "2026-09-01")).toBe(0);
  });
});

describe("calculateUnitPricePence", () => {
  const start = day("2026-08-17");
  const end = day("2026-10-01"); // 45 days

  it("multiplies a daily rate by the billable days, in pence", () => {
    // £55/day × 45 = £2,475
    expect(calculateUnitPricePence("day", 5500, start, end)).toBe(247_500);
  });

  it("multiplies a weekly rate by whole weeks", () => {
    // 45 days → 7 weeks × £300
    expect(calculateUnitPricePence("week", 30_000, start, end)).toBe(210_000);
  });

  it("multiplies a monthly rate by whole calendar months", () => {
    // 17 Aug → 1 Oct is one whole month plus part of another → 2 × £900
    expect(calculateUnitPricePence("month", 90_000, start, end)).toBe(180_000);
  });

  // A free loan is a real case — the same reason the line schema accepts a zero price.
  it("accepts a zero rate", () => {
    expect(calculateUnitPricePence("day", 0, start, end)).toBe(0);
  });

  it("computes nothing for the `total` basis — that figure IS the price", () => {
    expect(calculateUnitPricePence("total", 5500, start, end)).toBeNull();
  });

  it("computes nothing without a usable rate", () => {
    expect(calculateUnitPricePence("day", null, start, end)).toBeNull();
    expect(calculateUnitPricePence("day", undefined, start, end)).toBeNull();
    expect(calculateUnitPricePence("day", -1, start, end)).toBeNull();
    expect(calculateUnitPricePence("day", 12.5, start, end)).toBeNull();
  });

  it("computes nothing for an empty or reversed period", () => {
    expect(calculateUnitPricePence("day", 5500, start, start)).toBeNull();
    expect(calculateUnitPricePence("day", 5500, end, start)).toBeNull();
  });

  // Integer pence throughout: no rate and no period may introduce a fraction of a penny.
  it("stays an integer for every basis", () => {
    for (const period of RATE_PERIODS) {
      const p = calculateUnitPricePence(period, 3333, start, end);
      if (p !== null) expect(Number.isInteger(p)).toBe(true);
    }
  });
});

describe("rateBasisLabel — what the screen and the order say", () => {
  it("names the period count", () => {
    expect(rateBasisLabel("day", 45)).toBe("× 45 days");
    expect(rateBasisLabel("week", 2)).toBe("× 2 weeks");
    expect(rateBasisLabel("month", 1)).toBe("× 1 month");
  });

  it("says what a total is", () => {
    expect(rateBasisLabel("total", 1)).toBe("for the whole hire period");
  });
});


// An extension reprices the WHOLE hire and subtracts what was already agreed. Pricing the added days
// on their own is the trap: on a weekly rate it invents a block that the hire had already paid for.
describe("extensionChargePence", () => {
  const start = day("2026-09-01");

  it("charges the added days on a daily rate", () => {
    // 30 days → 43 days, £55/day = 13 more days.
    expect(extensionChargePence("day", 5500, start, day("2026-10-01"), day("2026-10-14"))).toBe(71_500);
  });

  // THE reason it is a difference and not a fresh calculation of the added days.
  it("charges NOTHING when the extension stays inside the week already paid for", () => {
    // 10 days and 12 days are both two weeks.
    expect(extensionChargePence("week", 30_000, start, day("2026-09-11"), day("2026-09-13"))).toBe(0);
  });

  it("charges one more week once the extension crosses into it", () => {
    // 10 days (2 weeks) → 15 days (3 weeks).
    expect(extensionChargePence("week", 30_000, start, day("2026-09-11"), day("2026-09-16"))).toBe(30_000);
  });

  it("charges one more month once the extension crosses the anniversary", () => {
    expect(extensionChargePence("month", 90_000, start, day("2026-10-01"), day("2026-10-02"))).toBe(90_000);
    expect(extensionChargePence("month", 90_000, start, day("2026-09-20"), day("2026-09-25"))).toBe(0);
  });

  // A shortened hire is not a credit note, and nothing downstream models one.
  it("never goes negative", () => {
    expect(extensionChargePence("day", 5500, start, day("2026-10-01"), day("2026-09-20"))).toBe(0);
  });

  it("computes nothing on the total basis — that extension is a fresh negotiation", () => {
    expect(extensionChargePence("total", null, start, day("2026-10-01"), day("2026-10-14"))).toBeNull();
    expect(extensionChargePence("day", null, start, day("2026-10-01"), day("2026-10-14"))).toBeNull();
  });
});
