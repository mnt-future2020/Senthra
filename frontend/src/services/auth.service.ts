import { api } from "@/lib/api";
import type { Admin } from "@/types/auth";

// Typed wrappers around the backend auth endpoints. Components and providers call
// these instead of hitting `api()` with raw URLs.

export interface GoogleConfig {
  enabled: boolean;
  clientId: string | null;
}

export function getCurrentAdmin(): Promise<Admin> {
  return api<{ admin: Admin }>("/auth/me").then((r) => r.admin);
}

export function login(email: string, password: string, remember = true): Promise<Admin> {
  return api<{ admin: Admin }>("/auth/login", {
    method: "POST",
    body: { email, password, remember },
  }).then((r) => r.admin);
}

export function loginWithGoogle(credential: string): Promise<Admin> {
  return api<{ admin: Admin }>("/auth/google", {
    method: "POST",
    body: { credential },
  }).then((r) => r.admin);
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

// Both email and password changes go through the same protected endpoint.
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
