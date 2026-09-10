// Pure sidebar-nav visibility rules — extracted from the Sidebar component so the logic is
// unit-testable without rendering React. The Sidebar imports `isAdminNavItemVisible` and applies
// it to each admin nav item.

import type { Principal } from "@/types/auth";

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

// The line under the brand name in the sidebar. It used to fall back to "Admin Suite" for every
// staff user, telling a Finance Director or Project Manager they were in the admin suite. It now
// claims only what is true:
//   • customer → "Customer Portal"; pure engineer → "Engineer Portal" (their whole surface);
//   • the super-admin account → "Admin Suite" (it IS the admin);
//   • any other staff user → their role's display name, read from the live role, so a rename in
//     Users & Roles shows on the next page load. A user with no role → "Staff Portal".
export function sidebarSurfaceLabel(principal: Principal | null, isEngineerOnly: boolean): string {
  if (!principal) return "";
  if (principal.type === "customer") return "Customer Portal";
  if (principal.type === "admin") return "Admin Suite";
  if (isEngineerOnly) return "Engineer Portal";
  return principal.role?.name.trim() || "Staff Portal";
}
