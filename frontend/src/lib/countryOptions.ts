// The country suggestions offered wherever a free-text country is entered — customer, site and job
// addresses. Shared rather than repeated because it was not: the customer form offered six, while
// the site and job forms each offered a lone "United Kingdom", so the same field suggested different
// things depending on which screen you reached it from.
//
// A SUGGESTION list, not a validation list. The field stays free text everywhere — this only decides
// what the dropdown offers, so adding a country here is safe and removing one breaks nothing stored.
export const COUNTRY_OPTIONS = [
  "United Kingdom",
  "Ireland",
  "France",
  "Germany",
  "Netherlands",
  "Spain",
] as const;
