import { describe, expect, it } from "vitest";

import {
  UK_POSTCODE_RE,
  earliestDobIso,
  formatUkPostcode,
  isCalendarDate,
  latestDobIso,
  latestJoiningIso,
  todayIso,
  validateDateOfBirth,
  validateDateOfJoining,
  yearsBetween,
} from "./validation";

// This MUST behave identically to the backend's utils/postcode.ts — the client formats for
// instant feedback, the server formats for storage, and a disagreement between the two would
// show the user one postcode and save another.
describe("formatUkPostcode", () => {
  it("uppercases a lowercase postcode typed without a space", () => {
    expect(formatUkPostcode("ls14dy")).toBe("LS1 4DY");
  });

  it.each([
    ["EC1A1BB", "EC1A 1BB"],
    ["m11ae", "M1 1AE"],
    ["b338th", "B33 8TH"],
    ["dn551pt", "DN55 1PT"],
    ["w1a0ax", "W1A 0AX"],
    ["gir0aa", "GIR 0AA"],
  ])("normalises %s to %s", (input, expected) => {
    expect(formatUkPostcode(input)).toBe(expected);
  });

  it("collapses stray internal whitespace", () => {
    expect(formatUkPostcode("LS1   4DY")).toBe("LS1 4DY");
  });

  it("trims surrounding whitespace", () => {
    expect(formatUkPostcode("  m1 1ae  ")).toBe("M1 1AE");
  });

  it("leaves an already-canonical postcode untouched", () => {
    expect(formatUkPostcode("LS1 4DY")).toBe("LS1 4DY");
  });

  it("returns an empty string unchanged", () => {
    expect(formatUkPostcode("")).toBe("");
  });

  it("does not split a partial postcode while the user is still typing", () => {
    expect(formatUkPostcode("ls1")).toBe("LS1");
  });

  it("uppercases but does not mangle unrecognisable input", () => {
    expect(formatUkPostcode("not a postcode")).toBe("NOT A POSTCODE");
  });
});

describe("UK_POSTCODE_RE", () => {
  it("accepts GIR 0AA, so the client agrees with the server on the one irregular postcode", () => {
    expect(UK_POSTCODE_RE.test("GIR 0AA")).toBe(true);
  });

  it.each(["LS1 4DY", "ls14dy", "EC1A 1BB", "M1 1AE", "DN55 1PT"])("accepts %s", (v) =>
    expect(UK_POSTCODE_RE.test(v)).toBe(true),
  );

  it.each(["", "LS1", "12345", "LS1 4D", "LS1 4DYZ"])("rejects %s", (v) =>
    expect(UK_POSTCODE_RE.test(v)).toBe(false),
  );

  // The form validators and the site-import preview apply this to RAW input. The general branch
  // is already case-insensitive via [A-Za-z]; the literal GIR branch needs the `i` flag to match,
  // or a spreadsheet cell reading "gir0aa" is rejected while "ls14dy" is accepted.
  it.each(["gir0aa", "Gir 0aa", "GIR 0AA"])("accepts %s whatever the case", (v) =>
    expect(UK_POSTCODE_RE.test(v)).toBe(true),
  );
});

// ---------------------------------------------------------------------------
// Staff date rules. These MUST agree with the backend (utils/validation.ts +
// modules/user/user.validation.ts): the client validates for instant feedback,
// the server is the check an API call can't skip, and a disagreement either
// blocks a legitimate entry or promises a save the server will refuse.
// ---------------------------------------------------------------------------

// A fixed "today" so no test can start failing on a birthday or a leap day.
const TODAY = "2026-07-27";

describe("isCalendarDate", () => {
  it.each(["1990-01-01", "2024-02-29", "2026-12-31"])("accepts the real date %s", (v) =>
    expect(isCalendarDate(v)).toBe(true),
  );

  // Date.parse would accept several of these: "Mar 5" silently becomes 2001-03-05.
  it.each(["Mar 5", "2024", "15/01/2024", "1990-1-1", "1990-01-01T00:00:00Z", ""])(
    "rejects the non-ISO input %s",
    (v) => expect(isCalendarDate(v)).toBe(false),
  );

  it.each(["2025-02-30", "2025-02-29", "2025-13-01", "2025-04-31", "2025-00-10"])(
    "rejects %s, which is not a day on the calendar",
    (v) => expect(isCalendarDate(v)).toBe(false),
  );
});

