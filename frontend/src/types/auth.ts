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
  status: string;
  mustResetPassword: boolean;
  role: UserRoleRef | null;
  // Effective permissions (the assigned role's permissions; "*" = all).
  permissions: string[];
}

export type Principal = AdminPrincipal | UserPrincipal;

// Back-compat alias for admin-facing components that read `useAuth().admin`.
export type Admin = AdminPrincipal;

// The permissions that map to an actual dashboard screen. A staff user holding
// ANY of these can enter the dashboard; otherwise they land on the staff portal.
// (audit.view is a valid, assignable permission but has no screen yet, so it
// doesn't grant dashboard entry on its own — add it back when an audit page ships.)
export const DASHBOARD_PERMISSIONS = [
  "users.manage",
  "settings.manage",
  "email_templates.manage",
] as const;

// Does a principal hold a permission? The super-admin account holds everything.
export function principalCan(principal: Principal | null, permission: string): boolean {
  if (!principal) return false;
  if (principal.type === "admin") return true;
  return principal.permissions.includes("*") || principal.permissions.includes(permission);
}

// Can this principal reach the dashboard (admin area) at all?
export function canAccessDashboard(principal: Principal | null): boolean {
  if (!principal) return false;
  if (principal.type === "admin") return true;
  // A staff user must set their own password before anything else — until then
  // they're held on the portal (the set-password screen), never the dashboard.
  if (principal.mustResetPassword) return false;
  return DASHBOARD_PERMISSIONS.some((p) => principalCan(principal, p));
}

// Where each principal lands after authentication.
export function homeFor(principal: Principal): string {
  return canAccessDashboard(principal) ? "/dashboard" : "/portal";
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
