import type { Prisma, Settings } from "@prisma/client";

import { env } from "../../config/env.js";
import { uploadToCloudinary, type CloudinaryCreds } from "../../lib/cloudinary.js";
import { sendMail } from "../../lib/mailer.js";
import * as settingsRepo from "./settings.repository.js";
import { decryptSecret, encryptSecret } from "../../utils/crypto.js";
import { safeBrandColor } from "../../utils/email-html.js";
import { badRequest } from "../../utils/http-error.js";

// Resolve Cloudinary credentials: UI-configured (DB) takes precedence, then env.
// Returns null when neither is fully configured.
function resolveCloudinaryCreds(s: Settings): CloudinaryCreds | null {
  const dbSecret = s.cloudinaryApiSecret ? decryptSecret(s.cloudinaryApiSecret) : null;
  if (s.cloudinaryCloudName && s.cloudinaryApiKey && dbSecret) {
    return {
      cloudName: s.cloudinaryCloudName,
      apiKey: s.cloudinaryApiKey,
      apiSecret: dbSecret,
    };
  }
  if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
    return {
      cloudName: env.CLOUDINARY_CLOUD_NAME,
      apiKey: env.CLOUDINARY_API_KEY,
      apiSecret: env.CLOUDINARY_API_SECRET,
    };
  }
  return null;
}

// Resolve the active Cloudinary credentials (DB-configured, else env). Exposed so
// other features (e.g. user profile-image uploads) reuse the same resolution as
// branding instead of duplicating it. Returns null when not configured.
export async function getCloudinaryCreds(): Promise<CloudinaryCreds | null> {
  const s = await settingsRepo.getOrCreate();
  return resolveCloudinaryCreds(s);
}

// --- Employee ID prefix (authenticated settings, NOT public branding) ---
// The default staff-reference prefix when none is configured. Deliberately not
// derived from brandName — a permanent identifier must not change when the brand's
// display name is renamed.
export const DEFAULT_EMPLOYEE_ID_PREFIX = "SNT";

