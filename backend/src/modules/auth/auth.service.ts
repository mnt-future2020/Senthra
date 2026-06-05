import crypto from "node:crypto";

import { OAuth2Client } from "google-auth-library";
import type { Prisma } from "@prisma/client";

import { env } from "../../config/env.js";
import * as adminRepo from "./admin.repository.js";
import * as sessionService from "./session.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as settingsRepo from "#modules/settings/settings.repository.js";
import * as auditService from "#modules/audit/audit.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
import {
  adminPrincipal,
  userPrincipal,
  type Principal,
} from "../../types/principal.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from "../../utils/http-error.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import {
  type Actor,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../utils/jwt.js";

interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends SessionTokens {
  principal: Principal;
}

// Request context recorded alongside a login, for the audit trail + session.
export interface AuthMeta {
  ip?: string;
  userAgent?: string;
}

function issueTokens(sub: string, actor: Actor, sid: string): SessionTokens {
  return {
    accessToken: signAccessToken(sub, actor, sid),
    refreshToken: signRefreshToken(sub, actor, sid),
  };
}

// SHA-256 hash of a reset token — only the hash is stored, never the raw token.
function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Audit login/logout. Fire-and-forget (record() never throws to the caller).
function recordAuth(
  action: "auth.login" | "auth.logout",
  principal: Principal,
  meta?: AuthMeta,
): void {
  auditService.record({
    actor: { id: principal.id, email: principal.email, type: principal.type },
    action,
    metadata: meta
      ? { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }
      : undefined,
  });
}

// Open a new device session (enforcing the 2-device cap) and mint its tokens.
async function startAndIssue(
  sub: string,
  actor: Actor,
  meta?: AuthMeta,
): Promise<SessionTokens> {
  const sid = await sessionService.startSession(sub, actor, {
    userAgent: meta?.userAgent,
    ip: meta?.ip,
  });
  return issueTokens(sub, actor, sid);
}

// Unified login: the super-admin account first, then an active staff user. An
// unknown email and a wrong password return the same generic error (no account
// enumeration); a correct password on a non-active user gets a specific message.
export async function login(
  email: string,
  password: string,
  meta?: AuthMeta,
): Promise<AuthResult> {
  const normalized = email.trim().toLowerCase();

  const admin = await adminRepo.findByEmail(normalized);
  if (admin && (await verifyPassword(password, admin.passwordHash))) {
    const principal = adminPrincipal(admin);
    recordAuth("auth.login", principal, meta);
    return { principal, ...(await startAndIssue(admin.id, "admin", meta)) };
  }

  const user = await userRepo.findByEmailWithRole(normalized);
  if (user && (await verifyPassword(password, user.passwordHash))) {
    if (user.status !== "active") {
      throw forbidden("Your account is not active. Contact an administrator.");
    }
    const principal = userPrincipal(user);
    recordAuth("auth.login", principal, meta);
    return { principal, ...(await startAndIssue(user.id, "user", meta)) };
  }

  throw unauthorized("Invalid email or password.");
}

interface ChangeCredentialsParams {
  currentPassword: string;
  email?: string;
  newPassword?: string;
}

// Super-admin: change email and/or password (Settings → Account). Changing the
// password signs out every OTHER device and re-issues tokens so this one stays in.
export async function changeCredentials(
  adminId: string,
  params: ChangeCredentialsParams,
  currentSid: string,
): Promise<{ principal: Principal; tokens: SessionTokens | null }> {
  // requireAuth always populates a live sid; bail rather than let an empty one
  // fall through to endOthers (which would wipe every session) + an unusable token.
  if (!currentSid) throw unauthorized("Session expired. Please log in again.");
  const admin = await adminRepo.findById(adminId);
  if (!admin) throw notFound("Admin not found.");
  if (!(await verifyPassword(params.currentPassword, admin.passwordHash))) {
    throw unauthorized("Current password is incorrect.");
  }

  const data: Prisma.AdminUpdateInput = {};

  if (params.email) {
    const normalized = params.email.toLowerCase();
    if (normalized !== admin.email) {
      const existing = await adminRepo.findByEmail(normalized);
      if (existing) throw conflict("That email is already in use.");
      // Keep the admin/staff email namespaces disjoint. A staff user — even a
      // soft-deleted one, which can be revived under the same email — holding this
      // address would be shadowed by login's admin-first match, so block it.
      if (await userRepo.findByEmailIncludingDeleted(normalized)) {
        throw conflict("That email belongs to a staff user. Use a different one.");
      }
      data.email = normalized;
      data.googleEmail = normalized;
    }
  }

  let passwordChanged = false;
  if (params.newPassword) {
    data.passwordHash = await hashPassword(params.newPassword);
    passwordChanged = true;
  }

  if (Object.keys(data).length === 0) {
    throw badRequest("Nothing to update.");
  }

  const updated = await adminRepo.update(admin.id, data);
  let tokens: SessionTokens | null = null;
  if (passwordChanged) {
    await sessionService.endOthers(admin.id, "admin", currentSid);
    tokens = issueTokens(admin.id, "admin", currentSid);
  }
  return { principal: adminPrincipal(updated), tokens };
}

// Staff user: change own password — the first-login forced change and voluntary
// changes. Clears mustResetPassword, signs out other devices, and re-issues tokens
// for the current device.
export async function changeUserPassword(
  userId: string,
  currentPassword: string | undefined,
  newPassword: string,
  currentSid: string,
): Promise<{ tokens: SessionTokens; principal: Principal }> {
  // requireAuth always populates a live sid; bail rather than let an empty one
  // fall through to endOthers (which would wipe every session) + an unusable token.
  if (!currentSid) throw unauthorized("Session expired. Please log in again.");
  const user = await userRepo.findById(userId);
  if (!user) throw notFound("Account not found.");
  // The first-login forced change is authorised by the session itself (the temp
  // password was just proven at login). A voluntary change re-verifies the
  // current password and rejects a no-op reuse.
  if (!user.mustResetPassword) {
    if (!currentPassword || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw unauthorized("Current password is incorrect.");
    }
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw badRequest("Your new password must be different from the current one.");
    }
  }
  const updated = await userRepo.update(userId, {
    passwordHash: await hashPassword(newPassword),
    mustResetPassword: false,
  });
  await sessionService.endOthers(userId, "user", currentSid);
  return { tokens: issueTokens(userId, "user", currentSid), principal: userPrincipal(updated) };
}

