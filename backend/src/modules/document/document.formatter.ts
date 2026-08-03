// Document Platform — regional-aware formatting primitives. Pure; reused by every document type
// and by future exports. The ONE place money + dates are formatted for documents.

// Format integer pence as a currency string (e.g. 123456 → "£1,234.56"). Falls back to a plain
// "<CCY> 0.00" if the runtime can't resolve the currency (never throws).
export function formatMoney(pence: number | null | undefined, currency = "GBP"): string {
  const amount = (pence ?? 0) / 100;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function dateParts(value: Date, timeZone: string): { day: string; month: string; year: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(value);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: get("day"), month: get("month"), year: get("year") };
}

// Format a date per the configured regional dateFormat, in the configured timezone. Empty/invalid
// input → "". Default DD/MM/YYYY (UK).
export function formatDate(
  value: Date | string | null | undefined,
  dateFormat = "DD/MM/YYYY",
  timeZone = "Europe/London",
): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const { day, month, year } = dateParts(d, timeZone);
  switch (dateFormat) {
    case "MM/DD/YYYY":
      return `${month}/${day}/${year}`;
    case "YYYY-MM-DD":
      return `${year}-${month}-${day}`;
    default:
      return `${day}/${month}/${year}`;
  }
}

// Format a timestamp (date + time) per the regional prefs — used in document metadata footers and in
// CSV exports. `seconds` is for the audit trail: two entries in the same minute are ordinary there,
// and minute precision would make their sequence unreadable in the exported file.
export function formatDateTime(
  value: Date | string | null | undefined,
  regional: { dateFormat: string; timeFormat: string; timezone: string },
  opts: { seconds?: boolean } = {},
): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const datePart = formatDate(d, regional.dateFormat, regional.timezone);
  const timePart = new Intl.DateTimeFormat("en-GB", {
    timeZone: regional.timezone,
    hour: "2-digit",
    minute: "2-digit",
    ...(opts.seconds ? { second: "2-digit" as const } : {}),
    hour12: regional.timeFormat === "12h",
  }).format(d);
  return `${datePart} ${timePart}`;
}
