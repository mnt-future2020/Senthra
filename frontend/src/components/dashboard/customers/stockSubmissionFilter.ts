// Search + status filtering for a customer's Stock Submissions tab.
//
// The list arrives inside the customer payload (`customer.stockRequests`) and was rendered whole —
// no search, no filter, no paging — even though submissions accumulate for the life of the account.
// This is the ONLY admin-side surface for reviewing them, and the customer's own portal view of the
// same data already had a status filter and paging, so the internal review screen was the weaker of
// the two.
//
// Pure so the matching rules are unit-testable without rendering the tab (no jsdom in this app's
// test setup), mirroring incomingStockFilter.ts next door.

export const ALL = "all";
// Pseudo-status: everything still needing action or partway through receiving. The detail payload
// now carries finished submissions too (so a short-closed one stays readable), and this is what
// keeps the tab OPENING on work-to-do instead of on years of history.
export const OPEN = "open";
export const OPEN_STATUSES = ["pending", "approved", "assigned", "partially_received"];

// Only the fields the controls read.
export interface SubmissionLike {
  name: string;
  editedName: string | null;
  status: string;
}

export interface SubmissionFilters {
  search: string;
  status: string; // ALL, or an exact status
}

// The tab OPENS here — on outstanding work, not on everything ever submitted. Also where Clear
// returns to: "cleared" means the DEFAULT view, not ALL. Clearing to ALL would dump the customer's
// whole history on someone who only wanted to drop a search term, so there is deliberately no
// separate "empty" constant to reach for.
export const DEFAULT_SUBMISSION_FILTERS: SubmissionFilters = { search: "", status: OPEN };

// Whether the user has moved AWAY from the default view — drives the Clear button and the
// "none match these filters" empty state. Sitting on the default is not "filtered".
export function hasActiveSubmissionFilter(f: SubmissionFilters): boolean {
  return f.search.trim() !== "" || f.status !== DEFAULT_SUBMISSION_FILTERS.status;
}

// Search covers BOTH names: `editedName` is what the reviewer renamed it to and what the row
// displays, but the customer still calls it by the name they submitted. Matching only the displayed
// one would lose the row for whoever is on the phone.
export function filterSubmissions<T extends SubmissionLike>(rows: T[], f: SubmissionFilters): T[] {
  const term = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.status === NEEDS_YOU) {
      if (!isActionable(r)) return false;
    } else if (f.status === OPEN) {
      if (!OPEN_STATUSES.includes(r.status)) return false;
    } else if (f.status !== ALL && r.status !== f.status) {
      return false;
    }
    if (!term) return true;
    return r.name.toLowerCase().includes(term) || (r.editedName ?? "").toLowerCase().includes(term);
  });
}

export interface SubmissionOption {
  value: string;
  label: string;
}

// Review order, not alphabetical: what still needs a decision comes first. Statuses with no rows are
// dropped so the menu can never filter the list to nothing, and counts come from the whole list so
// they hold still while you switch between them.
const STATUS_ORDER = ["pending", "approved", "assigned", "partially_received", "completed", "rejected"] as const;
const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  assigned: "Assigned",
  partially_received: "Partially received",
  completed: "Completed",
  rejected: "Rejected",
};

/**
 * Statuses where THIS screen still owes an action, and the tab badge counts them.
 *
 *   pending  — needs review          (Approve as-is / Edit & approve / Reject)
 *   approved — needs routing         (Assign warehouses)
 *
 * `assigned` and `partially_received` are deliberately absent: the outstanding work on those is
 * RECEIVING, which happens at the warehouse and is already counted there (wh.customer_intake). They
 * stay in the Open view because they are still in flight, but nobody on this tab owes anything.
 *
 * The badge and this list have to agree about what "needs me" means, or the number is just decoration
 * next to rows that don't explain it — which is exactly how a tab reading "2" came to open on four
 * rows with nothing marking the two.
 */
export const ACTIONABLE_STATUSES = ["pending", "approved"];

/**
 * Pseudo-status: exactly the rows the tab badge counted.
 *
 * This is how a count becomes reachable. The badge says 3; picking this shows those 3 and nothing
 * else — the list itself answers "which three", so nothing on the row has to shout it.
 *
 * The first attempt tinted those rows amber instead, and that was wrong twice over: the row already
 * carries its own signal (a row with "Approve as-is" or "Assign warehouses" is self-evidently
 * outstanding), and the default Open view contains actionable rows plus receiving-in-progress ones,
 * so the tint routinely covered MOST of the list. Highlighting works when it marks a minority; when
 * it marks three rows in four, the unmarked row becomes the signal instead.
 */
export const NEEDS_YOU = "needs_you";

/** Does this row still need something from whoever is looking at the Submissions tab? */
export function isActionable(row: SubmissionLike): boolean {
  return ACTIONABLE_STATUSES.includes(row.status);
}

export function submissionStatusOptions(rows: SubmissionLike[]): SubmissionOption[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);

  const known = STATUS_ORDER.filter((s) => counts.has(s));
  const unknown = [...counts.keys()]
    .filter((s) => !STATUS_ORDER.includes(s as (typeof STATUS_ORDER)[number]))
    .sort();

  const openCount = rows.filter((r) => OPEN_STATUSES.includes(r.status)).length;

  // When only ONE open status has rows, "Open" and that status select exactly the same rows — two
  // menu entries, one outcome, which reads as a bug ("Open (2)" next to "Partially received (2)").
  // Drop the individual one; Open already covers it, and it comes straight back the moment a second
  // open status appears and the two stop being interchangeable.
  //
  // Open itself is never dropped: it's the default view and where Clear returns to, so removing it
  // would strand the user on an option that no longer exists.
  const presentOpen = OPEN_STATUSES.filter((s) => counts.has(s));
  const redundantOpenStatus = presentOpen.length === 1 ? presentOpen[0] : null;

  const needsYouCount = rows.filter(isActionable).length;
  // Same rule as Open's: two entries selecting the same rows read as a bug. When every open row is
  // also actionable, "Needs you" and "Open" are the same list — keep Open, since it is the default
  // and where Clear returns to, and bring this back the moment the two differ.
  const needsYouRedundant = needsYouCount === openCount;

  return [
    // Open first — it's the default and the one people want most of the time. Always offered even at
    // zero, because it's the view the tab returns to on Clear.
    { value: OPEN, label: `Open (${openCount})` },
    // Directly under it: this is the number on the tab, and picking it shows exactly those rows.
    // Hidden at zero — an option that can only ever produce an empty list is not a choice.
    ...(needsYouCount > 0 && !needsYouRedundant
      ? [{ value: NEEDS_YOU, label: `Needs you (${needsYouCount})` }]
      : []),
    { value: ALL, label: `All statuses (${rows.length})` },
    ...[...known, ...unknown]
      .filter((s) => s !== redundantOpenStatus)
      .map((s) => ({
        value: s,
        label: `${STATUS_LABELS[s] ?? s} (${counts.get(s) ?? 0})`,
      })),
  ];
}

// A pick whose option has gone (its last row was rejected away, say) falls back to the DEFAULT view
// rather than stranding the tab on an empty list. Derived, so the pick returns if the rows do.
export function effectiveSubmissionFilters(
  f: SubmissionFilters,
  statusOptions: SubmissionOption[],
): SubmissionFilters {
  return {
    search: f.search,
    // Falls back to the DEFAULT view, not ALL: a pick that vanished (its last row moved status)
    // should land the user back where the tab normally opens, not on the full history.
    status: statusOptions.some((o) => o.value === f.status) ? f.status : DEFAULT_SUBMISSION_FILTERS.status,
  };
}
