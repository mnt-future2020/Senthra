import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUserSchema, updateUserSchema } from "./user.validation.js";
import {
  addDaysIso,
  addYearsIso,
  isCalendarDate,
  todayIso,
  yearsBetween,
} from "../../utils/validation.js";

// Every case is anchored to a frozen "today" so a test can't start failing on a
// birthday or a leap day.
const NOW = new Date("2026-07-27T12:00:00.000Z");
const TODAY = "2026-07-27";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

// A create payload that is valid apart from whatever the test overrides.
const baseCreate = {
  firstName: "Alex",
  lastName: "Morgan",
  email: "alex@company.com",
  phone: "07700900000",
  roleId: "engineer-role",
  jobTitle: "Engineer",
  department: "Field Ops",
  dateOfJoining: "2024-01-15",
};

const createWith = (over: Record<string, unknown>) =>
  createUserSchema.safeParse({ ...baseCreate, ...over });

const firstMessage = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? undefined : r.error!.issues[0].message;

describe("calendar-date primitives", () => {
  it("accepts only real YYYY-MM-DD dates", () => {
    expect(isCalendarDate("1990-01-01")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true); // leap year
  });

  it("rejects the shapes Date.parse would have waved through", () => {
    // Node's legacy fallback parser turns "Mar 5" into 2001-03-05 — a plausible
    // wrong date, which is worse than an obviously broken one.
    expect(isCalendarDate("Mar 5")).toBe(false);
    expect(isCalendarDate("2024")).toBe(false);
    expect(isCalendarDate("15/01/2024")).toBe(false);
    expect(isCalendarDate("1990-1-1")).toBe(false);
    expect(isCalendarDate("1990-01-01T00:00:00Z")).toBe(false);
  });

  it("rejects dates that don't exist on the calendar", () => {
    expect(isCalendarDate("2025-02-30")).toBe(false);
    expect(isCalendarDate("2025-02-29")).toBe(false); // not a leap year
    expect(isCalendarDate("2025-13-01")).toBe(false);
    expect(isCalendarDate("2025-04-31")).toBe(false);
    expect(isCalendarDate("2025-00-10")).toBe(false);
  });

  it("counts whole years by calendar, not milliseconds", () => {
    expect(yearsBetween("2000-07-27", TODAY)).toBe(26); // birthday is today
    expect(yearsBetween("2000-07-28", TODAY)).toBe(25); // birthday tomorrow
    expect(yearsBetween("2000-07-26", TODAY)).toBe(26);
    // Leap-day births age correctly across a non-leap year.
    expect(yearsBetween("2004-02-29", "2026-02-28")).toBe(21);
    expect(yearsBetween("2004-02-29", "2026-03-01")).toBe(22);
  });

  it("clamps 29 Feb when shifting years into a non-leap year", () => {
    expect(addYearsIso("2004-02-29", 16)).toBe("2020-02-29"); // leap → leap
    expect(addYearsIso("2004-02-29", 17)).toBe("2021-02-28"); // clamped, not 1 Mar
    expect(addYearsIso("2026-07-27", -16)).toBe("2010-07-27");
  });

  it("reports today from the system clock", () => {
    expect(todayIso()).toBe(TODAY);
  });
});

describe("createUserSchema — date of birth", () => {
  it("accepts a valid adult birth date", () => {
    expect(createWith({ dateOfBirth: "1990-05-20" }).success).toBe(true);
  });

  it("stays optional — absent and empty are both fine", () => {
    expect(createWith({}).success).toBe(true);
    expect(createWith({ dateOfBirth: "" }).success).toBe(true);
  });

  it("rejects a future birth date", () => {
    expect(firstMessage(createWith({ dateOfBirth: "3025-01-01" }))).toBe(
      "Date of birth can't be in the future.",
    );
    // Two days out — beyond the one-day timezone tolerance, so unambiguously future.
    expect(createWith({ dateOfBirth: "2026-07-29" }).success).toBe(false);
  });

  it("still rejects today's date — valid, but nobody is 16 on the day they're born", () => {
    expect(firstMessage(createWith({ dateOfBirth: TODAY }))).toBe(
      "Staff must be at least 16 years old.",
    );
  });

  it("enforces the minimum age at the 16th birthday, ± the timezone tolerance", () => {
    // Turns 16 today → allowed.
    expect(createWith({ dateOfBirth: "2010-07-27", dateOfJoining: TODAY }).success).toBe(true);
    // Turns 16 tomorrow → the DOB itself is allowed, because a browser one
    // timezone east already calls it their birthday and the server must not
    // contradict the user's own calendar. (Joining is set to that birthday; a
    // joining date of *today* would be the day before they turned 16, which both
    // sides reject on the cross-field rule — see the cross-field suite.)
    expect(createWith({ dateOfBirth: "2010-07-28", dateOfJoining: "2026-07-28" }).success).toBe(true);
    // Two days out → beyond any real timezone, so rejected.
    expect(firstMessage(createWith({ dateOfBirth: "2010-07-29" }))).toBe(
      "Staff must be at least 16 years old.",
    );
  });

  it("rejects an implausibly old birth date", () => {
    expect(firstMessage(createWith({ dateOfBirth: "1800-01-01" }))).toContain(
      "over 120 years ago",
    );
    expect(createWith({ dateOfBirth: "0001-01-01" }).success).toBe(false);
  });

  it("applies the same one-day tolerance at the 120-year bound", () => {
    // Turns 121 the day after tomorrow → still inside the window, allowed.
    expect(createWith({ dateOfBirth: "1905-07-29" }).success).toBe(true);
    // Turned 121 two days ago → outside it, rejected.
    expect(createWith({ dateOfBirth: "1905-07-25" }).success).toBe(false);
  });

  it("rejects non-ISO junk that Date.parse used to accept", () => {
    expect(createWith({ dateOfBirth: "Mar 5" }).success).toBe(false);
    expect(createWith({ dateOfBirth: "1990" }).success).toBe(false);
    expect(createWith({ dateOfBirth: "1990-02-30" }).success).toBe(false);
  });
});

