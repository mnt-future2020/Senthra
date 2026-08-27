import type { FinanceSummary } from "@/services/reports.service";

// Presentation helpers ONLY. Nothing here computes a financial figure — every number rendered by the
// Finance screens was produced by the backend's canonical finance service. These functions turn pence
// into strings and nothing more, which is the boundary that keeps the dashboard, the report and the
// CSV export showing the same values.

/** "£41,250.00" — full precision, for a figure someone reconciles against. */
export function money(pence: number): string {
  return `£${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "£41.3k" — for axis labels and tiles where the exact penny would not fit or help. */
export function moneyCompact(pence: number): string {
  const p = pence / 100;
  const abs = Math.abs(p);
  if (abs >= 1_000_000) return `£${(p / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `£${(p / 1_000).toFixed(1)}k`;
  return `£${p.toFixed(0)}`;
}

/** A trend bucket key → an axis label. "2026-09" → "Sep", "2026-09-04" → "4 Sep". */
export function bucketLabel(bucket: string, grain: "day" | "month"): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m, d] = bucket.split("-");
  const mon = months[Number(m) - 1] ?? m;
  return grain === "month" ? `${mon} ${y.slice(2)}` : `${Number(d)} ${mon}`;
}

/**
 * The one-line statement of what the report counted.
 *
 * Rendered on the screen and written into the CSV header, because "spend" is a business definition
 * and the reader has to be able to see which one produced the number in front of them — especially
 * while the client's answer on "PO raised" is still open.
 */
export function basisLine(summary: FinanceSummary): string {
  return `Dated by ${summary.basis.dateField} · ${summary.basis.statuses.length} statuses counted · excludes ${summary.basis.excluded.join(" and ")}`;
}

/** Share of the total, for a breakdown bar. Guards the empty-period divide-by-zero. */
export function shareOf(netPence: number, totalPence: number): number {
  return totalPence > 0 ? Math.max(0, Math.min(1, netPence / totalPence)) : 0;
}
