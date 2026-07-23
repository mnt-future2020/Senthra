import { api } from "../lib/api";
import type { MyProfile, MyProfileUpdate, SessionInfo } from "../types";

// Self-service account endpoints shared with the web dashboard.

export function changeOwnPassword(params: {
  currentPassword?: string;
  newPassword: string;
}): Promise<void> {
  return api("/auth/password", { method: "POST", body: params });
}

/** Emails a password-reset link (the reset itself completes on the web dashboard). */
export function forgotPassword(email: string): Promise<void> {
  return api("/auth/forgot-password", { method: "POST", body: { email } });
}

export function getSessions(): Promise<SessionInfo[]> {
  return api<{ sessions: SessionInfo[] }>("/auth/sessions").then((r) => r.sessions);
}

export function revokeOtherSessions(): Promise<void> {
  return api("/auth/sessions/revoke-others", { method: "POST" });
}

// Own profile — the backend whitelists the editable fields (photo, phone,
// address); name, role and email are admin-managed.

export function getMyProfile(): Promise<MyProfile> {
  return api<{ user: MyProfile }>("/users/me").then((r) => r.user);
}

export function updateMyProfile(payload: MyProfileUpdate): Promise<MyProfile> {
  return api<{ user: MyProfile }>("/users/me", { method: "PUT", body: payload, timeout: 60_000 }).then(
    (r) => r.user,
  );
}

// Personal signature — printed on documents the user issues (e.g. Purchase Orders).

export function uploadMySignature(signature: string, fileName: string): Promise<MyProfile> {
  return api<{ user: MyProfile }>("/users/me/signature", {
    method: "POST",
    body: { signature, fileName },
    timeout: 60_000,
  }).then((r) => r.user);
}

export function removeMySignature(): Promise<MyProfile> {
  return api<{ user: MyProfile }>("/users/me/signature", { method: "DELETE" }).then((r) => r.user);
}