describe("createUserSchema — date of joining", () => {
  it("is still required", () => {
    expect(firstMessage(createWith({ dateOfJoining: "" }))).toBe("Date of joining is required.");
  });

  it("allows a confirmed start date up to a year ahead", () => {
    expect(createWith({ dateOfJoining: "2027-07-27" }).success).toBe(true);
    expect(createWith({ dateOfJoining: "2027-07-28" }).success).toBe(true); // tz tolerance
  });

  it("rejects a start date beyond a year ahead", () => {
    expect(firstMessage(createWith({ dateOfJoining: "2027-07-29" }))).toBe(
      "Date of joining can't be more than a year in the future.",
    );
    expect(createWith({ dateOfJoining: "2099-01-01" }).success).toBe(false);
  });

  it("rejects a non-calendar joining date", () => {
    expect(createWith({ dateOfJoining: "2024-02-31" }).success).toBe(false);
    expect(createWith({ dateOfJoining: "Mar 5" }).success).toBe(false);
  });
});

describe("cross-field — joined before turning 16", () => {
  it("rejects a joining date before the 16th birthday", () => {
    const r = createWith({ dateOfBirth: "2000-06-01", dateOfJoining: "2015-06-01" });
    expect(firstMessage(r)).toContain("before this person turned 16");
  });

  it("reports the error against the joining field", () => {
    const r = createWith({ dateOfBirth: "2000-06-01", dateOfJoining: "2015-06-01" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].path).toEqual(["dateOfJoining"]);
  });

  it("accepts joining exactly on the 16th birthday", () => {
    expect(createWith({ dateOfBirth: "2000-06-01", dateOfJoining: "2016-06-01" }).success).toBe(
      true,
    );
  });

  it("rejects joining the day before the 16th birthday", () => {
    expect(createWith({ dateOfBirth: "2000-06-01", dateOfJoining: "2016-05-31" }).success).toBe(
      false,
    );
  });

  it("stays quiet when only one of the two dates is supplied", () => {
    expect(createWith({ dateOfJoining: "2016-06-01" }).success).toBe(true);
    expect(createWith({ dateOfBirth: "1990-01-01", dateOfJoining: "2016-06-01" }).success).toBe(
      true,
    );
  });
});

// The property that makes the tolerance worth having: whatever the browser judged
// acceptable against ITS local date, the server must also accept. A browser can be
// a day either side of the server's UTC date (UTC-12 … UTC+14), so all three cases
// have to hold. A failure here is the "form said OK, save said no" bug.
describe("client/server agreement across timezones", () => {
  // Mirrors frontend/src/lib/validation.ts validateDateOfBirth.
  const clientAcceptsDob = (dob: string, clientToday: string): boolean =>
    isCalendarDate(dob) &&
    dob <= clientToday &&
    yearsBetween(dob, clientToday) >= 16 &&
    yearsBetween(dob, clientToday) <= 120;

  const CLIENT_TODAYS = [addDaysIso(TODAY, -1), TODAY, addDaysIso(TODAY, 1)];

  // Boundary dates: exactly 16, either side of 16, exactly 120, either side, and today.
  const CANDIDATES = [
    "2010-07-26", "2010-07-27", "2010-07-28", "2010-07-29",
    "1906-07-26", "1906-07-27", "1906-07-28",
    "1905-07-26", "1905-07-27", "1905-07-28",
    "1990-05-20", TODAY, addDaysIso(TODAY, 1),
  ];

  // DOB alone, via the update schema — the create schema would also apply the
  // cross-field joining rule and muddy what's being asserted here.
  const serverAcceptsDob = (dob: string) => updateUserSchema.safeParse({ dateOfBirth: dob }).success;

  for (const clientToday of CLIENT_TODAYS) {
    it(`accepts everything a browser on ${clientToday} would have accepted`, () => {
      const disagreements = CANDIDATES.filter(
        (dob) => clientAcceptsDob(dob, clientToday) && !serverAcceptsDob(dob),
      );
      expect(disagreements).toEqual([]);
    });
  }

  it("does not become a blank cheque — two days past the bound is still rejected", () => {
    // Tolerance is exactly one day, not "any future date".
    expect(serverAcceptsDob(addDaysIso(TODAY, 2))).toBe(false);
    expect(serverAcceptsDob("2010-07-29")).toBe(false);
  });
});

describe("updateUserSchema — same rules on the edit path", () => {
  it("accepts an empty patch", () => {
    expect(updateUserSchema.safeParse({}).success).toBe(true);
  });

  it("applies the DOB bounds", () => {
    expect(updateUserSchema.safeParse({ dateOfBirth: "3025-01-01" }).success).toBe(false);
    expect(updateUserSchema.safeParse({ dateOfBirth: "2015-01-01" }).success).toBe(false);
    expect(updateUserSchema.safeParse({ dateOfBirth: "1990-01-01" }).success).toBe(true);
  });

  it("preserves the empty string that clears a stored date", () => {
    const r = updateUserSchema.safeParse({ dateOfBirth: "", dateOfJoining: "" });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ dateOfBirth: "", dateOfJoining: "" });
  });

  it("applies the cross-field rule when the patch carries both dates", () => {
    const r = updateUserSchema.safeParse({
      dateOfBirth: "2000-06-01",
      dateOfJoining: "2015-06-01",
    });
    expect(r.success).toBe(false);
  });
});
