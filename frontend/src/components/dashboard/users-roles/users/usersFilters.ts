import { dateRangeActive } from "@/components/ui/DateRangeFilter";

// ── What "this list is narrowed" means on the staff directory, as a pure decision ───────────────
//
// Extracted from UsersView for the reason this codebase already extracts reportsTabs and
// popoverPlacement: the frontend suite runs in Node with no renderer, so a rule living inside a
// component is a rule nothing can assert. Both rules below had already drifted:
//
//   • The Filters trigger counted the Added-date range and nothing else, because the range was the
//     only thing behind it. Role has now moved in beside it, and a count that ignores an active
//     filter is worse than no count at all — the whole bargain of folding a filter away is that the
//     badge still says the list is narrowed. See FilterPopover.
//   • The empty state asked a DIFFERENT question and got it wrong: it looked at search, status and
//     role but never at the date range, so filtering to a week with no signups answered "Add your
//     first user to get started" on a directory holding six people.
//
// Two questions, two functions, because they genuinely differ: the count is about what is folded
// behind the trigger, "is anything narrowing this list" is about every control on the toolbar.
//
// SORT IS NOT A FILTER in either. Re-ordering a list cannot empty it, and a sort that pushed the
// badge to 1 would report a narrowing that never happened.

export interface UsersFilterState {
  /** The search box, already trimmed. */
  search: string;
  /** `"all"` when unset — the Select's own value for "no status chosen". */
  status: string;
  /** `"all"` when unset. */
  role: string;
  /** `""` when unset. Calendar dates, resolved to company-timezone days by the SERVER. */
  addedFrom: string;
  addedTo: string;
}

/**
 * How many of the filters FOLDED BEHIND the Filters trigger are set — the number the badge shows.
 *
 * A date range counts once however many of its two ends are filled, which is what `dateRangeActive`
 * exists to say and what every other popover in the app means by a range.
 */
export function usersPopoverFilterCount(f: UsersFilterState): number {
  return (f.role !== "all" ? 1 : 0) + (dateRangeActive(f.addedFrom, f.addedTo) ? 1 : 0);
}

/**
 * Is anything narrowing the list — folded away or not?
 *
 * Drives which empty state an empty page shows, so it must cover every control that can cause one.
 * "No users found / Add your first user to get started" is a claim about the DATABASE; saying it to
 * someone holding a filter is telling them their colleagues do not exist.
 */
export function usersHasFilters(f: UsersFilterState): boolean {
  return (
    Boolean(f.search) ||
    f.status !== "all" ||
    usersPopoverFilterCount(f) > 0
  );
}