// Clean a stored/configured prefix into a usable code: uppercase, letters only,
// 2–5 chars. Anything shorter/invalid falls back to the default, so employee-ID
// generation always has a sane prefix even for legacy/blank rows.
function normalizeEmployeeIdPrefix(raw?: string | null): string {
  const clean = (raw ?? "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  return clean.length >= 2 ? clean.slice(0, 5) : DEFAULT_EMPLOYEE_ID_PREFIX;
}

// The effective staff-ID prefix, for the user module's employee-ID allocation.
export async function getEmployeeIdPrefix(): Promise<string> {
  const s = await settingsRepo.getOrCreate();
  return normalizeEmployeeIdPrefix(s.employeeIdPrefix);
}

// --- Branding (all public) ---
export interface PublicBranding {
  brandName: string;
  brandColor: string;
  logoUrl: string;
  faviconUrl: string;
  footerText: string;
  loginHeadline: string;
  loginSubtext: string;
}

// Map a Settings row to public branding, filling sensible defaults so a fresh
// install still looks complete.
function brandingFrom(s: Settings): PublicBranding {
  const brandName = (s.brandName && s.brandName.trim()) || "Senthra";
  return {
    brandName,
    brandColor: safeBrandColor(s.brandColor),
    logoUrl: s.logoUrl || "",
    faviconUrl: s.faviconUrl || "",
    footerText:
      s.footerText ||
      `© ${new Date().getFullYear()} ${brandName}. All rights reserved.`,
    loginHeadline:
      s.loginHeadline || "Effortlessly manage your business and operations.",
    loginSubtext:
      s.loginSubtext ||
      "Sign in to access your admin dashboard and run everything from one place.",
  };
}

// Public branding for the login page etc. (no auth required).
export async function getBranding(): Promise<PublicBranding> {
  const s = await settingsRepo.getOrCreate();
  return brandingFrom(s);
}

// Never send secrets (Google client secret, SMTP password) to the browser —
// only whether one is set.
export interface PublicSettings extends PublicBranding {
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
  cloudinaryCloudName: string;
  cloudinaryApiKey: string;
  cloudinaryApiSecretSet: boolean;
  cloudinaryConfigured: boolean;
  employeeIdPrefix: string;
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

    // Cloudinary (image CDN)
    cloudinaryCloudName: s.cloudinaryCloudName || "",
    cloudinaryApiKey: s.cloudinaryApiKey || "",
    cloudinaryApiSecretSet: Boolean(s.cloudinaryApiSecret),
    cloudinaryConfigured: resolveCloudinaryCreds(s) !== null,

    // Staff-ID prefix (effective value, default-filled).
    employeeIdPrefix: normalizeEmployeeIdPrefix(s.employeeIdPrefix),

    // Branding
    ...brandingFrom(s),
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
  cloudinaryCloudName?: string;
  cloudinaryApiKey?: string;
  cloudinaryApiSecret?: string;
  brandName?: string;
  brandColor?: string;
  logoUrl?: string;
  faviconUrl?: string;
  footerText?: string;
  loginHeadline?: string;
  loginSubtext?: string;
  employeeIdPrefix?: string;
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
  // Same blank-to-keep behaviour for the SMTP password. Trimmed (a stray
  // trailing space/newline from a paste would silently break SMTP auth) then
  // encrypted before storage — consistent with the other secrets above.
  if (typeof input.smtpPassword === "string" && input.smtpPassword.trim()) {
    data.smtpPassword = encryptSecret(input.smtpPassword.trim());
  }

  // --- Cloudinary (cloud name + key plaintext; secret encrypted, blank-to-keep) ---
  if (typeof input.cloudinaryCloudName === "string") {
    data.cloudinaryCloudName = input.cloudinaryCloudName.trim() || null;
  }
  if (typeof input.cloudinaryApiKey === "string") {
    data.cloudinaryApiKey = input.cloudinaryApiKey.trim() || null;
  }
  if (typeof input.cloudinaryApiSecret === "string" && input.cloudinaryApiSecret.trim()) {
    data.cloudinaryApiSecret = encryptSecret(input.cloudinaryApiSecret.trim());
  }

  // --- Branding (empty string clears the field back to its default) ---
  if (typeof input.brandName === "string") data.brandName = input.brandName.trim() || null;
  // Only persist a well-formed hex; an empty string clears it back to the default.
  if (typeof input.brandColor === "string") {
    const c = input.brandColor.trim();
    data.brandColor = c ? safeBrandColor(c) : null;
  }
  if (typeof input.logoUrl === "string") data.logoUrl = input.logoUrl.trim() || null;
  if (typeof input.faviconUrl === "string") data.faviconUrl = input.faviconUrl.trim() || null;
  if (typeof input.footerText === "string") data.footerText = input.footerText.trim() || null;
  if (typeof input.loginHeadline === "string") {
    data.loginHeadline = input.loginHeadline.trim() || null;
  }
  if (typeof input.loginSubtext === "string") {
    data.loginSubtext = input.loginSubtext.trim() || null;
  }
  // Stored uppercased; empty clears it back to the default. Validation already
  // bounded it to 2–5 letters.
  if (typeof input.employeeIdPrefix === "string") {
    data.employeeIdPrefix = input.employeeIdPrefix.trim().toUpperCase() || null;
  }

  const updated = await settingsRepo.update(s.id, data);
  return publicSettings(updated);
}

// Upload a logo/favicon image to Cloudinary and save its URL on the settings row.
export async function uploadBrandingImage(
  type: "logo" | "favicon",
  image: string,
): Promise<{ url: string; settings: PublicSettings }> {
  const s = await settingsRepo.getOrCreate();
  const creds = resolveCloudinaryCreds(s);
  if (!creds) {
    throw badRequest(
      "Cloudinary isn't configured. Add your Cloudinary credentials in Settings → Integrations (or set CLOUDINARY_* in the backend env).",
    );
  }
  const url = await uploadToCloudinary(image, type, creds);
  const data: Prisma.SettingsUpdateInput =
    type === "logo" ? { logoUrl: url } : { faviconUrl: url };
  const updated = await settingsRepo.update(s.id, data);
  return { url, settings: publicSettings(updated) };
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
      ? input.smtpPassword.trim()
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
        subject: `${s.brandName?.trim() || "Senthra"} — SMTP test email`,
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
