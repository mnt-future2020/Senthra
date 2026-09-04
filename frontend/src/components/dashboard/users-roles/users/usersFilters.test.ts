import { describe, expect, it } from "vitest";

import {
  usersHasFilters,
  usersPopoverFilterCount,
  type UsersFilterState,
} from "./usersFilters";

// ── Two rules the staff directory got wrong, pinned ────────────────────────────────────────────
//
//  1. The Filters badge counted the Added-date range and nothing else. Role has moved in behind the
//     same trigger, and an uncounted filter is the one failure a folded-away filter must not have:
//     the list looks short and nothing on screen says why.
//  2. The empty state ignored the date range entirely, so a range with no signups in it answered
//     "Add your first user to get started" on a directory holding six people.

const none: UsersFilterState = { search: "", status: "all", role: "all", addedFrom: "", addedTo: "" };

describe("usersPopoverFilterCount", () => {
  it("is 0 with nothing set", () => {
    expect(usersPopoverFilterCount(none)).toBe(0);
  });

  it("counts a role", () => {
    expect(usersPopoverFilterCount({ ...none, role: "role-1" })).toBe(1);
  });

  it("counts a range ONCE however many ends are filled", () => {
    expect(usersPopoverFilterCount({ ...none, addedFrom: "2026-08-01" })).toBe(1);
    expect(usersPopoverFilterCount({ ...none, addedTo: "2026-08-31" })).toBe(1);
    expect(usersPopoverFilterCount({ ...none, addedFrom: "2026-08-01", addedTo: "2026-08-31" })).toBe(1);
  });

  it("counts role and range together — the case the old badge reported as 1", () => {
    expect(
      usersPopoverFilterCount({ ...none, role: "role-1", addedFrom: "2026-08-01", addedTo: "2026-08-31" }),
    ).toBe(2);
  });

  it("ignores search and status — those stay OUT of the popover", () => {
    expect(usersPopoverFilterCount({ ...none, search: "salma", status: "suspended" })).toBe(0);
  });
});

describe("usersHasFilters", () => {
  it("is false with nothing set", () => {
    expect(usersHasFilters(none)).toBe(false);
  });

  it("is true for each control on its own", () => {
    expect(usersHasFilters({ ...none, search: "salma" })).toBe(true);
    expect(usersHasFilters({ ...none, status: "suspended" })).toBe(true);
    expect(usersHasFilters({ ...none, role: "role-1" })).toBe(true);
  });

  it("is true for a date range — the bug: an empty page claimed the directory was empty", () => {
    expect(usersHasFilters({ ...none, addedFrom: "2026-08-01" })).toBe(true);
    expect(usersHasFilters({ ...none, addedTo: "2026-08-31" })).toBe(true);
  });

  it("clearing the popover's filters puts it back to false", () => {
    const filtered: UsersFilterState = { ...none, role: "role-1", addedFrom: "2026-08-01", addedTo: "2026-08-31" };
    expect(usersHasFilters(filtered)).toBe(true);
    // What onClear writes: role/addedFrom/addedTo dropped from the URL, so they read back as unset.
    const cleared: UsersFilterState = { ...filtered, role: "all", addedFrom: "", addedTo: "" };
    expect(usersHasFilters(cleared)).toBe(false);
    expect(usersPopoverFilterCount(cleared)).toBe(0);
  });

  it("does NOT treat sort as a filter — it has no field here, and re-ordering empties nothing", () => {
    // The state carries no sort at all; this pins that the shape stayed that way deliberately.
    expect(Object.keys(none).sort()).toEqual(["addedFrom", "addedTo", "role", "search", "status"]);
  });
});
