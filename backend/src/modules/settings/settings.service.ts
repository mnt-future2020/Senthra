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

// The default customer stock-entry barcode prefix when none is configured.
// Matches the historical hardcoded value so existing codes stay consistent.
export const DEFAULT_STOCK_CODE_PREFIX = "CSE";

// The default IRM catalogue item-code prefix when none is configured.
// Matches the historical hardcoded value so existing item codes stay consistent.
export const DEFAULT_IRM_CODE_PREFIX = "IRM";

// Default display prefix for rental catalogue item codes (RNT-0001). The COUNTER key is a separate,
// fixed constant in rentalCode.ts — see the note there.
export const DEFAULT_RENTAL_CODE_PREFIX = "RNT";

// Read-time defaults for the company-profile + regional settings. Applied only when the stored
// value is blank, so they stay fully overridable (never hardcoded into downstream documents).
export const DEFAULT_COMPANY_COUNTRY = "United Kingdom";
export const DEFAULT_TIMEZONE = "Europe/London";
export const DEFAULT_DATE_FORMAT = "DD/MM/YYYY";
export const DEFAULT_TIME_FORMAT = "24h";

// After how many days stock still held by an engineer counts as OVERDUE. Applied at READ time so a
// fresh install, a legacy row and an admin who clears the field all behave identically — the fallback
// lives here, not frozen into every stored document.
export const DEFAULT_OVERDUE_AFTER_DAYS = 14;
// Bounds shared with the zod schema. Below 1 the window is meaningless; the ceiling stops a typo like
// "3650" quietly turning the overdue list into "every job we have ever run".
export const MIN_OVERDUE_AFTER_DAYS = 1;
export const MAX_OVERDUE_AFTER_DAYS = 365;

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

