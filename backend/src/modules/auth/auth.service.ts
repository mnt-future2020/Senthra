import crypto from "node:crypto";

import { OAuth2Client } from "google-auth-library";
import type { Prisma } from "@prisma/client";

import { env } from "../../config/env.js";
import * as adminRepo from "./admin.repository.js";
import * as sessionService from "./session.service.js";
import { assertEmailNamespaceFree } from "./email-namespace.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as customerRepo from "#modules/customer/customer.repository.js";
import * as settingsRepo from "#modules/settings/settings.repository.js";
import * as auditService from "#modules/audit/audit.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
import {
  adminPrincipal,
  customerPrincipal,
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

  // Finally, an external customer portal user (read-only). Email namespaces are kept
  // disjoint at creation, so a customer user is only reached when no admin/user matched.
  const cu = await customerRepo.findLoginByEmail(normalized);
  if (cu?.passwordHash && (await verifyPassword(password, cu.passwordHash))) {
    if (cu.status !== "active" || cu.customer.deletedAt || cu.customer.status !== "active") {
      throw forbidden("Your account is not active. Contact your administrator.");
    }
    const principal = customerPrincipal(cu, cu.customer);
    recordAuth("auth.login", principal, meta);
    return { principal, ...(await startAndIssue(cu.id, "customer", meta)) };
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
      // Keep the admin/staff/customer email namespaces disjoint. A staff user or
      // customer — even a SOFT-DELETED one, which can be revived under the same email
      // — would be shadowed by login's admin-first match, so block those too.
      await assertEmailNamespaceFree(normalized, { skip: { admin: true }, blockSoftDeleted: true });
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
    notifyPasswordChanged(updated.email, updated.name ?? "");
  }
  return { principal: adminPrincipal(updated), tokens };
}

// Shared body for a principal changing their OWN password (staff + customer). The
// first-login forced change is authorised by the session itself (the temp password
// was just proven at login); a voluntary change re-verifies the current password and
// rejects a no-op reuse. Then clears mustResetPassword, signs out OTHER devices, and
// re-issues tokens for the current device so it stays logged in.
async function changeOwnPassword<
  TAccount extends { id: string; passwordHash: string | null; mustResetPassword: boolean | null },
  TUpdated,
>(
  actor: "user" | "customer",
  fetchAccount: () => Promise<TAccount | null>,
  applyUpdate: (
    id: string,
    data: { passwordHash: string; mustResetPassword: false },
  ) => Promise<TUpdated>,
  toPrincipal: (account: TUpdated) => Principal,
  currentPassword: string | undefined,
  newPassword: string,
  currentSid: string,
): Promise<{ tokens: SessionTokens; principal: Principal }> {
  // requireAuth always populates a live sid; bail rather than let an empty one
  // fall through to endOthers (which would wipe every session) + an unusable token.
  if (!currentSid) throw unauthorized("Session expired. Please log in again.");
  const account = await fetchAccount();
  if (!account) throw notFound("Account not found.");
  // A null mustResetPassword (the optional CustomerUser column) is treated as
  // "must reset" — the conservative default.
  const mustReset = account.mustResetPassword ?? true;
  if (!mustReset) {
    if (
      !currentPassword ||
      !account.passwordHash ||
      !(await verifyPassword(currentPassword, account.passwordHash))
    ) {
      throw unauthorized("Current password is incorrect.");
    }
    if (await verifyPassword(newPassword, account.passwordHash)) {
      throw badRequest("Your new password must be different from the current one.");
    }
  }
  const updated = await applyUpdate(account.id, {
    passwordHash: await hashPassword(newPassword),
    mustResetPassword: false,
  });
  await sessionService.endOthers(account.id, actor, currentSid);
  const principal = toPrincipal(updated);
  // Confirm a VOLUNTARY change only — the forced first-login change is part of
  // onboarding (temp password → own password), so a confirmation there is noise.
  if (!mustReset) {
    notifyPasswordChanged(
      principal.email,
      principal.type === "user" ? principal.firstName : principal.type === "customer" ? principal.userName : "",
    );
  }
  return { tokens: issueTokens(account.id, actor, currentSid), principal };
}