describe("yearsBetween", () => {
  it("counts by calendar, not by milliseconds", () => {
    expect(yearsBetween("2000-07-27", TODAY)).toBe(26); // birthday today
    expect(yearsBetween("2000-07-28", TODAY)).toBe(25); // birthday tomorrow
  });

  it("ages a leap-day birth correctly through a non-leap year", () => {
    expect(yearsBetween("2004-02-29", "2026-02-28")).toBe(21);
    expect(yearsBetween("2004-02-29", "2026-03-01")).toBe(22);
  });
});

describe("todayIso", () => {
  it("reads the LOCAL date, not the UTC one", () => {
    // 23:30 on the 27th in a UTC+1 zone is still the 27th locally, even though
    // toISOString() would report the 28th. Using UTC here would refuse a birth
    // date the user's own calendar says is valid.
    const localLateEvening = new Date(2026, 6, 27, 23, 30, 0);
    expect(todayIso(localLateEvening)).toBe("2026-07-27");
  });
});

describe("validateDateOfBirth", () => {
  it("treats an empty value as valid — the field is optional", () => {
    expect(validateDateOfBirth("", TODAY)).toBeUndefined();
  });

  it("accepts a plainly valid adult birth date", () => {
    expect(validateDateOfBirth("1990-05-20", TODAY)).toBeUndefined();
  });

  it("rejects a future date", () => {
    expect(validateDateOfBirth("2026-07-28", TODAY)).toMatch(/future/i);
    expect(validateDateOfBirth("3025-01-01", TODAY)).toMatch(/future/i);
  });

  it("rejects a date that is not on the calendar", () => {
    expect(validateDateOfBirth("1990-02-30", TODAY)).toMatch(/valid date of birth/i);
    expect(validateDateOfBirth("Mar 5", TODAY)).toMatch(/valid date of birth/i);
  });

  it("allows exactly 16 and rejects a day short of it", () => {
    expect(validateDateOfBirth("2010-07-27", TODAY)).toBeUndefined();
    expect(validateDateOfBirth("2010-07-28", TODAY)).toMatch(/at least 16/i);
  });

  it("rejects an implausibly old date", () => {
    expect(validateDateOfBirth("1800-01-01", TODAY)).toMatch(/120 years/i);
  });
});

describe("validateDateOfJoining", () => {
  it("is required only when the caller says so", () => {
    expect(validateDateOfJoining("", { required: true, today: TODAY })).toMatch(/required/i);
    expect(validateDateOfJoining("", { today: TODAY })).toBeUndefined();
  });

  it("allows a confirmed start date up to a year out, but no further", () => {
    expect(validateDateOfJoining("2027-07-27", { today: TODAY })).toBeUndefined();
    expect(validateDateOfJoining("2027-07-28", { today: TODAY })).toMatch(/more than a year/i);
  });

  it("rejects joining before the 16th birthday", () => {
    const err = validateDateOfJoining("2016-05-31", { dateOfBirth: "2000-06-01", today: TODAY });
    expect(err).toMatch(/before this person turned 16/i);
  });

  it("allows joining exactly on the 16th birthday", () => {
    expect(
      validateDateOfJoining("2016-06-01", { dateOfBirth: "2000-06-01", today: TODAY }),
    ).toBeUndefined();
  });

  it("stays silent about the pair when the birth date is itself invalid", () => {
    // Otherwise the user is told to "check both dates" when the real fault is a
    // single bad DOB that already has its own message.
    expect(
      validateDateOfJoining("2016-06-01", { dateOfBirth: "not-a-date", today: TODAY }),
    ).toBeUndefined();
  });
});

describe("date-picker bounds", () => {
  it("caps the birth-date picker at the 16-years-ago mark", () => {
    expect(latestDobIso(TODAY)).toBe("2010-07-27");
    expect(earliestDobIso(TODAY)).toBe("1906-07-27");
  });

  it("caps the joining picker a year out", () => {
    expect(latestJoiningIso(TODAY)).toBe("2027-07-27");
  });

  it("produces bounds that agree with the validators at the boundary", () => {
    expect(validateDateOfBirth(latestDobIso(TODAY), TODAY)).toBeUndefined();
    expect(validateDateOfBirth(earliestDobIso(TODAY), TODAY)).toBeUndefined();
    expect(validateDateOfJoining(latestJoiningIso(TODAY), { today: TODAY })).toBeUndefined();
  });
});
