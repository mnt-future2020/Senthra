// How long a job has been sitting, for the Goods Management queue.
//
// The queue had no time signal at all: every row looked equally fresh, and the default order is
// newest-job-first, so a request nobody has touched in six weeks sinks below newer ones and is never
// seen again. Nothing else catches it either — the Overdue section is driven by issue MOVEMENTS, so a
// job that was never issued cannot appear there by construction.
//
// The anchor is the last goods movement, falling back to when the job was raised. A job that has never
// moved is exactly the case that needs surfacing, so it has to age from somewhere rather than be
// treated as ageless.

/** Whole days between `iso` and `now`, or null if the timestamp is missing/unparseable. */
export function daysSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  // Floored, and never negative: a clock skew between server and browser shouldn't render "-1d".
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/**
 * Age of a queue row in whole days — last movement if there is one, otherwise since the job was raised.
 * Returns null only when neither timestamp is usable.
 */
export function jobAgeDays(
  row: { lastActivityAt: string | null; createdAt: string },
  now: number = Date.now(),
): number | null {
  return daysSince(row.lastActivityAt ?? row.createdAt, now);
}

/**
 * Tone for an age badge, derived from the CONFIGURED overdue window (Settings → Operations) rather than
 * a constant. `overdueDays` is the same number the Overdue tab and the Inventory Hub count with, so the
 * amber badge here means exactly "this is now overdue" — change the setting and all three move together.
 * Hardcoding 14/30 here, as this did, meant an admin moving the window to 45 left the Queue flagging
 * jobs at day 14 that were no longer overdue by the company's own rule, one tab away from the list that
 * disagreed.
 *
 * Amber at the threshold, red at twice it: the second step is "this stopped being a nudge", which scales
 * with whatever the business considers late instead of pinning to a month.
 */
export function ageTone(days: number | null, overdueDays: number): "normal" | "warn" | "bad" {
  if (days === null) return "normal";
  if (days >= overdueDays * 2) return "bad";
  if (days >= overdueDays) return "warn";
  return "normal";
}

/** UK short date for a row timestamp; em dash when absent, matching the tables elsewhere. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB");
}
