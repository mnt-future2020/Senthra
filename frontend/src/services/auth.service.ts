import { api, LONG_WRITE_TIMEOUT } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { DeviceSession, LoginResult, Principal, TwoFactorPending } from "@/types/auth";

// Typed wrappers around the backend auth endpoints. Components and providers call
// these instead of hitting `api()` with raw URLs.

export interface GoogleConfig {
  enabled: boolean;
  clientId: string | null;
}

export function getCurrentPrincipal(): Promise<Principal> {
  return api<{ principal: Principal }>("/auth/me").then((r) => r.principal);
}

/**
 * Sign in. Resolves to either the authenticated principal or a PENDING 2FA challenge.
 *
 * The server distinguishes the two with `twoFactorRequired`; the challenge cookie is httpOnly, so
 * nothing about it is handled here.
 */
export function login(email: string, password: string, remember = true): Promise<LoginResult> {
  return api<Partial<TwoFactorPending> & { principal?: Principal }>("/auth/login", {
    method: "POST",
    body: { email, password, remember },
    // With 2FA on the server WAITS on the OTP email before it answers, which is a second network
    // round trip the client cannot see — exactly the case LONG_WRITE_TIMEOUT documents. On the 20s
    // default a slow mail server produced "the request timed out" for a login that had in fact
    // succeeded, and the user would retry, opening a second challenge and sending a second code.
    timeout: LONG_WRITE_TIMEOUT,
  }).then((r) =>
    r.twoFactorRequired
      ? {
          twoFactorRequired: true as const,
          email: r.email!,
          expiresInSeconds: r.expiresInSeconds!,
          resendInSeconds: r.resendInSeconds!,
          resendsRemaining: r.resendsRemaining!,
        }
      : { twoFactorRequired: false as const, principal: r.principal! },
  );
}

// --- Email 2FA ---
// The login page cannot read the httpOnly challenge cookie, so it asks the server on mount whether
// a challenge is pending. A 401 — the normal "no challenge" answer — surfaces as a thrown ApiError.
export function getTwoFactorChallenge(): Promise<TwoFactorPending> {
  return api<TwoFactorPending>("/auth/2fa/challenge");
}

export function verifyTwoFactor(code: string): Promise<Principal> {
  return api<{ principal: Principal }>("/auth/2fa/verify", {
    method: "POST",
    body: { code },
  }).then((r) => r.principal);
}

export function resendTwoFactor(): Promise<TwoFactorPending> {
  // Also blocks on an SMTP send.
  return api<TwoFactorPending>("/auth/2fa/resend", {
    method: "POST",
    timeout: LONG_WRITE_TIMEOUT,
  });
}

export function cancelTwoFactor(): Promise<void> {
  return api("/auth/2fa/cancel", { method: "POST" }).then(() => undefined);
}

// Google is subject to 2FA too, so this resolves to the same union as `login`: a principal when the
// sign-in completed, or a pending challenge when a code is still required.
export function loginWithGoogle(credential: string, remember = true): Promise<LoginResult> {
  return api<Partial<TwoFactorPending> & { principal?: Principal }>("/auth/google", {
    method: "POST",
    body: { credential, remember },
    // Same reason as `login` above: Google's token check plus the OTP email send.
    timeout: LONG_WRITE_TIMEOUT,
  }).then((r) =>
    r.twoFactorRequired
      ? {
          twoFactorRequired: true as const,
          email: r.email!,
          expiresInSeconds: r.expiresInSeconds!,
          resendInSeconds: r.resendInSeconds!,
          resendsRemaining: r.resendsRemaining!,
        }
      : { twoFactorRequired: false as const, principal: r.principal! },
  );
}

export function logout(): Promise<void> {
  return api("/auth/logout", { method: "POST" }).then(() => undefined);
}

export function getGoogleConfig(): Promise<GoogleConfig> {
  return api<GoogleConfig>("/auth/google/config");
}

export function forgotPassword(email: string): Promise<void> {
  return api("/auth/forgot-password", { method: "POST", body: { email } }).then(
    () => undefined,
  );
}

export function resetPassword(token: string, newPassword: string): Promise<void> {
  return api("/auth/reset-password", {
    method: "POST",
    body: { token, newPassword },
  }).then(() => undefined);
}

// --- Super-admin account (Settings → Account) — /auth/credentials ---
// Name and email travel together: they are one "your account" form and one confirm-with-password
// step. Either may be omitted — the server refuses a request that changes nothing.
export function updateAccount(
  currentPassword: string,
  changes: { email?: string; name?: string },
): Promise<void> {
  return api("/auth/credentials", {
    method: "PATCH",
    body: { currentPassword, ...changes },
  }).then(() => undefined);
}

export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  return api("/auth/credentials", {
    method: "PATCH",
    body: { currentPassword, newPassword },
  }).then(() => undefined);
}

// --- Device sessions ---
// Cached so the Devices card renders the last-known list instantly on revisit
// instead of flashing its skeleton; the card still refetches to revalidate.
let sessionsCache: DeviceSession[] | null = null;
registerClientCache(() => {
  sessionsCache = null;
});
export const getCachedSessions = (): DeviceSession[] | null => sessionsCache;

export function getSessions(): Promise<DeviceSession[]> {
  return api<{ sessions: DeviceSession[] }>("/auth/sessions").then((r) => {
    sessionsCache = r.sessions;
    return r.sessions;
  });
}

export function revokeOtherSessions(): Promise<void> {
  return api("/auth/sessions/revoke-others", { method: "POST" }).then(() => undefined);
}

// --- Staff user own password — /auth/password ---
// First-login forced change omits currentPassword (the session authorises it);
// a voluntary change passes it. Returns the refreshed principal.
export function changeUserPassword(
  newPassword: string,
  currentPassword?: string,
): Promise<Principal> {
  return api<{ principal: Principal }>("/auth/password", {
    method: "POST",
    body: { newPassword, currentPassword },
  }).then((r) => r.principal);
}
