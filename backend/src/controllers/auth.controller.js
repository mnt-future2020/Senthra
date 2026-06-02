import crypto from "crypto";
import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";

import { prisma } from "../lib/prisma.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../lib/jwt.js";
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } from "../lib/cookies.js";
import { sendConfiguredEmail } from "../lib/appMailer.js";

// SHA-256 hash of a reset token — only the hash is stored, never the raw token.
function hashResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Shape returned to the client (never includes the password hash).
function publicAdmin(admin) {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    googleEmail: admin.googleEmail,
  };
}

// Issue a fresh access + refresh token pair and set the httpOnly cookies.
// Returns the access token so it can also be sent in the body (mobile / fallback).
function startSession(res, admin, remember = true) {
  const accessToken = signAccessToken(admin.id);
  const refreshToken = signRefreshToken(admin.id);
  setAuthCookies(res, accessToken, refreshToken, remember);
  return accessToken;
}

// POST /auth/login
export async function login(req, res, next) {
  try {
    const { email, password, remember } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }
    const admin = await prisma.admin.findUnique({
      where: { email: String(email).toLowerCase() },
    });
    if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const token = startSession(res, admin, remember !== false);
    res.json({ token, admin: publicAdmin(admin) });
  } catch (err) {
    next(err);
  }
}

// GET /auth/me  (protected)
export async function me(req, res, next) {
  try {
    const admin = await prisma.admin.findUnique({ where: { id: req.adminId } });
    if (!admin) return res.status(404).json({ error: "Admin not found." });
    res.json({ admin: publicAdmin(admin) });
  } catch (err) {
    next(err);
  }
}

// PATCH /auth/credentials  (protected) — change email and/or password.
export async function changeCredentials(req, res, next) {
  try {
    const { currentPassword, email, newPassword } = req.body || {};
    if (!currentPassword) {
      return res.status(400).json({ error: "Current password is required." });
    }
    const admin = await prisma.admin.findUnique({ where: { id: req.adminId } });
    if (!admin) return res.status(404).json({ error: "Admin not found." });

    if (!(await bcrypt.compare(currentPassword, admin.passwordHash))) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }

    const data = {};
    if (email && String(email).toLowerCase() !== admin.email) {
      const normalized = String(email).toLowerCase();
      const existing = await prisma.admin.findUnique({ where: { email: normalized } });
      if (existing) return res.status(409).json({ error: "That email is already in use." });
      data.email = normalized;
      data.googleEmail = normalized;
    }
    let passwordChanged = false;
    if (newPassword) {
      if (String(newPassword).length < 8) {
        return res.status(400).json({ error: "New password must be at least 8 characters." });
      }
      data.passwordHash = await bcrypt.hash(newPassword, 12);
      passwordChanged = true;
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "Nothing to update." });
    }

    // Changing the password revokes all existing sessions...
    if (passwordChanged) data.tokenInvalidatedAt = new Date();

    const updated = await prisma.admin.update({ where: { id: admin.id }, data });

    // ...then re-issue a fresh session so the current device stays signed in.
    if (passwordChanged) startSession(res, updated, true);

    res.json({ admin: publicAdmin(updated) });
  } catch (err) {
    next(err);
  }
}

// POST /auth/refresh — rotate tokens using the refresh cookie.
export async function refresh(req, res, next) {
  try {
    const token = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
    if (!token) return res.status(401).json({ error: "No refresh token." });

    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      clearAuthCookies(res);
      return res.status(401).json({ error: "Invalid or expired refresh token." });
    }

    const admin = await prisma.admin.findUnique({ where: { id: payload.sub } });
    if (!admin) {
      clearAuthCookies(res);
      return res.status(401).json({ error: "Unauthorized." });
    }
    if (admin.tokenInvalidatedAt && payload.iat) {
      const invalidatedSec = Math.floor(admin.tokenInvalidatedAt.getTime() / 1000);
      if (payload.iat < invalidatedSec) {
        clearAuthCookies(res);
        return res.status(401).json({ error: "Session expired. Please log in again." });
      }
    }

    // Rotation: every refresh issues a brand-new access + refresh token.
    const accessToken = startSession(res, admin, true);
    res.json({ token: accessToken, admin: publicAdmin(admin) });
  } catch (err) {
    next(err);
  }
}

