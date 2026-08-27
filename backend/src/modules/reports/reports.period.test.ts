import { describe, expect, it } from "vitest";

import { dayKeysBetween, monthKeysBetween, resolvePeriod, startOfMonthIn, startOfWeekIn, trendGrain } from "./reports.period.js";
import { financePoWhere, LIVE_PO, REPORTABLE_PO_STATUSES, EXCLUDED_PO_STATUSES, lineVatPence } from "./reports.constants.js";

const TZ = "Europe/London";
const iso = (d: Date) => d.toISOString();

describe("calendar boundaries, not rolling windows", () => {
  // The client asked for Weekly/Monthly. The existing dashboard periods are rolling ("last 30 days"),
  // which is a different question: two runs of "this month" must return the same window.
  it("starts a week on Monday", () => {
    // 2026-09-15 is a Tuesday → the week starts Monday the 14th.
    expect(iso(startOfWeekIn(TZ, new Date("2026-09-15T10:00:00Z")))).toBe("2026-09-14T00:00:00.000Z");
  });

  it("treats Sunday as the END of its week, not the start", () => {
    // Midday on Sunday 20 September → still the week beginning Monday the 14th.
    expect(iso(startOfWeekIn(TZ, new Date("2026-09-20T12:00:00Z")))).toBe("2026-09-14T00:00:00.000Z");
  });

  // The other half of the BST rule, and the reason the fixture above uses midday: 23:00 UTC on
  // Sunday is already 00:00 MONDAY in London, so the week has genuinely rolled over. A helper that
  // read the UTC date would still be reporting last week for that first hour.
  it("rolls the week over at UK midnight, not UTC midnight", () => {
    expect(iso(startOfWeekIn(TZ, new Date("2026-09-20T23:00:00Z")))).toBe("2026-09-21T00:00:00.000Z");
  });

  it("starts a month on the 1st", () => {
    expect(iso(startOfMonthIn(TZ, new Date("2026-09-15T10:00:00Z")))).toBe("2026-09-01T00:00:00.000Z");
  });

  // The BST trap the shared startOfDayIn exists to solve: before 01:00 UTC the UK calendar date is
  // already the next day. Getting this wrong shifts every period boundary by a day for half the year.
  it("resolves the UK calendar date during BST, not the UTC one", () => {
    // 00:30 BST on 1 September = 23:30 UTC on 31 August. The month must be SEPTEMBER.
    expect(iso(startOfMonthIn(TZ, new Date("2026-08-31T23:30:00Z")))).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("resolvePeriod", () => {
  const NOW = new Date("2026-09-15T10:00:00Z");

  it("ends the range at the LAST MILLISECOND of the day so `lte` catches it", () => {
    const r = resolvePeriod(TZ, "month", NOW);
    expect(iso(r.to)).toBe("2026-09-15T23:59:59.999Z");
  });

  it("labels a month plainly", () => {
    expect(resolvePeriod(TZ, "month", NOW).label).toBe("Sep 2026");
  });

  it("labels a week as a date range", () => {
    expect(resolvePeriod(TZ, "week", NOW).label).toBe("14–15 Sep 2026");
  });

  // Swapped bounds would select NOTHING, which reads as "no spend" — indistinguishable from a quiet
  // month. Ordering them is the honest reading of what was asked for.
  it("orders reversed custom bounds instead of returning an empty window", () => {
    const r = resolvePeriod(TZ, "custom", NOW, { from: new Date("2026-09-30T23:59:59Z"), to: new Date("2026-09-01T00:00:00Z") });
    expect(r.from.getTime()).toBeLessThan(r.to.getTime());
  });
});

describe("trend grain and bucket keys", () => {
  it("uses days for a short range and months for a long one", () => {
    const short = resolvePeriod(TZ, "custom", new Date(), { from: new Date("2026-09-01"), to: new Date("2026-09-30") });
    const long = resolvePeriod(TZ, "custom", new Date(), { from: new Date("2026-01-01"), to: new Date("2026-12-31") });
    expect(trendGrain(short)).toBe("day");
    expect(trendGrain(long)).toBe("month");
  });

  it("emits a continuous month axis across a year boundary", () => {
    expect(monthKeysBetween(new Date("2026-11-15"), new Date("2027-02-03"))).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });

  it("emits every day inclusive of both ends", () => {
    expect(dayKeysBetween(new Date("2026-09-01T00:00:00Z"), new Date("2026-09-03T23:59:59.999Z"))).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
    ]);
  });
});

describe("the canonical status rule", () => {
  // D1 is a business definition. The value of centralising it is that this list is the ONLY place it
  // lives — if the client rules that "raised" means SENT, this array changes and nothing else does.
  it("excludes exactly draft and cancelled", () => {
    expect([...EXCLUDED_PO_STATUSES]).toEqual(["draft", "cancelled"]);
    for (const s of EXCLUDED_PO_STATUSES) expect(REPORTABLE_PO_STATUSES).not.toContain(s);
  });

  it("covers the whole committed lifecycle including the terminal states", () => {
    for (const s of ["pending_approval", "approved", "pm_review", "sent", "supplier_accepted", "partially_received", "fully_received", "closed"]) {
      expect(REPORTABLE_PO_STATUSES).toContain(s);
    }
  });

  it("builds a where clause carrying the status set, the date range AND the soft-delete guard", () => {
    const w = financePoWhere({ from: new Date("2026-09-01"), to: new Date("2026-09-30") });
    expect(w.status).toEqual({ in: [...REPORTABLE_PO_STATUSES] });
    expect(w.orderDate).toEqual({ gte: new Date("2026-09-01"), lte: new Date("2026-09-30") });
    // Mongo does not match `{deletedAt: null}` against a row whose insert omitted the field, so both
    // shapes must be asked for — otherwise every pre-column order silently leaves the accounts.
    expect(w.OR).toEqual(LIVE_PO.OR);
  });
});

describe("per-line VAT helper", () => {
  it("mirrors computeTotals — round(lineTotal × rate / 100)", () => {
    expect(lineVatPence(50_000, 20)).toBe(10_000);
    expect(lineVatPence(333, 20)).toBe(67); // 66.6 → 67, per line
    expect(lineVatPence(1234, 5)).toBe(62); // 61.7 → 62
    expect(lineVatPence(1000, 0)).toBe(0);
  });
});