// Staff user: change own password (first-login forced change + voluntary changes).
export function changeUserPassword(
  userId: string,
  currentPassword: string | undefined,
  newPassword: string,
  currentSid: string,
): Promise<{ tokens: SessionTokens; principal: Principal }> {
  return changeOwnPassword(
    "user",
    () => userRepo.findById(userId),
    (id, data) => userRepo.update(id, data),
    userPrincipal,
    currentPassword,
    newPassword,
    currentSid,
  );
}

// Customer portal user: change own password — the same flow, on the CustomerUser
// login account (`customerUserId` is the signed-in principal id).
export function changeCustomerPassword(
  customerUserId: string,
  currentPassword: string | undefined,
  newPassword: string,
  currentSid: string,
): Promise<{ tokens: SessionTokens; principal: Principal }> {
  return changeOwnPassword(
    "customer",
    () => customerRepo.findLoginById(customerUserId),
    (id, data) => customerRepo.updateLoginUser(id, data),
    (acct) => customerPrincipal(acct, acct.customer),
    currentPassword,
    newPassword,
    currentSid,
  );
}

// Rotate tokens using a refresh token (admin, staff user, or customer). The session must still be
// live (it isn't after logout, a password change, or eviction by the device cap).
// Throws on any failure; the caller clears the auth cookies when this rejects.
export async function refreshSession(refreshToken: string): Promise<AuthResult> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw unauthorized("Invalid or expired refresh token.");
  }

  const session = await sessionService.findActive(payload.sid);
  if (!session || !sessionService.sessionMatchesPrincipal(session, payload.actor, payload.sub)) {
    throw unauthorized("Session expired. Please log in again.");
  }

  if (payload.actor === "user") {
    const user = await userRepo.findById(payload.sub);
    if (!user || user.status !== "active") throw unauthorized("Unauthorized.");
    await sessionService.touch(payload.sid);
    return { principal: userPrincipal(user), ...issueTokens(user.id, "user", payload.sid) };
  }

  if (payload.actor === "customer") {
    const cu = await customerRepo.findLoginById(payload.sub);
    if (
      !cu ||
      cu.status !== "active" ||
      cu.customer.deletedAt ||
      cu.customer.status !== "active"
    ) {
      throw unauthorized("Unauthorized.");
    }
    await sessionService.touch(payload.sid);
    return {
      principal: customerPrincipal(cu, cu.customer),
      ...issueTokens(cu.id, "customer", payload.sid),
    };
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

// Fire-and-forget the security confirmation after a successful password change.
// Forced so a disabled template never suppresses a security-critical alert (matching
// the reset email). Never blocks or throws into the password flow.
function notifyPasswordChanged(to: string, firstName: string): void {
  void sendTemplatedEmail("auth.password_changed", to, { firstName }, { force: true }).catch((e) =>
    console.error("password changed email failed:", e instanceof Error ? e.message : e),
  );
}

// Persist a reset token + email the link, for either account type. The raw token
// goes in the link; only its hash is stored. Valid for 1 hour. Rendered from the
// editable "auth.password_reset" template; forced so a disabled template never
// blocks a security-critical reset email. `persist` writes the hash+expiry to the
// owning collection (admin, staff user, or customer), keeping the flows a single code path.
// Exported so an admin-initiated customer-user reset (customer.service) reuses the
// exact same token mechanics + email, completed via the public /reset-password page.
export async function issueResetEmail(
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

// Email a reset link to a super-admin, an active staff user, or an active invited
// customer-portal user. No-op (silent) when the email isn't registered. Responds
// immediately and identically whether or not the email exists: the token write +
// SMTP send run fire-and-forget, so neither the message nor the response timing
// reveals registered accounts.
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
    return;
  }
  const cu = await customerRepo.findLoginByEmail(normalized);
  // `cu.passwordHash` gates this to INVITED users only — an uninvited contact row
  // (passwordHash null) can't use the reset flow to self-provision a login, the same
  // guard `login` applies. Without it, requesting a reset would let an uninvited
  // contact set a password and bypass the admin invite flow.
  if (
    cu &&
    cu.passwordHash &&
    cu.status === "active" &&
    !cu.customer.deletedAt &&
    cu.customer.status === "active"
  ) {
    const firstName = cu.fullName.trim().split(/\s+/)[0] || cu.fullName;
    void issueResetEmail(cu.email, firstName, (d) => customerRepo.updateLoginUser(cu.id, d)).catch(
      onError,
    );
  }
}

