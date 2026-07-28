// Client-side validation primitives (UK-aware) shared by the user + customer forms.
// They give instant, field-level feedback before the request; the backend stays the
// source of truth (defence in depth).

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Standard UK postcode shape, e.g. "EC1A 1BB", "M1 1AE", "GU16 7HF". The internal space is
// optional so "ls14dy" is accepted and then normalised by formatUkPostcode below — validation
// and normalisation are deliberately separate steps. "GIR 0AA" (Girobank) is the one real
// postcode that doesn't fit the general pattern, so it's an explicit alternative.
//
// The `i` flag is load-bearing for that GIR branch only (the general branch already spells out
// [A-Za-z]): the form validators and the site-import preview apply this to RAW input, so without
// it "gir0aa" would be rejected in exactly the places where "ls14dy" is accepted.
export const UK_POSTCODE_RE = /^(GIR\s*0AA|[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2})$/i;

// "ls14dy" → "LS1 4DY". MUST stay in lockstep with the backend's utils/postcode.ts: the client
// formats for instant feedback, the server formats for storage, and a disagreement would show
// the user one postcode and save another. The inward code is always exactly 3 characters, so
// canonical formatting is just "strip the spaces, re-insert one before the last 3".
//
// Anything that isn't a recognisable UK postcode is returned uppercased but NOT split — the
// field is often mid-typing, and inventing a space in the wrong place is worse than leaving it.
export function formatUkPostcode(value: string): string {
  const collapsed = value.trim().toUpperCase().replace(/\s+/g, " ");
  if (!UK_POSTCODE_RE.test(collapsed)) return collapsed;
  const compact = collapsed.replace(/\s+/g, "");
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

// UK phone only: national "0" + 9–10 digits (e.g. 07700 900000) or international
// "+44" with an optional "(0)" + 9–10 digits, after stripping spaces/hyphens/parens.
export const UK_PHONE_RE = /^(?:\+440?|0)\d{9,10}$/;

// Lenient website: empty, a bare domain, or a full http/https URL.
export const WEBSITE_RE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i;

// Normalize then test a UK phone number (tolerates spaces, hyphens and parens).
export const isPhone = (v: string): boolean => UK_PHONE_RE.test(v.replace(/[\s()-]/g, ""));

// ---------------------------------------------------------------------------
// Calendar dates + staff date policy
//
// MUST stay in lockstep with the backend's utils/validation.ts and
// modules/user/user.validation.ts. The client validates for instant feedback and
// to constrain the native date picker; the server is the only check an API call
// can't skip. A disagreement here shows the user an error the save wouldn't have
// hit, or lets them submit something the server then rejects.
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// True when `v` is "YYYY-MM-DD" AND names a date that actually exists. The
// round-trip rejects 2025-02-30 / 2025-13-01, which Date.UTC would otherwise roll
// forward into the following month rather than refuse.
export function isCalendarDate(v: string): boolean {
  if (!ISO_DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
  );
}

// Today in the USER'S timezone as "YYYY-MM-DD" — built from local components, not
// toISOString(), which would report tomorrow's date to anyone east of UTC late in
// the evening and reject a birth date they can legitimately enter.
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Whole years between two ISO dates, by calendar components — never millisecond
// arithmetic, which drifts across leap years.
export function yearsBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  let years = ty - fy;
  if (tm < fm || (tm === fm && td < fd)) years -= 1;
  return years;
}

// Shift an ISO date by whole years, clamping 29 Feb to 28 Feb in a non-leap year.
export function addYearsIso(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const targetY = y + years;
  const lastDay = new Date(Date.UTC(targetY, m, 0)).getUTCDate();
  return `${String(targetY).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

// 16 = UK school-leaving / lawful-employment age; 120 = an age bound rather than a
// hardcoded earliest year, so it can't silently go stale.
export const MIN_STAFF_AGE = 16;
export const MAX_STAFF_AGE = 120;
export const MAX_JOINING_YEARS_AHEAD = 1;

// The latest/earliest dates of birth a staff member may have — also fed to the
// date input's max/min so the native picker can't reach an invalid year at all.
export const latestDobIso = (today = todayIso()): string => addYearsIso(today, -MIN_STAFF_AGE);
export const earliestDobIso = (today = todayIso()): string => addYearsIso(today, -MAX_STAFF_AGE);
export const latestJoiningIso = (today = todayIso()): string =>
  addYearsIso(today, MAX_JOINING_YEARS_AHEAD);

// Date of birth is optional — "" is valid and means "not recorded".
export function validateDateOfBirth(value: string, today = todayIso()): string | undefined {
  if (!value) return undefined;
  if (!isCalendarDate(value)) return "Enter a valid date of birth.";
  if (value > today) return "Date of birth can't be in the future.";
  const age = yearsBetween(value, today);
  if (age < MIN_STAFF_AGE) return `Staff must be at least ${MIN_STAFF_AGE} years old.`;
  if (age > MAX_STAFF_AGE) return "Enter a valid date of birth — that's over 120 years ago.";
  return undefined;
}

// Date of joining. `required` is caller-driven so the same rules serve a form that
// demands it and one that doesn't.
export function validateDateOfJoining(
  value: string,
  opts: { required?: boolean; dateOfBirth?: string; today?: string } = {},
): string | undefined {
  const today = opts.today ?? todayIso();
  if (!value) return opts.required ? "Date of joining is required." : undefined;
  if (!isCalendarDate(value)) return "Enter a valid date of joining.";
  if (value > latestJoiningIso(today)) {
    return "Date of joining can't be more than a year in the future.";
  }
  // Cross-field: nobody joined before their 16th birthday. Only meaningful once
  // the birth date itself is valid, else we'd report this instead of the real fault.
  const dob = opts.dateOfBirth;
  if (dob && !validateDateOfBirth(dob, today) && value < addYearsIso(dob, MIN_STAFF_AGE)) {
    return `Date of joining is before this person turned ${MIN_STAFF_AGE}. Check both dates.`;
  }
  return undefined;
}
