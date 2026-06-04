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
}

export type Principal = AdminPrincipal | UserPrincipal;

// Back-compat alias for admin-facing components that read `useAuth().admin`.
export type Admin = AdminPrincipal;

// Where each principal type lands after authentication.
export function homeFor(principal: Principal): string {
  return principal.type === "admin" ? "/dashboard" : "/portal";
}
