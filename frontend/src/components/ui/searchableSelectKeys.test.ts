import { describe, expect, it } from "vitest";

import { initialIndex, nextEnabledIndex, SEARCHABLE_THRESHOLD, shouldSearch } from "./searchableSelectKeys";

const opts = (...disabled: boolean[]) => disabled.map((d) => ({ disabled: d }));

describe("nextEnabledIndex", () => {
  it("stays put when the option under it can be chosen", () => {
    expect(nextEnabledIndex(opts(false, false, false), 1, 1)).toBe(1);
  });

  it("walks past disabled options in the direction of travel", () => {
    expect(nextEnabledIndex(opts(false, true, true, false), 1, 1)).toBe(3);
    expect(nextEnabledIndex(opts(false, true, true, false), 2, -1)).toBe(0);
  });

  it("holds its ground rather than wrapping when the rest of that direction is disabled", () => {
    // Leaning on ↓ at the end of a list must not fling the highlight back to the top — the user
    // reads that as the list jumping under them.
    expect(nextEnabledIndex(opts(false, true, true), 1, 1)).toBe(1);
    expect(nextEnabledIndex(opts(true, true, false), 1, -1)).toBe(1);
  });

  it("survives an empty list", () => {
    expect(nextEnabledIndex([], 0, 1)).toBe(0);
  });
});

describe("initialIndex", () => {
  it("opens on the current value, so the first arrow press moves away from it, not to it", () => {
    expect(initialIndex(opts(false, false, false), 2)).toBe(2);
  });

  it("falls back to the first selectable row when nothing is selected", () => {
    expect(initialIndex(opts(false, false), -1)).toBe(0);
    expect(initialIndex(opts(true, false), -1)).toBe(1);
  });

  it("falls back when the selected option was filtered out or is disabled", () => {
    // The query narrowed the list and the selection is no longer in it — index 9 does not exist.
    expect(initialIndex(opts(false, false), 9)).toBe(0);
    expect(initialIndex(opts(true, false), 0)).toBe(1);
  });
});

describe("shouldSearch", () => {
  it("obeys the caller's explicit answer whatever the length", () => {
    // The whole point of the flag: two engineers in a dev database, sixty on a real site.
    expect(shouldSearch(2, true)).toBe(true);
    expect(shouldSearch(200, false)).toBe(false);
  });

  it("gives an unflagged list a search box once it is long enough to be worth searching", () => {
    expect(shouldSearch(SEARCHABLE_THRESHOLD - 1, undefined)).toBe(false);
    expect(shouldSearch(SEARCHABLE_THRESHOLD, undefined)).toBe(true);
  });

  it("leaves a short fixed list alone", () => {
    // A status filter with four options gains nothing from a search box and loses a row of space.
    expect(shouldSearch(4, undefined)).toBe(false);
  });
});
