import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { DeviceSession, Principal } from "@/types/auth";

// Typed wrappers around the backend auth endpoints. Components and providers call
// these instead of hitting `api()` with raw URLs.

export interface GoogleConfig {
  enabled: boolean;
  clientId: string | null;
}

export function getCurrentPrincipal(): Promise<Principal> {
  return api<{ principal: Principal }>("/auth/me").then((r) => r.principal);
}

export function login(email: string, password: string, remember = true): Promise<Principal> {
  return api<{ principal: Principal }>("/auth/login", {
    method: "POST",
    body: { email, password, remember },
  }).then((r) => r.principal);
}

export function loginWithGoogle(credential: string): Promise<Principal> {
  return api<{ principal: Principal }>("/auth/google", {
    method: "POST",
    body: { credential },
  }).then((r) => r.principal);
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
export function changeEmail(currentPassword: string, email: string): Promise<void> {
  return api("/auth/credentials", {
    method: "PATCH",
    body: { currentPassword, email },
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