// POST /auth/logout  (protected) — revoke sessions + clear cookies.
export async function logout(req, res, next) {
  try {
    await prisma.admin.update({
      where: { id: req.adminId },
      data: { tokenInvalidatedAt: new Date() },
    });
    clearAuthCookies(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// Generate a reset token, persist its hash + 1h expiry, and email the link.
// Run fire-and-forget from forgotPassword so the HTTP response isn't blocked by
// the DB write + SMTP round-trip.
async function issueResetEmail(admin) {
  // Raw token goes in the email link; only its hash is stored. Valid for 1 hour.
  const token = crypto.randomBytes(32).toString("hex");
  await prisma.admin.update({
    where: { id: admin.id },
    data: {
      resetTokenHash: hashResetToken(token),
      resetTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const base = process.env.FRONTEND_URL || "http://localhost:3000";
  const link = `${base}/reset-password?token=${token}`;
  await sendConfiguredEmail({
    to: admin.email,
    subject: "Reset your password",
    text:
      `We received a request to reset your password.\n\n` +
      `Use this link (valid for 1 hour):\n${link}\n\n` +
      `If you didn't request this, you can safely ignore this email.`,
    html:
      `<p>We received a request to reset your password.</p>` +
      `<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#7b6ef0;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Reset password</a></p>` +
      `<p style="color:#666;font-size:12px">This link is valid for 1 hour. If you didn't request this, you can safely ignore this email.</p>` +
      `<p style="color:#999;font-size:12px;word-break:break-all">${link}</p>`,
  });
}

// POST /auth/forgot-password — email a reset link.
// Responds immediately and identically whether or not the email exists, so
// neither the message nor the response timing reveals registered accounts.
export async function forgotPassword(req, res, next) {
  const generic = {
    message: "If that email is registered, a password reset link has been sent.",
  };
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email is required." });
    }
    const normalized = email.trim().toLowerCase();
    const admin = await prisma.admin.findUnique({ where: { email: normalized } });

    // Fire-and-forget: don't block the response on the DB write + SMTP send.
    // The .catch() keeps a failed send from becoming an unhandled rejection.
    if (admin) {
      issueResetEmail(admin).catch((e) =>
        console.error("Password reset email failed:", e?.message || e),
      );
    }

    return res.json(generic);
  } catch (err) {
    next(err);
  }
}

// POST /auth/reset-password — set a new password using the emailed token.
export async function resetPassword(req, res, next) {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      return res
        .status(400)
        .json({ error: "Reset token and new password are required." });
    }
    if (String(newPassword).length < 8) {
      return res
        .status(400)
        .json({ error: "New password must be at least 8 characters." });
    }

    const admin = await prisma.admin.findFirst({
      where: { resetTokenHash: hashResetToken(String(token)) },
    });
    if (
      !admin ||
      !admin.resetTokenExpiresAt ||
      admin.resetTokenExpiresAt.getTime() < Date.now()
    ) {
      return res
        .status(400)
        .json({ error: "This reset link is invalid or has expired." });
    }

    await prisma.admin.update({
      where: { id: admin.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, 12),
        // Single-use: clear the token, and revoke every existing session.
        resetTokenHash: null,
        resetTokenExpiresAt: null,
        tokenInvalidatedAt: new Date(),
      },
    });

    return res.json({
      message: "Password reset successfully. You can now sign in.",
    });
  } catch (err) {
    next(err);
  }
}

// GET /auth/google/config  — public. Whether Google sign-in is enabled + client id.
export async function googleConfig(req, res, next) {
  try {
    const settings = await prisma.settings.findFirst();
    const enabled = Boolean(settings?.googleEnabled && settings?.googleClientId);
    res.json({ enabled, clientId: enabled ? settings.googleClientId : null });
  } catch (err) {
    next(err);
  }
}

// POST /auth/google — verify the Google ID token and start a session.
export async function googleLogin(req, res, next) {
  try {
    const { credential, remember } = req.body || {};
    if (!credential) {
      return res.status(400).json({ error: "Missing Google credential." });
    }
    const settings = await prisma.settings.findFirst();
    if (!settings?.googleEnabled || !settings?.googleClientId) {
      return res.status(400).json({ error: "Google sign-in is not enabled." });
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
      return res.status(401).json({ error: "Invalid Google token." });
    }

    const googleEmail = (payload?.email || "").toLowerCase();
    if (!googleEmail || !payload.email_verified) {
      return res.status(401).json({ error: "Google account email is not verified." });
    }

    const admin = await prisma.admin.findFirst();
    if (!admin) return res.status(404).json({ error: "No admin account exists." });

    const allowed = (admin.googleEmail || admin.email).toLowerCase();
    if (googleEmail !== allowed) {
      return res.status(403).json({ error: "This Google account is not authorized." });
    }

    const token = startSession(res, admin, remember !== false);
    res.json({ token, admin: publicAdmin(admin) });
  } catch (err) {
    next(err);
  }
}