// Set a new password using the emailed token (admin, staff user, or customer). Single-use: clears
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
    notifyPasswordChanged(admin.email, admin.name ?? "");
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
    notifyPasswordChanged(user.email, user.firstName);
    return;
  }

  const cu = await customerRepo.findLoginByResetTokenHash(tokenHash);
  if (cu && cu.resetTokenExpiresAt && cu.resetTokenExpiresAt.getTime() >= Date.now()) {
    await customerRepo.updateLoginUser(cu.id, {
      passwordHash: await hashPassword(newPassword),
      mustResetPassword: false,
      resetTokenHash: null,
      resetTokenExpiresAt: null,
    });
    await sessionService.endAll(cu.id, "customer");
    notifyPasswordChanged(cu.email, cu.fullName ?? "");
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

// Verify the Google ID token and start a session for the matching account: the
// super-admin (via its configured Google email), an active staff user, or an active
// customer (read-only portal) whose account/login email is the verified Google email.
// Mirrors the password login's order (admin → user → customer), so Google sign-in
// works for everyone the system already knows — not just the admin.
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

  // 1) Super-admin — matched on its configured Google email (or its login email).
  const admin = await adminRepo.findFirst();
  if (admin && googleEmail === (admin.googleEmail ?? admin.email).toLowerCase()) {
    const principal = adminPrincipal(admin);
    recordAuth("auth.login", principal, meta);
    return { principal, ...(await startAndIssue(admin.id, "admin", meta)) };
  }

  // 2) A registered staff user whose account email is the verified Google email.
  // RBAC is unchanged: the user signs in as themselves, with their role's permissions.
  const user = await userRepo.findByEmailWithRole(googleEmail);
  if (user) {
    if (user.status !== "active") {
      throw forbidden("Your account is not active. Contact an administrator.");
    }
    // The verified Google identity is itself proof of ownership, so a first-ever
    // Google sign-in also satisfies the one-time temp-password wall — clear it so SSO
    // users aren't forced to set a password they'll never use (they can still set one
    // later via "forgot password" if they want a password fallback).
    const account = user.mustResetPassword
      ? await userRepo.update(user.id, { mustResetPassword: false })
      : user;
    const principal = userPrincipal(account);
    recordAuth("auth.login", principal, meta);
    return { principal, ...(await startAndIssue(account.id, "user", meta)) };
  }

  // 3) A customer (read-only portal) whose login email is the verified Google email.
  // Same treatment as the staff-user branch: the verified Google identity proves
  // ownership, so a first-ever Google sign-in also clears the one-time temp-password
  // wall. `findByEmail` excludes soft-deleted customers, so a removed customer can't
  // sign in. RBAC is unchanged — a customer holds only their fixed read-only permissions.
  const cu = await customerRepo.findLoginByEmail(googleEmail);
  if (cu) {
    if (cu.status !== "active" || cu.customer.deletedAt || cu.customer.status !== "active") {
      throw forbidden("Your account is not active. Contact an administrator.");
    }
    const account = cu.mustResetPassword
      ? await customerRepo.updateLoginUser(cu.id, { mustResetPassword: false })
      : cu;
    const principal = customerPrincipal(account, account.customer);
    recordAuth("auth.login", principal, meta);
    return { principal, ...(await startAndIssue(account.id, "customer", meta)) };
  }

  // 4) The verified email belongs to no admin, staff user, or customer.
  throw forbidden("This Google account is not authorized.");
}

// --- device sessions (Settings → Account / portal) ---

export function listSessions(principal: Principal, currentSid: string) {
  return sessionService.listSessions(principal.id, principal.type, currentSid);
}

export function revokeOtherSessions(principal: Principal, currentSid: string): Promise<void> {
  return sessionService.endOthers(principal.id, principal.type, currentSid);
}
