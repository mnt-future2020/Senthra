// The customer's PREFERRED warehouse on a stock submission — the small amount of logic that is
// easy to get subtly wrong, pulled out of the two components that need it so it can be tested
// without a DOM (this project has no component-render harness; pure helpers beside a .test.ts is
// the established pattern).
//
// The rule the whole feature rests on: a preference is a suggestion. It pre-fills the reviewer's
// choice and nothing else. Every predicate here is deliberately conservative about turning a
// preference into a selection.

export interface WarehouseOption {
  id: string;
  name: string;
  code: string;
}

export interface SelectOptionLike {
  value: string;
  label: string;
}

/**
 * Should the portal show the preferred-warehouse field at all?
 *
 * Hidden until the list has loaded, and hidden entirely when it comes back empty — an empty
 * dropdown reads as a broken field. The list is every ACTIVE, non-deleted warehouse, so empty
 * means the company has none; the preference is optional, so hiding it never blocks a
 * submission.
 */
export function shouldShowPreferredWarehouse(loaded: boolean, options: WarehouseOption[]): boolean {
  return loaded && options.length > 0;
}

/**
 * The value to pre-select when the warehouse list arrives.
 *
 * One option → select it (the app's `firstActiveId` convention for a single-choice reference
 * list). Two or more → "" (no preference); guessing a destination on the customer's behalf is
 * exactly the thing this feature must not do.
 */
export function autoSelectedWarehouseId(options: WarehouseOption[]): string {
  return options.length === 1 ? options[0].id : "";
}

/** Options for the portal's Select, with the app's standard clearable "" entry first. */
export function preferredWarehouseOptions(options: WarehouseOption[]): SelectOptionLike[] {
  return [
    { value: "", label: "No preference" },
    ...options.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` })),
  ];
}

/**
 * Should the reviewer's Assign-to-warehouses modal pre-fill its first row from the preference?
 *
 * Four conditions, all required:
 *  - a preference exists;
 *  - that warehouse is still in the ACTIVE list the modal loaded (one deactivated since
 *    submission must never be pre-selected into a real assignment);
 *  - there is exactly one row (the untouched initial state) — never re-arrange a split in progress;
 *  - that row has no warehouse yet, so the modal never overwrites the reviewer's own choice.
 */
export function shouldPrefillAssignment(
  preferredWarehouseId: string | null | undefined,
  activeWarehouses: WarehouseOption[],
  rows: { warehouseId: string }[],
): boolean {
  if (!preferredWarehouseId) return false;
  if (!activeWarehouses.some((w) => w.id === preferredWarehouseId)) return false;
  return rows.length === 1 && !rows[0].warehouseId;
}

// ── The customer's view of their own preference, after the fact ────────────────────────────────
//
// A preference is not the destination — a reviewer assigns the real one and may split it. So the
// portal has to answer a question the staff screens never ask: "I asked for X; what actually
// happened?" Left unanswered, a customer who preferred TESTING WARE and later reads
// "Where it went: London Logistics Hub" has no way to tell an override from a mistake.
export type PreferenceOutcome =
  /** Preference recorded, still being reviewed or awaiting assignment. */
  | "pending"
  /** The submission was rejected, so the preference was never acted on. */
  | "rejected"
  /** Every warehouse the stock went to IS the preferred one. */
  | "honoured"
  /** The preferred warehouse was used, alongside at least one other (a split). */
  | "split"
  /** The preferred warehouse was not used at all. */
  | "changed";

/**
 * Classify what became of the customer's preference. `null` when they expressed none — there is
 * then nothing to report and the row is omitted entirely.
 *
 * `status` is required, not optional: a REJECTED submission has no assignments, and judging by
 * assignments alone classified it as "pending" — telling a customer whose request was turned down
 * that their account team is still confirming the destination. Rejection is only consulted when
 * nothing was assigned; if legs somehow exist they are the truth and are reported as such.
 * (`rejectStockRequest` only accepts a `pending` request, so a rejected row provably has no legs —
 * the ordering below is belt-and-braces, not a live branch.)
 *
 * Matched on NAME because that is the only warehouse handle the portal shape carries (ids and
 * codes are deliberately withheld — see PortalWarehouseAssignment). Both strings come from the
 * same `Warehouse.name` column, so equality is exact rather than fuzzy. Two DISTINCT warehouses
 * sharing a name would read as "honoured" when it was really "changed" — a cosmetic mislabel on
 * an explanatory line, never a data or access error, and the assignment list beside it still shows
 * the truth.
 */
export function preferenceOutcome(
  preferredWarehouseName: string | null | undefined,
  legWarehouseNames: string[],
  status: string,
): PreferenceOutcome | null {
  if (!preferredWarehouseName) return null;
  if (legWarehouseNames.length === 0) return status === "rejected" ? "rejected" : "pending";
  const matches = legWarehouseNames.filter((n) => n === preferredWarehouseName).length;
  if (matches === 0) return "changed";
  return matches === legWarehouseNames.length ? "honoured" : "split";
}
