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

export const EMPTY_SUBMISSION_FILTERS: SubmissionFilters = { search: "", status: ALL };

export function hasActiveSubmissionFilter(f: SubmissionFilters): boolean {
  return f.search.trim() !== "" || f.status !== ALL;
}

// Search covers BOTH names: `editedName` is what the reviewer renamed it to and what the row
// displays, but the customer still calls it by the name they submitted. Matching only the displayed
// one would lose the row for whoever is on the phone.
export function filterSubmissions<T extends SubmissionLike>(rows: T[], f: SubmissionFilters): T[] {
  const term = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.status !== ALL && r.status !== f.status) return false;
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

export function submissionStatusOptions(rows: SubmissionLike[]): SubmissionOption[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);

  const known = STATUS_ORDER.filter((s) => counts.has(s));
  const unknown = [...counts.keys()]
    .filter((s) => !STATUS_ORDER.includes(s as (typeof STATUS_ORDER)[number]))
    .sort();

  return [
    { value: ALL, label: `All statuses (${rows.length})` },
    ...[...known, ...unknown].map((s) => ({
      value: s,
      label: `${STATUS_LABELS[s] ?? s} (${counts.get(s) ?? 0})`,
    })),
  ];
}

// A pick whose option has gone (its last row was rejected away, say) falls back to ALL rather than
// stranding the tab on an empty list. Derived, so the pick returns if the rows do.
export function effectiveSubmissionFilters(
  f: SubmissionFilters,
  statusOptions: SubmissionOption[],
): SubmissionFilters {
  return {
    search: f.search,
    status: statusOptions.some((o) => o.value === f.status) ? f.status : ALL,
  };
}
