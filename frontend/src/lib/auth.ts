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
// no-access home. (audit.view has no screen yet, so it isn't a section.)
export const DASHBOARD_SECTIONS: { path: string; anyOf: string[] }[] = [
  { path: "/dashboard/settings", anyOf: ["settings.view", "email_templates.view"] },
  { path: "/dashboard/users", anyOf: ["users.view", "roles.view"] },
  { path: "/dashboard/customers", anyOf: ["customers.view"] },
  { path: "/dashboard/warehouses", anyOf: ["warehouse.view"] },
  { path: "/dashboard/suppliers", anyOf: ["suppliers.view"] },
  { path: "/dashboard/irm", anyOf: ["irm.view"] },
  { path: "/dashboard/purchase-orders", anyOf: ["purchase_orders.view"] },
  { path: "/dashboard/goods-in", anyOf: ["goods_in.view"] },
  { path: "/dashboard/inventory", anyOf: ["inventory.view"] },
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
