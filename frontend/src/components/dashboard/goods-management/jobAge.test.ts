import { describe, expect, it } from "vitest";

import { ageTone, daysSince, formatDay, jobAgeDays } from "./jobAge";

// Fixed "now" so the suite can't drift with the wall clock.
const NOW = new Date("2026-07-31T12:00:00.000Z").getTime();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("daysSince", () => {
  it("counts whole days", () => {
    expect(daysSince(daysAgo(0), NOW)).toBe(0);
    expect(daysSince(daysAgo(1), NOW)).toBe(1);
    expect(daysSince(daysAgo(45), NOW)).toBe(45);
  });

  it("floors a part day rather than rounding up", () => {
    expect(daysSince(new Date(NOW - 47 * 3_600_000).toISOString(), NOW)).toBe(1);
  });

  // Server and browser clocks disagree by seconds routinely; "-1d" in the UI would just look broken.
  it("never returns a negative age for a future timestamp", () => {
    expect(daysSince(new Date(NOW + 86_400_000).toISOString(), NOW)).toBe(0);
  });

  it("returns null for a missing or unparseable timestamp", () => {
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince(undefined, NOW)).toBeNull();
    expect(daysSince("not-a-date", NOW)).toBeNull();
  });
});

describe("jobAgeDays", () => {
  it("ages from the last movement when there is one", () => {
    expect(jobAgeDays({ lastActivityAt: daysAgo(3), createdAt: daysAgo(40) }, NOW)).toBe(3);
  });

  // The whole point: a never-issued job is the one that goes unnoticed, so it must still have an age.
  it("falls back to when the job was raised if nothing has ever moved", () => {
    expect(jobAgeDays({ lastActivityAt: null, createdAt: daysAgo(40) }, NOW)).toBe(40);
  });
});

describe("ageTone", () => {
  it("turns amber exactly at the configured window and red at twice it", () => {
    expect(ageTone(0, 14)).toBe("normal");
    expect(ageTone(13, 14)).toBe("normal");
    expect(ageTone(14, 14)).toBe("warn");
    expect(ageTone(27, 14)).toBe("warn");
    expect(ageTone(28, 14)).toBe("bad");
  });

  // The whole point of taking the window as an argument: an admin moving it to 45 must move the badge
  // too, or the Queue flags jobs as late that the Overdue tab — one tab away — says are not.
  it("follows the configured window rather than a hardcoded fortnight", () => {
    expect(ageTone(20, 45)).toBe("normal"); // would have been amber under the old fixed 14
    expect(ageTone(45, 45)).toBe("warn");
    expect(ageTone(90, 45)).toBe("bad");
    expect(ageTone(8, 7)).toBe("warn"); // and a tighter window flags sooner
  });

  it("stays neutral when the age is unknown", () => {
    expect(ageTone(null, 14)).toBe("normal");
  });
});

describe("formatDay", () => {
  it("renders a UK short date", () => {
    expect(formatDay("2026-07-21T10:00:00.000Z")).toBe("21/07/2026");
  });

  it("renders an em dash when there is no date", () => {
    expect(formatDay(null)).toBe("—");
    expect(formatDay("nonsense")).toBe("—");
  });
});
