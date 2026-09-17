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

/**
 * Returned by POST /auth/login (202) when the account must still complete an emailed OTP.
 *
 * Carries no principal and no token, because at this point NO session exists on the server. The
 * challenge itself lives in an httpOnly cookie the page cannot read.
 */
export interface TwoFactorPending {
  twoFactorRequired: true;
  /** Already masked by the server, e.g. "j•••@acme.com". */
  email: string;
  /**
   * DURATIONS in seconds, not instants — the page counts them down against its own elapsed time.
   *
   * An absolute timestamp would only be meaningful to a browser whose clock agrees with the
   * server's: a device running slow kept "Resend" locked past the challenge's own expiry, leaving
   * no way to obtain a working code. Both are server-derived, so a refresh resumes the REAL
   * remainder rather than restarting a fresh 60s.
   */
  expiresInSeconds: number;
  resendInSeconds: number;
  resendsRemaining: number;
}

/** Either a completed sign-in or a pending second factor. */
export type LoginResult = { twoFactorRequired: false; principal: Principal } | TwoFactorPending;
