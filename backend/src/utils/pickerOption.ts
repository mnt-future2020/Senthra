/**
 * The flag a picker option carries when its record is no longer ACTIVE.
 *
 * The lean option lists are active-only by default — nothing deactivated may be newly selected on a
 * create form. A HISTORY or report filter asks for deactivated records too (a retired customer still
 * owns its movements, stock and report rows), and this is how each such row tells the screen to label
 * it "(inactive)". Absent on every active row, so an active-only list is exactly what it always was.
 */
export function inactiveFlag(status: string | null | undefined): { inactive?: true } {
  return status && status !== "active" ? { inactive: true } : {};
}
