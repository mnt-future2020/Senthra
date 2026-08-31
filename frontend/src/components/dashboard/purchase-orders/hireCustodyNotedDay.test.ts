import { describe, expect, it } from "vitest";

import { formatCalendarDay, formatDate } from "@/lib/formatDate";
import { notedDayIfDifferent } from "./HireCustodyTimeline";

// TWO DATES OF TWO DIFFERENT KINDS, on the pair a provider's charge is argued against.
//
//   declaredAt      — an INSTANT. The moment damage was declared, or midday for a day picked on a form.
//   settledNotedAt  — a CALENDAR DAY, stored at UTC midnight like every date input in this app.
//
// Both halves of the old code were wrong about that, and the two faults hid each other:
//
//   • it compared Date.parse of the two. An instant is never equal to a UTC midnight, so the "same day,
//     don't print it twice" case could not fire — every warehouse-raised record read "Found 31 Aug ·
//     noted 31 Aug", and ", written up 31 Aug" under it.
//   • it rendered the noted day with the viewer-zone formatter. UTC midnight read from any zone behind
//     UTC is the day BEFORE, so a note written up on the 31st would print as the 30th.
//
// Comparing what is PRINTED — found in the viewer's zone, noted pinned to UTC as its own formatter
// requires — fixes both at once and needs no offset arithmetic, which is also why a DST boundary cannot
// move it.
describe("notedDayIfDifferent", () => {
  it("says nothing when the note was written up the day the damage was found", () => {
    // The whole point of the guard, and the case that never once fired. Midday UTC, so the found
    // instant lands on the 31st in every zone this app is read in.
    expect(notedDayIfDifferent("2026-08-31T12:00:00.000Z", "2026-08-31T00:00:00.000Z")).toBeNull();
  });

  it("names the day when the write-up came later", () => {
    // Found on the 27th, filed with the rest on the 31st. Showing only the first read as the wrong one.
    expect(notedDayIfDifferent("2026-08-27T09:00:00.000Z", "2026-08-31T00:00:00.000Z")).toBe("31 Aug 2026");
  });

  it("says nothing when there is no settling note yet", () => {
    expect(notedDayIfDifferent("2026-08-31T14:22:09.000Z", null)).toBeNull();
    expect(notedDayIfDifferent("2026-08-31T14:22:09.000Z", undefined)).toBeNull();
  });

  // THE BOUNDARY IS THE VIEWER'S, and asserting it against a hardcoded string would only be testing
  // the machine the suite happens to run on. The rule is "say nothing when the two PRINT the same", so
  // these ask exactly that — which is also what the reader of the card sees.
  it.each([
    ["the last instant of a UTC day", "2026-08-31T23:59:59.999Z"],
    ["the first instant of the next", "2026-09-01T00:00:00.000Z"],
    ["midday, where no zone disagrees", "2026-08-31T12:00:00.000Z"],
  ])("stays consistent with what is printed at %s", (_label, declaredAt) => {
    const noted = "2026-08-31T00:00:00.000Z";
    const sameOnScreen = formatDate(declaredAt) === formatCalendarDay(noted);
    expect(notedDayIfDifferent(declaredAt, noted)).toBe(sameOnScreen ? null : "31 Aug 2026");
  });

  it("prints the noted day pinned to UTC, never the viewer's reading of that midnight", () => {
    // The second half of the bug: `formatDate` on a UTC-midnight calendar day shows the day BEFORE for
    // anyone behind UTC. This must be the stored day in every zone.
    expect(notedDayIfDifferent("2026-08-20T12:00:00.000Z", "2026-08-31T00:00:00.000Z")).toBe("31 Aug 2026");
  });

  it("prints the noted day as the day it was STORED, across a DST boundary", () => {
    // 25 Oct 2026 is the Sunday UK clocks go back. A calendar day is pinned to UTC by its formatter, so
    // the stored day survives whatever the viewer's offset is doing that weekend — the failure mode the
    // viewer-zone formatter had was showing the day before.
    expect(notedDayIfDifferent("2026-10-20T09:00:00.000Z", "2026-10-25T00:00:00.000Z")).toBe("25 Oct 2026");
    expect(notedDayIfDifferent("2026-10-20T09:00:00.000Z", "2026-10-26T00:00:00.000Z")).toBe("26 Oct 2026");
  });
});
