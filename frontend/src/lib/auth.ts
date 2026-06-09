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
];

// The first dashboard section this principal can open, or null if they have none.
export function firstDashboardPath(principal: Principal | null): string | null {
  if (!principal) return null;
  for (const section of DASHBOARD_SECTIONS) {
    if (section.anyOf.some((p) => principalCan(principal, p))) return section.path;
  }
  return null;
}

// Does this principal have access to at least one dashboard section? Customers are
// never part of the admin dashboard — they have their own /customer portal.
export function canAccessDashboard(principal: Principal | null): boolean {
  if (principal?.type === "customer") return false;
  return firstDashboardPath(principal) !== null;
}

// Where to send a principal after authentication. Staff + the super-admin enter the
// unified dashboard shell (the shell intercepts a first-login user with the
// set-password screen, then the landing routes to their first section / the
// no-access home). An external customer goes to their own read-only portal. This is
// the single place that decides post-auth routing.
export function homeFor(principal: Principal): string {
  if (principal.type === "customer") return "/customer/stock";
  return "/dashboard";
}
