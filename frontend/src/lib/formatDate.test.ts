import { describe, expect, it } from "vitest";

import { formatDate, formatDateTime } from "./formatDate";

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