// Rotate tokens using a refresh token (admin or user). The session must still be
// live (it isn't after logout, a password change, or eviction by the device cap).
// Throws on any failure; the caller clears the auth cookies when this rejects.
export async function refreshSession(refreshToken: string): Promise<AuthResult> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw unauthorized("Invalid or expired refresh token.");
  }

  if (!(await sessionService.isActive(payload.sid))) {
    throw unauthorized("Session expired. Please log in again.");
  }

  if (payload.actor === "user") {
    const user = await userRepo.findById(payload.sub);
    if (!user || user.status !== "active") throw unauthorized("Unauthorized.");
    await sessionService.touch(payload.sid);
    return { principal: userPrincipal(user), ...issueTokens(user.id, "user", payload.sid) };
  }

  const admin = await adminRepo.findById(payload.sub);
  if (!admin) throw unauthorized("Unauthorized.");
  await sessionService.touch(payload.sid);
  return { principal: adminPrincipal(admin), ...issueTokens(admin.id, "admin", payload.sid) };
}

// Sign out the current device only (other devices stay logged in).
export async function logout(principal: Principal, sid: string): Promise<void> {
  await sessionService.endSession(sid);
  recordAuth("auth.logout", principal);
}

// Persist a reset token + email the link, for either account type. The raw token
// goes in the link; only its hash is stored. Valid for 1 hour. Rendered from the
// editable "auth.password_reset" template; forced so a disabled template never
// blocks a security-critical reset email. `persist` writes the hash+expiry to the
// owning collection (admin or user), keeping the two flows a single code path.
async function issueResetEmail(
  email: string,
  firstName: string,
  persist: (data: { resetTokenHash: string; resetTokenExpiresAt: Date }) => Promise<unknown>,
): Promise<void> {
  const token = crypto.randomBytes(32).toString("hex");
  await persist({
    resetTokenHash: hashResetToken(token),
    resetTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const resetPasswordLink = `${env.FRONTEND_URL}/reset-password?token=${token}`;
  await sendTemplatedEmail(
    "auth.password_reset",
    email,
    { firstName, resetPasswordLink },
    { force: true },
  );
}

// Email a reset link to a super-admin or an active staff user. No-op (silent)
// when the email isn't registered. Responds immediately and identically whether
// or not the email exists: the token write + SMTP send run fire-and-forget, so
// neither the message nor the response timing reveals registered accounts.
export async function forgotPassword(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();

  const onError = (e: unknown) =>
    console.error(
      "Password reset email failed to send:",
      e instanceof Error ? e.message : e,
    );

  const admin = await adminRepo.findByEmail(normalized);
  if (admin) {
    const firstName = admin.name?.trim().split(/\s+/)[0] || "there";
    void issueResetEmail(admin.email, firstName, (d) => adminRepo.update(admin.id, d)).catch(
      onError,
    );
    return;
  }
  const user = await userRepo.findByEmailWithRole(normalized);
  if (user && user.status === "active") {
    void issueResetEmail(user.email, user.firstName, (d) => userRepo.update(user.id, d)).catch(
      onError,
    );
  }
}

// Set a new password using the emailed token (admin or user). Single-use: clears
// the token and signs out every device (they re-log-in with the new password).
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const tokenHash = hashResetToken(token);

  const admin = await adminRepo.findByResetTokenHash(tokenHash);
  if (
    admin &&
    admin.resetTokenExpiresAt &&
    admin.resetTokenExpiresAt.getTime() >= Date.now()
  ) {
    await adminRepo.update(admin.id, {
      passwordHash: await hashPassword(newPassword),
      resetTokenHash: null,
      resetTokenExpiresAt: null,
    });
    await sessionService.endAll(admin.id, "admin");
    return;
  }

  const user = await userRepo.findByResetTokenHash(tokenHash);
  if (
    user &&
    user.resetTokenExpiresAt &&
    user.resetTokenExpiresAt.getTime() >= Date.now()
  ) {
    await userRepo.update(user.id, {
      passwordHash: await hashPassword(newPassword),
      mustResetPassword: false,
      resetTokenHash: null,
      resetTokenExpiresAt: null,
    });
    await sessionService.endAll(user.id, "user");
    return;
  }

  throw badRequest("This reset link is invalid or has expired.");
}

// Public — whether Google sign-in is enabled + the client id (never the secret).
export async function getGoogleConfig(): Promise<{
  enabled: boolean;
  clientId: string | null;
}> {
  const settings = await settingsRepo.findFirst();
  if (!settings || !settings.googleEnabled || !settings.googleClientId) {
    return { enabled: false, clientId: null };
  }
  return { enabled: true, clientId: settings.googleClientId };
}

// Verify the Google ID token and start a session for the authorized admin.
export async function googleLogin(credential: string, meta?: AuthMeta): Promise<AuthResult> {
  const settings = await settingsRepo.findFirst();
  if (!settings?.googleEnabled || !settings.googleClientId) {
    throw badRequest("Google sign-in is not enabled.");
  }

  const client = new OAuth2Client(settings.googleClientId);
  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: settings.googleClientId,
    });
    payload = ticket.getPayload();
  } catch {
    throw unauthorized("Invalid Google token.");
  }

  const googleEmail = (payload?.email ?? "").toLowerCase();
  if (!googleEmail || !payload?.email_verified) {
    throw unauthorized("Google account email is not verified.");
  }

  const admin = await adminRepo.findFirst();
  if (!admin) throw notFound("No admin account exists.");

  const allowed = (admin.googleEmail ?? admin.email).toLowerCase();
  if (googleEmail !== allowed) {
    throw forbidden("This Google account is not authorized.");
  }
  const principal = adminPrincipal(admin);
  recordAuth("auth.login", principal, meta);
  return { principal, ...(await startAndIssue(admin.id, "admin", meta)) };
}

// --- device sessions (Settings → Account / portal) ---

export function listSessions(principal: Principal, currentSid: string) {
  return sessionService.listSessions(principal.id, principal.type, currentSid);
}

export function revokeOtherSessions(principal: Principal, currentSid: string): Promise<void> {
  return sessionService.endOthers(principal.id, principal.type, currentSid);
}
