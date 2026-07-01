// Auth / permission helpers and post-login routing. The principal *types* live in
// `@/types/auth`; the *logic* that operates on them lives here (lib), keeping the
// types module free of runtime code.

import type { Principal } from "@/types/auth";

// Does a principal hold a permission? The super-admin account holds everything.
export function principalCan(principal: Principal | null, permission: string): boolean {
  if (!principal) return false;
  if (principal.type === "admin") return true;
  return principal.permissions.includes("*") || principal.permissions.includes(permission);
}

// The dashboard sections, in landing-priority order, each with the permission(s)
// that reveal it. Every authenticated user enters the same shell; the first section
// they're allowed to see becomes their landing, and a user with none gets the
// no-access home. Kept in lockstep with the Sidebar nav (and each page's own
// PermissionGate) so every section a user can navigate to is also a valid landing —
// otherwise a role that only has, say, Jobs would land on the no-access home despite
// seeing Jobs in the nav. (IRM is intentionally absent: the standalone /dashboard/irm
// now redirects into the inventory.view-gated Inventory Hub, so it isn't an
// independent landing.)
export const DASHBOARD_SECTIONS: { path: string; anyOf: string[] }[] = [
  // Settings admits categories.view too — the Categories master lives as a Settings section (see the
  // Sidebar + settings page gate), so a categories-only role must land somewhere real.
  { path: "/dashboard/settings", anyOf: ["settings.view", "email_templates.view", "categories.view"] },
  { path: "/dashboard/users", anyOf: ["users.view", "roles.view"] },
  { path: "/dashboard/customers", anyOf: ["customers.view"] },
  { path: "/dashboard/jobs", anyOf: ["jobs.view"] },
  { path: "/dashboard/warehouses", anyOf: ["warehouse.view"] },
  { path: "/dashboard/suppliers", anyOf: ["suppliers.view"] },
  { path: "/dashboard/purchase-orders", anyOf: ["purchase_orders.view"] },
  { path: "/dashboard/goods-in", anyOf: ["goods_in.view"] },
  { path: "/dashboard/inventory", anyOf: ["inventory.view"] },
  // Engineer Portal — kept after the admin modules so a staff user with real module access lands there
  // first; an engineer-only user (no other sections) falls through to their own portal dashboard.
  { path: "/dashboard/engineer", anyOf: ["engineer.dashboard.view"] },
  // Audit log — a trailing utility section (e.g. a compliance/auditor role); a user lands here only
  // when it's their sole section, never ahead of a real operational module or the engineer portal.
  { path: "/dashboard/audit", anyOf: ["audit.view"] },
];

// The customer portal's landing inside the shared dashboard shell — the portal
// Dashboard (overview), from which the rest of their read-only sections branch.
export const CUSTOMER_HOME = "/dashboard/portal";

// The first dashboard section this principal can open, or null if they have none.
// A customer is an external read-only principal: they don't hold staff permissions,
// so they always land on their own portal Dashboard rather than a staff section.
export function firstDashboardPath(principal: Principal | null): string | null {
  if (!principal) return null;
  if (principal.type === "customer") return CUSTOMER_HOME;
  for (const section of DASHBOARD_SECTIONS) {
    if (section.anyOf.some((p) => principalCan(principal, p))) return section.path;
  }
  return null;
}

// Does this principal have access to at least one dashboard section? (A customer
// always has their My Stock section.)
export function canAccessDashboard(principal: Principal | null): boolean {
  return firstDashboardPath(principal) !== null;
}

// Where to send a principal after authentication. Everyone enters the unified
// dashboard shell: the shell intercepts a first-login principal with the
// set-password screen, then the landing routes to their first section. A staff user
// lands on their first permitted section (or the no-access home); a customer lands
// on their read-only My Stock. The single place that decides post-auth routing.
export function homeFor(principal: Principal): string {
  if (principal.type === "customer") return CUSTOMER_HOME;
  return "/dashboard";
}
