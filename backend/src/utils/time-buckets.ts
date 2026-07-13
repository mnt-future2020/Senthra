// Pure date-bucketing helpers for dashboard trend series. UTC throughout so buckets
// are deterministic regardless of server timezone. No Prisma, no I/O.

function ymKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** N ascending `YYYY-MM` keys, the last being the anchor's month. */
export function monthKeysBack(n: number, anchor: Date): string[] {
  const keys: string[] = [];
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  for (let i = n - 1; i >= 0; i--) {
    keys.push(ymKey(new Date(Date.UTC(y, m - i, 1))));
  }
  return keys;
}

/** Sum `value` into N monthly buckets ending at the anchor month; empty months → 0. */
export function bucketByMonth(
  rows: Array<{ at: Date; value: number }>,
  n: number,
  anchor: Date,
): Array<{ period: string; totalPence: number }> {
  const keys = monthKeysBack(n, anchor);
  const totals = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const r of rows) {
    const k = ymKey(r.at);
    if (totals.has(k)) totals.set(k, (totals.get(k) ?? 0) + r.value);
  }
  return keys.map((period) => ({ period, totalPence: totals.get(period) ?? 0 }));
}

// ISO-week bucketing: label each week by the UTC date of its Monday (`YYYY-MM-DD`).
function mondayOf(d: Date): Date {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
}

/** N ascending week keys (Monday dates), the last being the anchor's week. */
export function isoWeekKeysBack(n: number, anchor: Date): string[] {
  const monAnchor = mondayOf(anchor);
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(monAnchor);
    d.setUTCDate(d.getUTCDate() - i * 7);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

/** Count rows into N weekly buckets ending at the anchor week; empty weeks → 0. */
export function bucketByWeek(rows: Array<{ at: Date }>, n: number, anchor: Date): number[] {
  const keys = isoWeekKeysBack(n, anchor);
  const idx = new Map<string, number>(keys.map((k, i) => [k, i]));
  const counts = new Array<number>(n).fill(0);
  for (const r of rows) {
    const k = mondayOf(r.at).toISOString().slice(0, 10);
    const i = idx.get(k);
    if (i !== undefined) counts[i] += 1;
  }
  return counts;
}

/** Sum `value` into N weekly buckets (keyed by the week's Monday) ending at the anchor week. */
export function bucketValueByWeek(
  rows: Array<{ at: Date; value: number }>,
  n: number,
  anchor: Date,
): Array<{ period: string; totalPence: number }> {
  const keys = isoWeekKeysBack(n, anchor);
  const totals = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const r of rows) {
    const k = mondayOf(r.at).toISOString().slice(0, 10);
    if (totals.has(k)) totals.set(k, (totals.get(k) ?? 0) + r.value);
  }
  return keys.map((period) => ({ period, totalPence: totals.get(period) ?? 0 }));
}

/** N ascending `YYYY-MM-DD` day keys, the last being the anchor's UTC day. */
export function dayKeysBack(n: number, anchor: Date): string[] {
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() - i));
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

/** Sum `value` into N daily buckets ending at the anchor day; empty days → 0. */
export function bucketValueByDay(
  rows: Array<{ at: Date; value: number }>,
  n: number,
  anchor: Date,
): Array<{ period: string; totalPence: number }> {
  const keys = dayKeysBack(n, anchor);
  const totals = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const r of rows) {
    const k = r.at.toISOString().slice(0, 10);
    if (totals.has(k)) totals.set(k, (totals.get(k) ?? 0) + r.value);
  }
  return keys.map((period) => ({ period, totalPence: totals.get(period) ?? 0 }));
}
