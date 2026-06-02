import { prisma } from "../lib/prisma.js";
import { sendMail } from "../lib/mailer.js";
import { encryptSecret, decryptSecret } from "../lib/secrets.js";

// Never send secrets (Google client secret, SMTP password) to the browser —
// only whether one is set.
function publicSettings(s) {
  return {
    // Google Sign-In
    googleEnabled: s.googleEnabled,
    googleClientId: s.googleClientId || "",
    googleClientSecretSet: Boolean(s.googleClientSecret),

    // SMTP email
    smtpEnabled: s.smtpEnabled ?? false,
    smtpHost: s.smtpHost || "",
    smtpPort: s.smtpPort ?? null,
    smtpSecure: s.smtpSecure ?? false,
    smtpUsername: s.smtpUsername || "",
    smtpFromName: s.smtpFromName || "",
    smtpFromEmail: s.smtpFromEmail || "",
    smtpPasswordSet: Boolean(s.smtpPassword),
  };
}

async function getOrCreateSettings() {
  let s = await prisma.settings.findFirst();
  if (!s) s = await prisma.settings.create({ data: {} });
  return s;
}

// GET /settings  (protected)
export async function getSettings(req, res, next) {
  try {
    const s = await getOrCreateSettings();
    res.json({ settings: publicSettings(s) });
  } catch (err) {
    next(err);
  }
}

// PUT /settings  (protected)
export async function updateSettings(req, res, next) {
  try {
    const b = req.body || {};
    const s = await getOrCreateSettings();

    const data = {};

    // --- Google Sign-In ---
    if (typeof b.googleEnabled === "boolean") data.googleEnabled = b.googleEnabled;
    if (typeof b.googleClientId === "string") {
      data.googleClientId = b.googleClientId.trim() || null;
    }
    // Only overwrite the secret when a non-empty value is sent, so the UI can
    // leave it blank to keep the existing one. Encrypted before storage.
    if (typeof b.googleClientSecret === "string" && b.googleClientSecret.trim()) {
      data.googleClientSecret = encryptSecret(b.googleClientSecret.trim());
    }

    // --- SMTP email ---
    if (typeof b.smtpEnabled === "boolean") data.smtpEnabled = b.smtpEnabled;
    if (typeof b.smtpHost === "string") data.smtpHost = b.smtpHost.trim() || null;
    if (b.smtpPort !== undefined) {
      const port = parseInt(b.smtpPort, 10);
      data.smtpPort = Number.isFinite(port) ? port : null;
    }
    if (typeof b.smtpSecure === "boolean") data.smtpSecure = b.smtpSecure;
    if (typeof b.smtpUsername === "string") {
      data.smtpUsername = b.smtpUsername.trim() || null;
    }
    if (typeof b.smtpFromName === "string") {
      data.smtpFromName = b.smtpFromName.trim() || null;
    }
    if (typeof b.smtpFromEmail === "string") {
      data.smtpFromEmail = b.smtpFromEmail.trim() || null;
    }
    // Same blank-to-keep behaviour for the SMTP password. Encrypted before storage.
    if (typeof b.smtpPassword === "string" && b.smtpPassword.trim()) {
      data.smtpPassword = encryptSecret(b.smtpPassword);
    }

    const updated = await prisma.settings.update({ where: { id: s.id }, data });
    res.json({ settings: publicSettings(updated) });
  } catch (err) {
    next(err);
  }
}

// POST /settings/email/test  (protected) — send a test email.
// Uses the saved SMTP settings, but lets the UI override any field (so the user
// can test the form they're looking at before saving). A blank password falls
// back to the saved one.
export async function sendTestEmail(req, res, next) {
  try {
    const b = req.body || {};
    const s = await getOrCreateSettings();

    const pick = (bodyVal, savedVal) =>
      typeof bodyVal === "string" && bodyVal.trim() ? bodyVal.trim() : savedVal;

    const cfg = {
      host: pick(b.smtpHost, s.smtpHost),
      port:
        b.smtpPort !== undefined && b.smtpPort !== ""
          ? parseInt(b.smtpPort, 10)
          : s.smtpPort,
      secure: typeof b.smtpSecure === "boolean" ? b.smtpSecure : s.smtpSecure,
      username: pick(b.smtpUsername, s.smtpUsername),
      password:
        typeof b.smtpPassword === "string" && b.smtpPassword.trim()
          ? b.smtpPassword
          : decryptSecret(s.smtpPassword),
      fromName: pick(b.smtpFromName, s.smtpFromName),
      fromEmail: pick(b.smtpFromEmail, s.smtpFromEmail),
    };

    const to = typeof b.to === "string" ? b.to.trim() : "";
    if (!to) {
      return res.status(400).json({ error: "Recipient email is required." });
    }
    if (!cfg.host || !cfg.port) {
      return res
        .status(400)
        .json({ error: "SMTP host and port are required." });
    }
    if (!cfg.fromEmail) {
      return res.status(400).json({ error: "A 'from' email address is required." });
    }
    if (!cfg.password) {
      return res.status(400).json({
        error: "SMTP password is required — enter it, or save settings first.",
      });
    }

    try {
      const info = await sendMail(cfg, {
        to,
        subject: "SMTP test email",
        text: "This is a test email to verify your SMTP configuration. If you received this, your settings are working correctly.",
        html: "<p>This is a <strong>test email</strong> to verify your SMTP configuration.</p><p>If you received this, your settings are working correctly. ✅</p>",
      });
      return res.json({
        ok: true,
        message: `Test email sent to ${to}.`,
        messageId: info?.messageId,
      });
    } catch (e) {
      // Surface the SMTP error (auth failure, connection refused, etc.) to the UI.
      return res
        .status(400)
        .json({ error: `Could not send: ${e.message || "SMTP error."}` });
    }
  } catch (err) {
    next(err);
  }
}
