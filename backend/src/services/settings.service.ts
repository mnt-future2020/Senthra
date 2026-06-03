import type { Prisma, Settings } from "@prisma/client";

import { sendMail } from "../lib/mailer.js";
import * as settingsRepo from "../repositories/settings.repository.js";
import { decryptSecret, encryptSecret } from "../utils/crypto.js";
import { badRequest } from "../utils/http-error.js";

// Never send secrets (Google client secret, SMTP password) to the browser —
// only whether one is set.
export interface PublicSettings {
  googleEnabled: boolean;
  googleClientId: string;
  googleClientSecretSet: boolean;
  smtpEnabled: boolean;
  smtpHost: string;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpFromName: string;
  smtpFromEmail: string;
  smtpPasswordSet: boolean;
}

function publicSettings(s: Settings): PublicSettings {
  return {
    // Google Sign-In
    googleEnabled: s.googleEnabled,
    googleClientId: s.googleClientId || "",
    googleClientSecretSet: Boolean(s.googleClientSecret),

    // SMTP email
    smtpEnabled: s.smtpEnabled,
    smtpHost: s.smtpHost || "",
    smtpPort: s.smtpPort ?? null,
    smtpSecure: s.smtpSecure,
    smtpUsername: s.smtpUsername || "",
    smtpFromName: s.smtpFromName || "",
    smtpFromEmail: s.smtpFromEmail || "",
    smtpPasswordSet: Boolean(s.smtpPassword),
  };
}

export async function getSettings(): Promise<PublicSettings> {
  const s = await settingsRepo.getOrCreate();
  return publicSettings(s);
}

export interface UpdateSettingsParams {
  googleEnabled?: boolean;
  googleClientId?: string;
  googleClientSecret?: string;
  smtpEnabled?: boolean;
  smtpHost?: string;
  smtpPort?: string | number;
  smtpSecure?: boolean;
  smtpUsername?: string;
  smtpFromName?: string;
  smtpFromEmail?: string;
  smtpPassword?: string;
}

export async function updateSettings(input: UpdateSettingsParams): Promise<PublicSettings> {
  const s = await settingsRepo.getOrCreate();
  const data: Prisma.SettingsUpdateInput = {};

  // --- Google Sign-In ---
  if (typeof input.googleEnabled === "boolean") data.googleEnabled = input.googleEnabled;
  if (typeof input.googleClientId === "string") {
    data.googleClientId = input.googleClientId.trim() || null;
  }
  // Only overwrite the secret when a non-empty value is sent, so the UI can leave
  // it blank to keep the existing one. Encrypted before storage.
  if (typeof input.googleClientSecret === "string" && input.googleClientSecret.trim()) {
    data.googleClientSecret = encryptSecret(input.googleClientSecret.trim());
  }

  // --- SMTP email ---
  if (typeof input.smtpEnabled === "boolean") data.smtpEnabled = input.smtpEnabled;
  if (typeof input.smtpHost === "string") data.smtpHost = input.smtpHost.trim() || null;
  if (input.smtpPort !== undefined && input.smtpPort !== "") {
    const port = parseInt(String(input.smtpPort), 10);
    data.smtpPort = Number.isFinite(port) ? port : null;
  } else if (input.smtpPort === "") {
    data.smtpPort = null;
  }
  if (typeof input.smtpSecure === "boolean") data.smtpSecure = input.smtpSecure;
  if (typeof input.smtpUsername === "string") {
    data.smtpUsername = input.smtpUsername.trim() || null;
  }
  if (typeof input.smtpFromName === "string") {
    data.smtpFromName = input.smtpFromName.trim() || null;
  }
  if (typeof input.smtpFromEmail === "string") {
    data.smtpFromEmail = input.smtpFromEmail.trim() || null;
  }
  // Same blank-to-keep behaviour for the SMTP password. Encrypted before storage.
  if (typeof input.smtpPassword === "string" && input.smtpPassword.trim()) {
    data.smtpPassword = encryptSecret(input.smtpPassword);
  }

  const updated = await settingsRepo.update(s.id, data);
  return publicSettings(updated);
}

export interface TestEmailParams {
  to?: string;
  smtpHost?: string;
  smtpPort?: string | number;
  smtpSecure?: boolean;
  smtpUsername?: string;
  smtpPassword?: string;
  smtpFromName?: string;
  smtpFromEmail?: string;
}

// Send a test email. Uses the saved SMTP settings, but lets the UI override any
// field (so the user can test the form before saving). A blank password falls
// back to the saved one.
export async function sendTestEmail(
  input: TestEmailParams,
): Promise<{ message: string; messageId?: string }> {
  const s = await settingsRepo.getOrCreate();

  const pick = (override: string | undefined, saved: string | null): string | null =>
    typeof override === "string" && override.trim() ? override.trim() : saved;

  const host = pick(input.smtpHost, s.smtpHost);
  const port =
    input.smtpPort !== undefined && input.smtpPort !== ""
      ? parseInt(String(input.smtpPort), 10)
      : s.smtpPort;
  const secure = typeof input.smtpSecure === "boolean" ? input.smtpSecure : s.smtpSecure;
  const username = pick(input.smtpUsername, s.smtpUsername);
  const password =
    typeof input.smtpPassword === "string" && input.smtpPassword.trim()
      ? input.smtpPassword
      : decryptSecret(s.smtpPassword);
  const fromName = pick(input.smtpFromName, s.smtpFromName);
  const fromEmail = pick(input.smtpFromEmail, s.smtpFromEmail);

  const to = typeof input.to === "string" ? input.to.trim() : "";
  if (!to) throw badRequest("Recipient email is required.");
  if (!host || !port) throw badRequest("SMTP host and port are required.");
  if (!fromEmail) throw badRequest("A 'from' email address is required.");
  if (!password) {
    throw badRequest("SMTP password is required — enter it, or save settings first.");
  }

  try {
    const info = await sendMail(
      {
        host,
        port,
        secure: Boolean(secure),
        username: username ?? "",
        password,
        fromName: fromName ?? "",
        fromEmail,
      },
      {
        to,
        subject: "SMTP test email",
        text: "This is a test email to verify your SMTP configuration. If you received this, your settings are working correctly.",
        html: "<p>This is a <strong>test email</strong> to verify your SMTP configuration.</p><p>If you received this, your settings are working correctly. ✅</p>",
      },
    );
    return { message: `Test email sent to ${to}.`, messageId: info?.messageId };
  } catch (e) {
    // Surface the SMTP error (auth failure, connection refused, etc.) to the UI.
    throw badRequest(`Could not send: ${e instanceof Error ? e.message : "SMTP error."}`);
  }
}
