import type { RentalStatus } from "@/types/rental";

/**
 * What the "…" menu on a rental catalogue row offers, given the row and who is looking.
 *
 * A pure function rather than JSX so the RULE can be tested on its own — the frontend suite runs in
 * Node with no DOM (vitest.config.ts: "jsdom is opt-in per file", and no renderer is installed), so
 * a policy buried inside a component is a policy nothing can assert. The sibling test pins the two
 * things that actually go wrong here: a label that contradicts the row's status, and an action shown
 * to someone who cannot perform it.
 *
 * Deliberately mirrors IrmItemsView's inline menu — Edit · Activate/Deactivate · Delete, in that
 * order, delete last and separated — because the two catalogues sit beside each other under
 * Inventory and a menu that reorders itself between them reads as two different products.
 */
export type RentalRowActionKey = "edit" | "toggle-status" | "delete";

export interface RentalRowAction {
  key: RentalRowActionKey;
  /** The rendered label. For the status toggle it names the RESULT, not the current state. */
  label: string;
  /** Rendered in the destructive colour and behind a confirmation. */
  danger?: boolean;
}

/** The status a toggle would move the row to. */
export function nextRentalStatus(status: RentalStatus): RentalStatus {
  return status === "active" ? "inactive" : "active";
}

/**
 * The menu for one row.
 *
 * Permissions are the EXISTING pair and nothing else:
 *   rentals.edit   → Edit, and Activate/Deactivate (the permission's own description already says
 *                    "Edit rental items; activate / deactivate", so the toggle is covered by it —
 *                    no rentals.activate / rentals.deactivate is introduced here)
 *   rentals.delete → Delete
 *
 * The frontend only decides what to SHOW. Every one of these calls a route that re-checks the same
 * permission server-side, so hiding an entry is a courtesy, never the guard.
 */
export function rentalRowActions({
  status,
  canEdit,
  canDelete,
}: {
  status: RentalStatus;
  canEdit: boolean;
  canDelete: boolean;
}): RentalRowAction[] {
  const actions: RentalRowAction[] = [];
  if (canEdit) {
    actions.push({ key: "edit", label: "Edit" });
    // Names the result: an ACTIVE row offers "Deactivate". Reading the current state back at the
    // user is the classic version of this control that everyone mis-clicks.
    actions.push({ key: "toggle-status", label: status === "active" ? "Deactivate" : "Activate" });
  }
  if (canDelete) actions.push({ key: "delete", label: "Delete", danger: true });
  return actions;
}
