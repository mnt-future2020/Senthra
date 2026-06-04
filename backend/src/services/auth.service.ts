import crypto from "node:crypto";

import { OAuth2Client } from "google-auth-library";
import type { Admin, Prisma } from "@prisma/client";

import { env } from "../config/env.js";
import * as adminRepo from "../repositories/admin.repository.js";
import * as settingsRepo from "../repositories/settings.repository.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from "../utils/http-error.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../utils/jwt.js";
import { sendTemplatedEmail } from "./email.service.js";

// Shape returned to the client (never includes the password hash or secrets).
export interface PublicAdmin {
  id: string;
  email: string;
  name: string | null;
  googleEmail: string | null;
}

interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends SessionTokens {
  admin: PublicAdmin;
}

function publicAdmin(admin: Admin): PublicAdmin {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    googleEmail: admin.googleEmail,
  };
}

function issueTokens(adminId: string): SessionTokens {
  return {
    accessToken: signAccessToken(adminId),
    refreshToken: signRefreshToken(adminId),
  };
}

// SHA-256 hash of a reset token — only the hash is stored, never the raw token.
function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Tokens issued before admin.tokenInvalidatedAt are rejected (logout / password change).
function isSessionRevoked(admin: Admin, issuedAtSec?: number): boolean {
  if (!admin.tokenInvalidatedAt || !issuedAtSec) return false;
  const invalidatedSec = Math.floor(admin.tokenInvalidatedAt.getTime() / 1000);
  return issuedAtSec < invalidatedSec;
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const admin = await adminRepo.findByEmail(email.toLowerCase());
  if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
    throw unauthorized("Invalid email or password.");
  }
  return { admin: publicAdmin(admin), ...issueTokens(admin.id) };
}

export async function getCurrentAdmin(adminId: string): Promise<PublicAdmin> {
  const admin = await adminRepo.findById(adminId);
  if (!admin) throw notFound("Admin not found.");
  return publicAdmin(admin);
}

interface ChangeCredentialsParams {
  currentPassword: string;
  email?: string;
  newPassword?: string;
}

// Change email and/or password. Changing the password revokes all existing
// sessions, then re-issues a fresh one so the current device stays signed in.
export async function changeCredentials(
  adminId: string,
  params: ChangeCredentialsParams,
): Promise<{ admin: PublicAdmin; tokens: SessionTokens | null }> {
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
  if (passwordChanged) data.tokenInvalidatedAt = new Date();

  const updated = await adminRepo.update(admin.id, data);
  const tokens = passwordChanged ? issueTokens(updated.id) : null;
  return { admin: publicAdmin(updated), tokens };
}

// Rotate tokens using a refresh token. Throws on any failure; the caller clears
// the auth cookies when this rejects.
export async function refreshSession(refreshToken: string): Promise<AuthResult> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw unauthorized("Invalid or expired refresh token.");
  }

  const admin = await adminRepo.findById(payload.sub);
  if (!admin) throw unauthorized("Unauthorized.");
  if (isSessionRevoked(admin, payload.iat)) {
    throw unauthorized("Session expired. Please log in again.");
  }
  return { admin: publicAdmin(admin), ...issueTokens(admin.id) };
}

export async function logout(adminId: string): Promise<void> {
  await adminRepo.update(adminId, { tokenInvalidatedAt: new Date() });
}

// Persist a reset token and email the link. Kept separate so forgotPassword can
// run it fire-and-forget without blocking the response.
async function issueResetEmail(admin: Admin): Promise<void> {
  // Raw token goes in the email link; only its hash is stored. Valid for 1 hour.
  const token = crypto.randomBytes(32).toString("hex");
  await adminRepo.update(admin.id, {
    resetTokenHash: hashResetToken(token),
    resetTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  // Rendered from the editable "auth.password_reset" template (brand name +
  // styling live there). Forced: a disabled template must never block a
  // security-critical reset email.
  const firstName = admin.name?.trim().split(/\s+/)[0] || "there";
  const resetPasswordLink = `${env.FRONTEND_URL}/reset-password?token=${token}`;
  await sendTemplatedEmail(
    "auth.password_reset",
    admin.email,
    { firstName, resetPasswordLink },
    { force: true },
  );
}

// Email a password reset link. No-op (silent) when the email isn't registered.
// Responds immediately and identically whether or not the email exists: the token
// write + SMTP send run fire-and-forget, so neither the message nor the response
// timing reveals registered accounts, and a slow/unreachable SMTP server never
// blocks the response.
export async function forgotPassword(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const admin = await adminRepo.findByEmail(normalized);
  if (!admin) return;

  // Fire-and-forget. The .catch() keeps a failed send from becoming an
  // unhandled rejection; details are surfaced server-side, never to the client.
  void issueResetEmail(admin).catch((e) =>
    console.error("Password reset email failed to send:", e instanceof Error ? e.message : e),
  );
}

// Set a new password using the emailed token. Single-use: clears the token and
// revokes every existing session.
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const admin = await adminRepo.findByResetTokenHash(hashResetToken(token));
  if (
    !admin ||
    !admin.resetTokenExpiresAt ||
    admin.resetTokenExpiresAt.getTime() < Date.now()
  ) {
    throw badRequest("This reset link is invalid or has expired.");
  }
  await adminRepo.update(admin.id, {
    passwordHash: await hashPassword(newPassword),
    resetTokenHash: null,
    resetTokenExpiresAt: null,
    tokenInvalidatedAt: new Date(),
  });
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
export async function googleLogin(credential: string): Promise<AuthResult> {
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
  return { admin: publicAdmin(admin), ...issueTokens(admin.id) };
}
