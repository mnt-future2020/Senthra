// ── "Is this job late, and by how much?" ───────────────────────────────────────────────────────
//
// One definition, used by the row flag on the jobs list AND matching the `?status=overdue` filter in
// job.repository's buildWhere. That pairing is the whole point: the "Jobs overdue" badge counts rows,
// the filter opens them, and the list marks them — three surfaces that must name the same set.
//
// WHY THE SERVER ANSWERS THIS. "Today" is the start of today in the COMPANY's timezone, a Settings
// value. The browser only knows its own clock, so a viewer in IST looking at a London company would
// draw the red marks against a different midnight than the badge counted against — a job would be
// red with no matching count, or counted with no red row. The client is handed the answer, never the
// inputs to recompute it.
//
// `daysLate` travels with the flag for the same reason: deriving "26d late" from `new Date()` in the
// browser reintroduces exactly the drift the boolean just avoided.

const DAY_MS = 86_400_000;

/** The statuses a job can be late IN. Mirrors job.repository's ACTIVE_JOB_STATUSES. */
export const OVERDUE_ELIGIBLE_STATUSES = ["assigned", "accepted", "in_progress"] as const;

export interface JobOverdue {
  overdue: boolean;
  /** Whole days past due, ≥ 1 when overdue; null when it isn't. */
  daysLate: number | null;
}

/**
 * @param completionDate the job's due date (null = no date set, which is never overdue)
 * @param status         the job's current status
 * @param dayStart       start of today in the COMPANY timezone — from startOfDayIn, never from `new Date()`
 *
 * A completed or cancelled job is NOT overdue however old its due date: the work is finished or
 * abandoned, so there is nothing left to chase. That is the same narrowing buildWhere applies, and
 * without it the list would redden rows nobody can act on and the badge would never agree.
 */
export function jobOverdue(completionDate: Date | null | undefined, status: string, dayStart: Date): JobOverdue {
  if (!completionDate) return { overdue: false, daysLate: null };
  if (!(OVERDUE_ELIGIBLE_STATUSES as readonly string[]).includes(status)) return { overdue: false, daysLate: null };
  const due = completionDate.getTime();
  const today = dayStart.getTime();
  // `<` not `<=`, matching buildWhere: a job due TODAY is due, not late.
  if (!(due < today)) return { overdue: false, daysLate: null };
  // Ceil, so a due date carrying a time-of-day still reads as a whole day late rather than as 0.
  // A job due yesterday at 14:00 is "1d late", not "0d late".
  return { overdue: true, daysLate: Math.max(1, Math.ceil((today - due) / DAY_MS)) };
}
