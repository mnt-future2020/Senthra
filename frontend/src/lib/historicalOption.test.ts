import { describe, expect, it } from "vitest";

import { withHistoricalOption } from "./historicalOption";

const opts = [
  { value: "a", label: "Acme Ltd (SUP-0001)" },
  { value: "b", label: "Bravo Ltd (SUP-0002)" },
];

/**
 * The deactivation case. It needs no data growth at all — one admin retiring a supplier is enough
 * to make a saved purchase order render "— Select a supplier —" beside a panel showing that
 * supplier's contact details.
 */
describe("withHistoricalOption", () => {
  it("leaves the list untouched when the saved value is still offered", () => {
    expect(withHistoricalOption(opts, "a", "Acme Ltd")).toBe(opts);
  });

  it("leaves the list untouched when nothing is selected", () => {
    expect(withHistoricalOption(opts, "", "Acme Ltd")).toBe(opts);
    expect(withHistoricalOption(opts, null, null)).toBe(opts);
  });

  it("appends a saved value that is no longer active, marked inactive", () => {
    const out = withHistoricalOption(opts, "z", "Zulu Ltd");
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ value: "z", label: "Zulu Ltd (inactive)" });
  });

  // Appended, never prepended: first position reads as the default, and this is a value the user is
  // being shown, not one being recommended.
  it("appends rather than prepends, so the live options stay first", () => {
    const out = withHistoricalOption(opts, "z", "Zulu Ltd");
    expect(out.slice(0, 2)).toEqual(opts);
  });

  // A blank row reads as a real, choosable, nameless option — worse than the placeholder it replaces.
  it("does nothing when there is no label to show the saved value by", () => {
    expect(withHistoricalOption(opts, "z", "")).toBe(opts);
    expect(withHistoricalOption(opts, "z", null)).toBe(opts);
  });

  // Identity is the id. A retired record sharing a name with a live one must not be swallowed by it.
  it("matches on id, never on label", () => {
    const out = withHistoricalOption(opts, "z", "Acme Ltd");
    expect(out).toHaveLength(3);
    expect(out[2].value).toBe("z");
  });

  it("adds only the one saved value, never a second inactive record", () => {
    const once = withHistoricalOption(opts, "z", "Zulu Ltd");
    expect(withHistoricalOption(once, "z", "Zulu Ltd")).toBe(once);
  });
});
