import type { SelectOption } from "@/components/ui/Select";

/**
 * Keep a SAVED selection visible even when it is no longer offered.
 *
 * Option lists for pickers are ACTIVE-only — you should not be able to newly choose a retired
 * supplier or customer. But a record saved months ago may reference one that has since been
 * deactivated, and the shared `Select` renders its PLACEHOLDER for any value it cannot find in
 * `options`. Without this, reopening that record shows "— Select a supplier —" on a purchase order
 * that plainly has one, and saving would quietly drop a real commercial fact.
 *
 * Note this is NOT the truncation problem — it needs no growth at all, just one deactivation.
 *
 * The saved value is appended (never inserted first, so it does not look like a default) and marked
 * "(inactive)", which is the convention `IrmItemForm` already uses for its type, category and
 * supplier links. The user can keep it or replace it with a live one; they cannot pick another
 * retired record, because nothing else inactive is in the list.
 */
export function withHistoricalOption(
  options: SelectOption[],
  savedId: string | null | undefined,
  savedLabel: string | null | undefined,
): SelectOption[] {
  if (!savedId || options.some((o) => o.value === savedId)) return options;
  // No label to show it by — appending a blank row would be worse than the placeholder, because it
  // reads as a real, choosable option that happens to be nameless.
  if (!savedLabel) return options;
  return [...options, { value: savedId, label: `${savedLabel} (inactive)` }];
}
