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

// An active device session for the current principal.
export interface DeviceSession {
  id: string;
  current: boolean;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
}
