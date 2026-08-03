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

/**
 * Short day+month for a job's completion date — "5 Aug".
 *
 * Rendered in UTC, unlike `formatDay`. A completion date is a CALENDAR DATE, not an instant: it comes
 * from `<input type="date">` and is stored as UTC midnight. Formatting that in the viewer's local zone
 * shows the day before for anyone behind UTC, so the date-only value is read back on the same scale it
 * was written on.
 */
export function formatDueDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export type DueState = "past_due" | "today" | "upcoming";

/**
 * The due badge beside a queue row's job number.
 *
 * `dueState` is decided by the SERVER in the company timezone — never re-derived here — so the badge
 * and the due filter that selected the row can never disagree about which day it is.
 *
 * A job with no completion date gets an explicit "No due date" rather than nothing: such a job is
 * excluded by EVERY due filter, so it vanishes the moment one is applied. Rendering nothing would
 * leave that looking like lost data instead of a job nobody gave a deadline.
 */
export function dueBadge(
  dueState: DueState | null,
  completionDate: string | null,
): { label: string; cls: string; title: string } | null {
  if (!completionDate || !dueState) {
    return { label: "No due date", cls: "text-[var(--faint)]", title: "No completion date set — this job is hidden by every due-date filter." };
  }
  const day = formatDueDay(completionDate);
  if (dueState === "past_due") return { label: `Past due ${day}`, cls: "text-[var(--neg)]", title: `Completion date ${day} has passed.` };
  if (dueState === "today") return { label: "Due today", cls: "text-amber-600", title: `Completion date is today, ${day}.` };
  return { label: `Due ${day}`, cls: "text-[var(--faint)]", title: `Completion date ${day}.` };
}
