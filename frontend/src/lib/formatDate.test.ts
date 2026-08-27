import { describe, expect, it } from "vitest";

import { formatCalendarDay, formatDate, formatDateTime, formatDateTimeIn } from "./formatDate";

// This module exists because the same six-line formatter had been copy-pasted into thirteen files
// under three different names (fmtDate / formatDate / formatDay), and five of those copies had
// silently drifted to `toLocaleDateString("en-GB")` with no options — which renders 03/08/2026, not
// 03 Aug 2026. Settings → Company tells the admin "on-screen dates keep the standard UK format
// (DD Mon YYYY)", so Jobs, Inventory, Goods In, Goods Management and Users were all contradicting a
// promise the app makes on its own settings screen.
//
// The pattern is asserted here rather than a locale-formatted literal, so these tests state the
// contract instead of re-implementing Intl.
const AUG_3 = "2026-08-03T14:30:00.000Z";

describe("formatDate — the one on-screen date format", () => {
  it("renders DD Mon YYYY, the format Settings promises", () => {
    expect(formatDate(AUG_3)).toBe("03 Aug 2026");
  });

  // The exact regression: a bare toLocaleDateString("en-GB") gives 03/08/2026. Slashes here mean a
  // caller has drifted back to the numeric format.
  it("never renders the numeric slash format", () => {
    expect(formatDate(AUG_3)).not.toMatch(/\//);
  });

  // Zero-padded, so a column of dates stays aligned — "03 Aug" not "3 Aug".
  it("zero-pads the day", () => {
    expect(formatDate("2026-08-03T00:00:00.000Z")).toMatch(/^0\d /);
  });

  // Every copy this replaces returned an em dash for both cases, and tables rely on it to keep
  // their columns from collapsing on an empty cell.
  it.each([[null], [undefined], [""], ["not-a-date"]])("returns an em dash for %p", (bad) => {
    expect(formatDate(bad as string | null | undefined)).toBe("—");
  });
});

describe("formatDateTime — the same date, plus the time of day", () => {
  it("keeps the date half identical to formatDate", () => {
    expect(formatDateTime(AUG_3)).toContain(formatDate(AUG_3));
  });

  // inventoryStatus's copy used a bare toLocaleString, which appends seconds — noise in a ledger
  // column where only the minute matters.
  it("shows hours and minutes but not seconds", () => {
    expect(formatDateTime(AUG_3)).toMatch(/\d{2}:\d{2}/);
    expect(formatDateTime(AUG_3)).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it.each([[null], [undefined], [""], ["not-a-date"]])("returns an em dash for %p", (bad) => {
    expect(formatDateTime(bad as string | null | undefined)).toBe("—");
  });
});

describe("formatCalendarDay", () => {
  it("renders a calendar day in UTC, not the viewer's zone", () => {
    // The whole reason this exists. A hire deadline is stored as UTC midnight; formatDate would show
    // 30 September to anyone behind UTC, naming the wrong day on the one field that names a day.
    expect(formatCalendarDay("2026-10-01T00:00:00.000Z")).toBe("01 Oct 2026");
  });

  it("matches formatDate's shape so the two can sit in one table", () => {
    expect(formatCalendarDay("2026-08-03T12:00:00.000Z")).toBe("03 Aug 2026");
  });

  it("returns the em dash for null, undefined and unparseable input", () => {
    expect(formatCalendarDay(null)).toBe("—");
    expect(formatCalendarDay(undefined)).toBe("—");
    expect(formatCalendarDay("not a date")).toBe("—");
  });
});

// A scheduled report is configured as a wall-clock time in the COMPANY timezone, and stored as UTC.
// Rendering it in the viewer's zone produced a row that read "Monthly on the 1st at 06:00 ·
// Europe/London" beside "Next run: 01 Sept 2026, 10:30" — the same event, twice, disagreeing.

// 06:00 on 1 September 2026 in London, which is BST (+1) — so 05:00 UTC.
const SEPT_0600_LONDON = "2026-09-01T05:00:00.000Z";
// 06:00 on 1 December 2026 in London, which is GMT (+0).
const DEC_0600_LONDON = "2026-12-01T06:00:00.000Z";

describe("formatDateTimeIn — the schedule's zone, not the viewer's", () => {
  it("renders the configured wall-clock time", () => {
    expect(formatDateTimeIn(SEPT_0600_LONDON, "Europe/London")).toBe("01 Sept 2026, 06:00 BST");
  });

  // THE point of the fix: the same instant, read from three places on earth, still says 06:00 London.
  it("does not move with the viewer, which is why the number can be trusted", () => {
    const london = formatDateTimeIn(SEPT_0600_LONDON, "Europe/London");
    expect(london).toContain("06:00");
    // The viewer's own rendering of that instant differs by zone — that is exactly what was on screen
    // before (10:30 on an Indian machine), and what this function no longer does.
    expect(formatDateTimeIn(SEPT_0600_LONDON, "Asia/Kolkata")).toContain("10:30");
    expect(formatDateTimeIn(SEPT_0600_LONDON, "America/New_York")).toContain("01:00");
  });

  // One stored instant, two labels across the year: the abbreviation is what makes 06:00 unambiguous.
  it("shows the zone, and follows DST", () => {
    expect(formatDateTimeIn(SEPT_0600_LONDON, "Europe/London")).toContain("BST");
    expect(formatDateTimeIn(DEC_0600_LONDON, "Europe/London")).toContain("GMT");
    // Both are still 06:00 local — a schedule set for 06:00 does not drift an hour every summer.
    expect(formatDateTimeIn(DEC_0600_LONDON, "Europe/London")).toBe("01 Dec 2026, 06:00 GMT");
  });

  it("labels an offset zone unambiguously too", () => {
    expect(formatDateTimeIn(SEPT_0600_LONDON, "Asia/Kolkata")).toContain("GMT+5:30");
  });
});

describe("formatDateTimeIn — falling back rather than failing", () => {
  // `timeZone` reaches here from the database. An unusable one must not take a whole table down.
  it("falls back to the viewer's rendering on an unusable zone", () => {
    expect(formatDateTimeIn(SEPT_0600_LONDON, "Mars/Olympus")).toBe(formatDateTime(SEPT_0600_LONDON));
  });

  // Null is the NORMAL case for a schedule with no override — it means "the company timezone", which
  // the caller resolves before calling. Reaching here with null means nobody knew the zone.
  it("falls back when no zone is given at all", () => {
    expect(formatDateTimeIn(SEPT_0600_LONDON, null)).toBe(formatDateTime(SEPT_0600_LONDON));
    expect(formatDateTimeIn(SEPT_0600_LONDON, "")).toBe(formatDateTime(SEPT_0600_LONDON));
  });

  it("returns the em dash for a missing or unparseable instant", () => {
    expect(formatDateTimeIn(null, "Europe/London")).toBe("—");
    expect(formatDateTimeIn(undefined, "Europe/London")).toBe("—");
    expect(formatDateTimeIn("not a date", "Europe/London")).toBe("—");
  });
});

describe("formatDateTime is unchanged", () => {
  // The viewer's-zone formatter is still right for ledger and audit timestamps ("when did this happen,
  // my time"). This fix adds a second answer; it does not replace the first.
  it("still renders in the viewer's zone and carries no zone label", () => {
    const out = formatDateTime(SEPT_0600_LONDON);
    expect(out).toMatch(/^01 Sept 2026, \d{2}:\d{2}$/);
    expect(out).not.toContain("BST");
  });
});
