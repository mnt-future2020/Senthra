// Pure sidebar-nav visibility rules — extracted from the Sidebar component so the logic is
// unit-testable without rendering React. The Sidebar imports `isAdminNavItemVisible` and applies
// it to each admin nav item.

export interface NavVisibilityItem {
  // Visible if the principal holds ANY of these permissions (admin holds all). Empty = always
  // visible (e.g. the Dashboard landing).
  perms: string[];
  // Hide this item from a warehouse-scoped role even when they hold the permission. Used for
  // GLOBAL pages whose warehouse-scoped equivalent lives elsewhere: a warehouse manager holds
  // `audit.view` for the warehouse detail's "Audit trail" tab, but the top-level "Audit Log" page
  // is not their surface, so its nav entry is hidden for them.
  hideForWarehouseScoped?: boolean;
}

// Should this admin nav item show for the current principal?
//   1. A warehouse-scoped user never sees a `hideForWarehouseScoped` item.
//   2. A permless item (perms: []) is always visible.
//   3. Otherwise the principal must hold at least one of the item's perms.
export function isAdminNavItemVisible(
  item: NavVisibilityItem,
  can: (perm: string) => boolean,
  isWarehouseScoped: boolean,
): boolean {
  if (item.hideForWarehouseScoped && isWarehouseScoped) return false;
  if (item.perms.length > 0 && !item.perms.some((p) => can(p))) return false;
  return true;
}