// Clean a stored/configured stock-code prefix the same way as the employee one:
// uppercase, letters only, 2–5 chars; falls back to the default when invalid/blank
// so barcode generation always has a sane prefix.
function normalizeStockCodePrefix(raw?: string | null): string {
  const clean = (raw ?? "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  return clean.length >= 2 ? clean.slice(0, 5) : DEFAULT_STOCK_CODE_PREFIX;
}

// The effective stock-entry barcode prefix, for the customer module's barcode allocation.
export async function getStockCodePrefix(): Promise<string> {
  const s = await settingsRepo.getOrCreate();
  return normalizeStockCodePrefix(s.stockCodePrefix);
}

// Clean a stored/configured IRM item-code prefix (uppercase, letters only, 2–5 chars);
// falls back to the default when invalid/blank so item-code allocation always has a sane prefix.
function normalizeIrmCodePrefix(raw?: string | null): string {
  const clean = (raw ?? "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  return clean.length >= 2 ? clean.slice(0, 5) : DEFAULT_IRM_CODE_PREFIX;
}

// The effective IRM item-code prefix, for the IRM module's item-code allocation.
export async function getIrmCodePrefix(): Promise<string> {
  const s = await settingsRepo.getOrCreate();
  return normalizeIrmCodePrefix(s.irmCodePrefix);
}

// Clean a stored/configured RENTAL item-code prefix (uppercase, letters only, 2–5 chars); falls back
// to the default when invalid/blank so code allocation always has a sane prefix.
function normalizeRentalCodePrefix(raw?: string | null): string {
  const clean = (raw ?? "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  return clean.length >= 2 ? clean.slice(0, 5) : DEFAULT_RENTAL_CODE_PREFIX;
}

// The effective rental item-code prefix, for the rental module's code allocation.
export async function getRentalCodePrefix(): Promise<string> {
  const s = await settingsRepo.getOrCreate();
  return normalizeRentalCodePrefix(s.rentalCodePrefix);
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

// --- Reusable readers (the single consumption point for downstream modules) ---
// Future modules (PO supplier email, and later PO/GRN/GDN/Delivery-Note/Job-Pack/Report documents
// + exports) MUST call these instead of reading the raw Settings row, so company identity / regional
// formatting stay defined in exactly one place.

// The company's legal identity for official documents. `country` is default-filled (overridable);
// `logoUrl` is a READ-ONLY passthrough of the branding logo (Settings.logoUrl) — the single source
// of truth — so a document gets its whole letterhead from one call without a second logo field.
export interface CompanyProfile {
  legalName: string;
  registrationNumber: string;
  vatNumber: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  county: string;
  postcode: string;
  country: string;
  phone: string;
  email: string;
  website: string;
  logoUrl: string;
}

export async function getCompanyProfile(): Promise<CompanyProfile> {
  const s = await settingsRepo.getOrCreate();
  return {
    legalName: s.companyLegalName || "",
    registrationNumber: s.companyRegNumber || "",
    vatNumber: s.vatNumber || "",
    addressLine1: s.companyAddressLine1 || "",
    addressLine2: s.companyAddressLine2 || "",
    city: s.companyCity || "",
    county: s.companyCounty || "",
    postcode: s.companyPostcode || "",
    country: s.companyCountry || DEFAULT_COMPANY_COUNTRY,
    phone: s.companyPhone || "",
    email: s.companyEmail || "",
    website: s.websiteUrl || "",
    logoUrl: s.logoUrl || "", // single source of truth = branding logo (NOT a new field)
  };
}

// Regional formatting prefs — a cross-cutting concern (documents, emails, audit display, exports).
// All default-filled so a consumer never has to handle null.
export interface RegionalSettings {
  timezone: string;
  dateFormat: string;
  timeFormat: string;
}

export async function getRegionalSettings(): Promise<RegionalSettings> {
  const s = await settingsRepo.getOrCreate();
  return {
    timezone: s.timezone || DEFAULT_TIMEZONE,
    dateFormat: s.dateFormat || DEFAULT_DATE_FORMAT,
    timeFormat: s.timeFormat || DEFAULT_TIME_FORMAT,
  };
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
  stockCodePrefix: string;
  irmCodePrefix: string;
  rentalCodePrefix: string;
  // Company profile (legal identity for documents) + regional formatting. Default-filled on read.
  companyLegalName: string;
  companyRegNumber: string;
  vatNumber: string;
  companyAddressLine1: string;
  companyAddressLine2: string;
  companyCity: string;
  companyCounty: string;
  companyPostcode: string;
  companyCountry: string;
  companyPhone: string;
  companyEmail: string;
  websiteUrl: string;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  // Engineer-to-engineer transfer feature flags.
  engineerTransferRequireSignature: boolean;
  /** Overdue window in days, default already applied — never null to the client. */
  overdueAfterDays: number;
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

    // Stock-entry barcode prefix (effective value, default-filled).
    stockCodePrefix: normalizeStockCodePrefix(s.stockCodePrefix),

    // IRM item-code prefix (effective value, default-filled).
    irmCodePrefix: normalizeIrmCodePrefix(s.irmCodePrefix),

    // Rental item-code prefix (effective value, default-filled).
    rentalCodePrefix: normalizeRentalCodePrefix(s.rentalCodePrefix),

    // Company profile (text fields empty when unset; country/regional default-filled).
    companyLegalName: s.companyLegalName || "",
    companyRegNumber: s.companyRegNumber || "",
    vatNumber: s.vatNumber || "",
    companyAddressLine1: s.companyAddressLine1 || "",
    companyAddressLine2: s.companyAddressLine2 || "",
    companyCity: s.companyCity || "",
    companyCounty: s.companyCounty || "",
    companyPostcode: s.companyPostcode || "",
    companyCountry: s.companyCountry || DEFAULT_COMPANY_COUNTRY,
    companyPhone: s.companyPhone || "",
    companyEmail: s.companyEmail || "",
    websiteUrl: s.websiteUrl || "",
    timezone: s.timezone || DEFAULT_TIMEZONE,
    dateFormat: s.dateFormat || DEFAULT_DATE_FORMAT,
    timeFormat: s.timeFormat || DEFAULT_TIME_FORMAT,

    // Branding
    ...brandingFrom(s),

    // Engineer transfer feature flags
    engineerTransferRequireSignature: s.engineerTransferRequireSignature ?? false,

    // Goods management
    overdueAfterDays: s.overdueAfterDays ?? DEFAULT_OVERDUE_AFTER_DAYS,
  };
}

/**
 * The configured overdue window, with the default applied. Read by goods-management for BOTH the
 * Overdue list and the Inventory Hub's count, so one edit here moves every screen that says "overdue"
 * together instead of leaving each with its own hardcoded fortnight.
 */
export async function getOverdueAfterDays(): Promise<number> {
  const s = await settingsRepo.getOrCreate();
  return s.overdueAfterDays ?? DEFAULT_OVERDUE_AFTER_DAYS;
}

// The company's IANA timezone, applied at READ time like every other setting default. This is what
// "today" means for any DAY-BOUNDARY decision (due today, overdue, due this week) — one answer for the
// whole company, not per warehouse: a job is not scoped to a warehouse at all (only its kit lines
// are), so a per-warehouse answer would leave the dashboard's company-wide counts with no timezone to
// use and let them drift from the queue.
export async function getCompanyTimezone(): Promise<string> {
  const s = await settingsRepo.getOrCreate();
  return s.timezone || DEFAULT_TIMEZONE;
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
  stockCodePrefix?: string;
  irmCodePrefix?: string;
  rentalCodePrefix?: string;
  // Company profile + regional (all optional; empty string clears back to null → default on read).
  companyLegalName?: string;
  companyRegNumber?: string;
  vatNumber?: string;
  companyAddressLine1?: string;
  companyAddressLine2?: string;
  companyCity?: string;
  companyCounty?: string;
  companyPostcode?: string;
  companyCountry?: string;
  companyPhone?: string;
  companyEmail?: string;
  websiteUrl?: string;
  timezone?: string;
  dateFormat?: string;
  timeFormat?: string;
  // Engineer-to-engineer transfer feature flags.
  engineerTransferRequireSignature?: boolean;
  // Goods management: the overdue window, in days. `""` clears it back to the read-time default.
  overdueAfterDays?: number | "";
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
  if (typeof input.stockCodePrefix === "string") {
    data.stockCodePrefix = input.stockCodePrefix.trim().toUpperCase() || null;
  }
  if (typeof input.irmCodePrefix === "string") {
    data.irmCodePrefix = input.irmCodePrefix.trim().toUpperCase() || null;
  }
  if (typeof input.rentalCodePrefix === "string") {
    data.rentalCodePrefix = input.rentalCodePrefix.trim().toUpperCase() || null;
  }

  // --- Company profile + regional (trim; empty string clears to null → default applies on read) ---
  if (typeof input.companyLegalName === "string") data.companyLegalName = input.companyLegalName.trim() || null;
  if (typeof input.companyRegNumber === "string") data.companyRegNumber = input.companyRegNumber.trim() || null;
  if (typeof input.vatNumber === "string") data.vatNumber = input.vatNumber.trim() || null;
  if (typeof input.companyAddressLine1 === "string") data.companyAddressLine1 = input.companyAddressLine1.trim() || null;
  if (typeof input.companyAddressLine2 === "string") data.companyAddressLine2 = input.companyAddressLine2.trim() || null;
  if (typeof input.companyCity === "string") data.companyCity = input.companyCity.trim() || null;
  if (typeof input.companyCounty === "string") data.companyCounty = input.companyCounty.trim() || null;
  if (typeof input.companyPostcode === "string") data.companyPostcode = input.companyPostcode.trim() || null;
  if (typeof input.companyCountry === "string") data.companyCountry = input.companyCountry.trim() || null;
  if (typeof input.companyPhone === "string") data.companyPhone = input.companyPhone.trim() || null;
  if (typeof input.companyEmail === "string") data.companyEmail = input.companyEmail.trim() || null;
  if (typeof input.websiteUrl === "string") data.websiteUrl = input.websiteUrl.trim() || null;
  if (typeof input.timezone === "string") data.timezone = input.timezone.trim() || null;
  if (typeof input.dateFormat === "string") data.dateFormat = input.dateFormat.trim() || null;
  if (typeof input.timeFormat === "string") data.timeFormat = input.timeFormat.trim() || null;

  // Engineer transfer flags
  if (typeof input.engineerTransferRequireSignature === "boolean") data.engineerTransferRequireSignature = input.engineerTransferRequireSignature;
  // "" clears the override so getOverdueAfterDays falls back to the default — same contract as the
  // other nullable settings, and what the schema comment promises.
  if (typeof input.overdueAfterDays === "number") data.overdueAfterDays = input.overdueAfterDays;
  else if (input.overdueAfterDays === "") data.overdueAfterDays = null;

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
  // Deterministic public id (`logo` / `favicon`) with overwrite — a replacement lands on the same
  // asset, so there is never an older file to clean up and no identity worth storing.
  const { url } = await uploadToCloudinary(image, type, creds);
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
