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
  signatureUrl: string | null;
  status: string;
  mustResetPassword: boolean;
  role: UserRoleRef | null;
  // Effective permissions (the assigned role's permissions; "*" = all).
  permissions: string[];
  // True when the user's role is warehouse-scoped (Role.isWarehouseScoped). Optional so a principal
  // cached before this field shipped still type-checks; always read as `=== true`.
  isWarehouseScoped?: boolean;
}

// An external customer (Customer PM). Read-only, scoped to a single customer
// account. Logs in via the shared /login and lands on the separate /customer
// portal. Permissions are a fixed read-only set from the backend (never a role).
export interface CustomerPrincipal {
  type: "customer";
  id: string; // the signed-in CustomerUser id
  customerId: string; // the company they belong to
  email: string; // the user's login email
  name: string; // company name
  userName: string; // the signed-in person's name
  customerCode: string;
  logoUrl: string | null;
  mustResetPassword: boolean;
  permissions: string[];
}

export type Principal = AdminPrincipal | UserPrincipal | CustomerPrincipal;

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
