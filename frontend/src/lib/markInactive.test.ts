import { describe, expect, it } from "vitest";

import { markInactive, withHistoricalOption } from "./historicalOption";

// A HISTORY filter lists deactivated records too — a retired customer still owns its movements — and
// labels them the way the forms already label a saved-but-retired selection.
describe("markInactive", () => {
  it("labels a deactivated record", () => {
    expect(markInactive("Zulu Ltd", true)).toBe("Zulu Ltd (inactive)");
  });

  it("leaves an active record's label alone", () => {
    expect(markInactive("Zulu Ltd", false)).toBe("Zulu Ltd");
    expect(markInactive("Zulu Ltd", undefined)).toBe("Zulu Ltd");
  });

  it("uses the same wording as a form's saved-but-retired selection", () => {
    expect(withHistoricalOption([], "z", "Zulu Ltd")[0].label).toBe(markInactive("Zulu Ltd", true));
  });
});
