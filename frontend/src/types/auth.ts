// The authenticated principal returned by the backend — either the super-admin
// account or a staff user. Never includes secrets.

export interface AdminPrincipal {
  type: "admin";
  id: string;
  email: string;
  name: string | null;
}

export interface UserRoleRef {
  id: string;
  key: string;
  name: string;
}

export interface UserPrincipal {
  type: "user";
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  profileImageUrl: string | null;
  status: string;
  mustResetPassword: boolean;
  role: UserRoleRef | null;
  // Effective permissions (the assigned role's permissions; "*" = all).
  permissions: string[];
}

export type Principal = AdminPrincipal | UserPrincipal;

// Back-compat alias for admin-facing components that read `useAuth().admin`.
export type Admin = AdminPrincipal;

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
];

// The first dashboard section this principal can open, or null if they have none.
export function firstDashboardPath(principal: Principal | null): string | null {
  if (!principal) return null;
  for (const section of DASHBOARD_SECTIONS) {
    if (section.anyOf.some((p) => principalCan(principal, p))) return section.path;
  }
  return null;
}

// Does this principal have access to at least one dashboard section?
export function canAccessDashboard(principal: Principal | null): boolean {
  return firstDashboardPath(principal) !== null;
}

// Where to send a principal after authentication. Everyone enters the unified
// dashboard shell: the shell intercepts a first-login user with the set-password
// screen, and the dashboard landing routes on to their first section (or the
// no-access home). The principal is kept in the signature so this stays the single
// place that decides post-auth routing, even though it's the same shell for all.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function homeFor(_principal: Principal): string {
  return "/dashboard";
}

// An active device session for the current principal.
export interface DeviceSession {
  id: string;
  current: boolean;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
}
