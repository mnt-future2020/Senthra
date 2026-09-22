import type { Prisma, Settings } from "@prisma/client";

import { env } from "../../config/env.js";
import { findActiveStorage } from "../../lib/storage/index.js";
import type { CloudinaryCreds } from "../../lib/storage/cloudinary.js";
import { probeSpacesConnection, type SpacesConfig } from "../../lib/storage/spaces.js";
import { generateDerivatives, type DerivativeIntent } from "../../lib/storage/derivatives.js";
import { sendMail } from "../../lib/mailer.js";
import * as settingsRepo from "./settings.repository.js";
import {
  resolveBrandName,
  resolveFooterText,
  resolveLoginHeadline,
  resolveLoginSubtext,
  storedFooterText,
  storedLoginHeadline,
  storedLoginSubtext,
} from "./branding.defaults.js";
import { createHash } from "node:crypto";

import { decryptSecret, encryptSecret } from "../../utils/crypto.js";
import { DEFAULT_BRAND_COLOR, safeBrandColor } from "../../utils/email-html.js";
import { badRequest } from "../../utils/http-error.js";
import * as auditService from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";

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

/**
 * Resolve DigitalOcean Spaces configuration: UI-configured (DB) first, then env.
 *
 * ALL FIVE of endpoint/region/bucket/key/secret are required together — a half-configured provider
 * is not usable, and returning a partial object would push the failure into the SDK, where it
 * surfaces as an opaque credentials error rather than "you have not finished setting this up".
 * Returns null when incomplete, which is the same shape the Cloudinary resolver uses and which
 * every caller already handles.
 *
 * The DB and env sets are NOT merged field by field. Mixing a DB bucket with an env secret would
 * make a half-finished Settings edit silently inherit the other half from a deployment variable —
 * an upload landing somewhere nobody chose. Whichever source is complete wins, whole.
 */
function resolveSpacesConfig(s: Settings): SpacesConfig | null {
  const dbSecret = s.spacesSecretKey ? decryptSecret(s.spacesSecretKey) : null;
  if (s.spacesEndpoint && s.spacesRegion && s.spacesBucket && s.spacesAccessKeyId && dbSecret) {
    return {
      endpoint: s.spacesEndpoint,
      region: s.spacesRegion,
      bucket: s.spacesBucket,
      accessKeyId: s.spacesAccessKeyId,
      secretAccessKey: dbSecret,
      cdnUrl: s.spacesCdnUrl ?? null,
    };
  }
  if (
    env.SPACES_ENDPOINT &&
    env.SPACES_REGION &&
    env.SPACES_BUCKET &&
    env.SPACES_ACCESS_KEY_ID &&
    env.SPACES_SECRET_KEY
  ) {
    return {
      endpoint: env.SPACES_ENDPOINT,
      region: env.SPACES_REGION,
      bucket: env.SPACES_BUCKET,
      accessKeyId: env.SPACES_ACCESS_KEY_ID,
      secretAccessKey: env.SPACES_SECRET_KEY,
      cdnUrl: env.SPACES_CDN_URL ?? null,
    };
  }
  return null;
}

/** The active Spaces configuration (DB-configured, else env), or null when incomplete. */
export async function getSpacesConfig(): Promise<SpacesConfig | null> {
  const s = await settingsRepo.getOrCreate();
  return resolveSpacesConfig(s);
}

/**
 * The Spaces fields a connection test may carry.
 *
 * All optional, because the form sends what it has: a blank secret means "keep the stored one",
 * matching the blank-to-keep convention every other secret in this file uses.
 */
/** The Cloudinary fields a connection test may carry. Blank secret means "keep the stored one". */
export interface CloudinaryTestParams {
  cloudinaryCloudName?: string;
  cloudinaryApiKey?: string;
  cloudinaryApiSecret?: string;
}

/**
 * The Cloudinary credentials a test should be judged against.
 *
 * THE VALUES BEING SUBMITTED, falling back to what is stored — the exact rule
 * `resolveSpacesTestConfig` uses, and for the same reason: confirming the saved credentials while
 * the form holds new ones tells the administrator nothing about what they are about to save.
 */
async function resolveCloudinaryTestCreds(input: CloudinaryTestParams): Promise<CloudinaryCreds | null> {
  const stored = await getCloudinaryCreds();
  const pick = (submitted: string | undefined, fallback: string | undefined) =>
    (typeof submitted === "string" ? submitted.trim() : "") || fallback?.trim() || "";

  const cloudName = pick(input.cloudinaryCloudName, stored?.cloudName);
  const apiKey = pick(input.cloudinaryApiKey, stored?.apiKey);
  const apiSecret = pick(input.cloudinaryApiSecret, stored?.apiSecret);

  return cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret } : null;
}

export interface SpacesTestParams {
  spacesEndpoint?: string;
  spacesRegion?: string;
  spacesBucket?: string;
  spacesAccessKeyId?: string;
  spacesSecretKey?: string;
  spacesCdnUrl?: string;
}

/**
 * The configuration a test — or a switch — should actually be judged against.
 *
 * THE VALUES BEING SUBMITTED, not the ones already stored. Testing the stored row while the form
 * holds unsaved edits would tell the administrator their NEW bucket works when it was the OLD one
 * that answered; the switch guard would then approve a configuration nobody verified.
 *
 * A field the caller omits falls back to what is stored, which is what makes "test" work on a form
 * where only the bucket was touched — and what makes a blank secret mean "keep the saved one"
 * rather than "test with an empty secret".
 */
async function resolveSpacesTestConfig(input: SpacesTestParams): Promise<SpacesConfig | null> {
  const s = await settingsRepo.getOrCreate();
  const pick = (submitted: string | undefined, stored: string | null) =>
    (typeof submitted === "string" ? submitted.trim() : "") || stored?.trim() || "";

  const endpoint = pick(input.spacesEndpoint, s.spacesEndpoint);
  const region = pick(input.spacesRegion, s.spacesRegion);
  const bucket = pick(input.spacesBucket, s.spacesBucket);
  const accessKeyId = pick(input.spacesAccessKeyId, s.spacesAccessKeyId);
  const submittedSecret = input.spacesSecretKey?.trim();
  const secretAccessKey = submittedSecret || (s.spacesSecretKey ? String(decryptSecret(s.spacesSecretKey)) : "");
  const cdnUrl = pick(input.spacesCdnUrl, s.spacesCdnUrl) || null;

  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, cdnUrl };
}

/**
 * Configurations proven to work, and when.
 *
 * IN MEMORY, not in the database, and that is the point: "this configuration was verified" is a
 * fact about the last few minutes, not durable state. A restart simply means testing again, which
 * is the safe direction to fail in — the alternative is a stored "verified" flag that outlives the
 * credentials it described.
 *
 * Keyed by a HASH of the configuration, so a passing test only unlocks the exact values that were
 * tested. Change the bucket after testing and the switch is refused again, which is the whole
 * guarantee: what was verified is what gets saved.
 */
const verifiedConfigs = new Map<string, number>();
const VERIFICATION_TTL_MS = 30 * 60 * 1000;

/** A stable fingerprint of one configuration. The secret is hashed, never stored or logged. */
function configFingerprint(c: SpacesConfig): string {
  return createHash("sha256")
    .update([c.endpoint, c.region, c.bucket, c.accessKeyId, c.secretAccessKey].join("\u0000"))
    .digest("hex");
}

function recordVerified(c: SpacesConfig): void {
  // Swept on write, which is the only moment this map grows. Expired entries were previously left
  // in place for ever: `isVerified` checks the timestamp, so they were harmless but immortal, and a
  // long-lived process that had its storage credentials rotated a few hundred times kept every one
  // of those fingerprints. Cheap to do here, and it keeps the map the size of what is actually live.
  const cutoff = Date.now() - VERIFICATION_TTL_MS;
  for (const [fingerprint, at] of verifiedConfigs) {
    if (at < cutoff) verifiedConfigs.delete(fingerprint);
  }
  verifiedConfigs.set(configFingerprint(c), Date.now());
}

function isVerified(c: SpacesConfig): boolean {
  const at = verifiedConfigs.get(configFingerprint(c));
  return at !== undefined && Date.now() - at < VERIFICATION_TTL_MS;
}

/** Test-only: forget every recorded verification. */
export function __resetStorageVerifications(): void {
  verifiedConfigs.clear();
}

/**
 * The raw `storageProvider` column, exactly as stored.
 *
 * Returned UNNORMALISED on purpose: `normalizeProviderId` in the storage layer is the single place
 * that decides what null means, and having two functions answer that question is how they start
 * disagreeing.
 */
export async function getStoredProviderId(): Promise<string | null> {
  return (await settingsRepo.getOrCreate()).storageProvider;
}

/**
 * Prove a Spaces configuration actually works, before anything is allowed to depend on it.
 *
 * WHAT IT CHECKS, and why each step earns its place:
 *
 *   1. HeadBucket  — the endpoint resolves, the credentials are accepted, and the bucket exists.
 *   2. Put/Delete  — a zero-byte object under `_healthcheck/`, removed immediately.
 *
 * Step 2 is the one that matters. A read-only key passes step 1 perfectly and then fails every
 * upload the moment the provider is switched — which is precisely the "save it, discover it is
 * broken later" outcome the switch guard exists to prevent. The probe is the smallest thing that
 * proves the permissions the adapter actually needs, and it leaves nothing behind: the delete is
 * part of the test, and a failure to clean up is reported rather than ignored.
 *
 * Errors are mapped to sentences. An S3 error carries the endpoint, a request id and sometimes the
 * signature that failed, and none of that belongs in a message an administrator reads — least of all
 * anywhere near the secret key.
 */
export async function testStorageConnection(
  input: SpacesTestParams & CloudinaryTestParams & { provider: "cloudinary" | "spaces" },
): Promise<{ ok: boolean; message: string }> {
  // Cloudinary's own configuration check is the one this app has always had: whether a complete set
  // of credentials resolves. It is deliberately not a network call — Cloudinary's Admin API is rate
  // limited, and an upload proves far more than a ping would.
  if (input.provider === "cloudinary") {
    const creds = await resolveCloudinaryTestCreds(input);
    return creds
      ? { ok: true, message: `Cloudinary is configured (cloud "${creds.cloudName}").` }
      : { ok: false, message: "Add the Cloudinary cloud name, API key and API secret first." };
  }
  return testSpacesConnection(input);
}

export async function testSpacesConnection(input: SpacesTestParams): Promise<{ ok: boolean; message: string }> {
  const config = await resolveSpacesTestConfig(input);
  if (!config) {
    return {
      ok: false,
      message: "Complete the endpoint, region, bucket, access key and secret key before testing.",
    };
  }
  const result = await probeSpacesConnection(config);
  // Only a PASS is remembered, and only for the exact values that passed.
  if (result.ok) recordVerified(config);
  return result;
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

// The colours the PO document accepts: #RGB or #RRGGBB. Narrower than brandColor on purpose — pdfkit's
// colour parser mis-reads the 4- and 8-digit (alpha) forms, so they are refused rather than mis-drawn.
export const PO_ACCENT_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// The global branding colour permits CSS alpha forms for the dashboard and email. A PO PDF cannot
// consume them, so strip alpha here at the document-specific boundary without changing global branding.
function pdfSafeBrandColor(value: string | null | undefined): string {
  const color = safeBrandColor(value);
  if (PO_ACCENT_COLOR_RE.test(color)) return color;
  if (/^#[0-9a-fA-F]{4}$/.test(color)) {
    return `#${[...color.slice(1, 4)].map((channel) => channel + channel).join("")}`;
  }
  if (/^#[0-9a-fA-F]{8}$/.test(color)) return color.slice(0, 7);
  // Unreachable in practice — safeBrandColor already replaced anything malformed with this default.
  return DEFAULT_BRAND_COLOR;
}

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
  /**
   * Hostnames that serve files THIS app uploaded, so the browser can tell one of ours from a link
   * somebody pasted.
   *
   * PUBLIC BY CONSTRUCTION: these are delivery hostnames, and `logoUrl` in this same payload already
   * discloses one of them. No key, no secret, no bucket credential and no signature is involved.
   *
   * It rides on BRANDING rather than Settings because two of the four surfaces that render job
   * attachments — the engineer portal and the customer portal — belong to principals who cannot read
   * Settings at all. Branding is already fetched unauthenticated by every one of them.
   *
   * BOTH providers are always listed, whichever is active. An asset stays on the provider that
   * stored it forever, so the moment the inactive provider's host dropped out of this list, every
   * older attachment would start rendering as a pasted link.
   */
  uploadHosts: string[];
  brandColor: string;
  logoUrl: string;
  faviconUrl: string;
  footerText: string;
  loginHeadline: string;
  loginSubtext: string;
}

/** The hostname of a URL, lowercased. Null for anything that is not a parseable absolute URL. */
function hostOf(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  try {
    return new URL(v).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Every hostname this app serves its own uploads from.
 *
 * HOSTNAMES ONLY — no protocol, no path, no trailing slash. The browser compares `url.hostname`
 * against these exactly, so anything else here would either never match or, worse, turn the check
 * into a substring rule that a lookalike domain could satisfy.
 *
 * Deliberately derived from the DELIVERY configuration alone (endpoint, bucket, CDN) and NOT from
 * `resolveSpacesConfig`, which also requires the secret. An administrator rotating a secret key
 * would otherwise blank the host for a moment and every existing Spaces attachment would render as
 * a pasted link while they did it.
 *
 * Both providers, always — see PublicBranding.uploadHosts.
 */
function uploadHostsFrom(s: Settings): string[] {
  const hosts = new Set<string>();

  // Cloudinary delivers from one fixed host for every account, so it is a constant rather than
  // something derived from the cloud name.
  hosts.add("res.cloudinary.com");

  // The CDN when one is configured, AND the bucket's own origin: assets uploaded before a CDN was
  // added still carry origin URLs, and those rows are not rewritten.
  const cdn = hostOf(s.spacesCdnUrl ?? env.SPACES_CDN_URL);
  if (cdn) hosts.add(cdn);

  const endpointHost = hostOf(s.spacesEndpoint ?? env.SPACES_ENDPOINT);
  const bucket = (s.spacesBucket ?? env.SPACES_BUCKET)?.trim();
  // https://ams3.digitaloceanspaces.com + senthra-prod → senthra-prod.ams3.digitaloceanspaces.com,
  // which is the virtual-hosted form the adapter's own deliveryUrl builds.
  if (endpointHost && bucket) hosts.add(`${bucket.toLowerCase()}.${endpointHost}`);

  return [...hosts];
}

// Map a Settings row to public branding, filling sensible defaults so a fresh
// install still looks complete.
function brandingFrom(s: Settings): PublicBranding {
  const brandName = resolveBrandName(s.brandName);
  return {
    brandName,
    uploadHosts: uploadHostsFrom(s),
    brandColor: safeBrandColor(s.brandColor),
    logoUrl: s.logoUrl || "",
    faviconUrl: s.faviconUrl || "",
    // Footer + login copy defaults live in branding.defaults.ts — see there for why a stored
    // default is never trusted as-is.
    footerText: resolveFooterText(s.footerText, brandName),
    loginHeadline: resolveLoginHeadline(s.loginHeadline),
    loginSubtext: resolveLoginSubtext(s.loginSubtext),
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
  /**
   * The pdfkit-safe variant of `logoUrl`, when one is stored.
   *
   * NULL for a Cloudinary logo, which is transformed on delivery instead — see `pdfImageUrl`. It
   * travels beside the logo rather than being looked up later so the document renderer never has to
   * ask which provider an asset is on.
   */
  logoPdfUrl: string | null;
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
    // Its stored pdfkit-safe variant, travelling with it. Null on Cloudinary, where the same thing
    // is a delivery-time transform.
    logoPdfUrl: s.logoPdfUrl ?? null,
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

export interface PurchaseOrderDocumentBranding {
  logoUrl: string;
  /**
   * The stored pdfkit-safe variant of whichever logo `logoUrl` resolved to.
   *
   * Follows the SAME fallback: when there is no PO-specific logo the document uses the app logo, so
   * it must use the APP logo's derivative too. Pairing the wrong one would print the PO logo's
   * rasterisation of an image that is not being printed.
   */
  logoPdfUrl: string | null;
  accentColor: string;
}

/**
 * The logo and accent colour the PURCHASE ORDER PDF prints with: the PO-specific overrides from
 * Settings → Purchase Orders when set, otherwise the app branding — exactly the values every PO PDF
 * used before the overrides existed, so an install that never sets them renders unchanged.
 *
 * Read on every render (download, supplier email, issued archive) and snapshotted onto nothing: the
 * archived issued copy is the frozen record, as it already is for every other letterhead detail. The PO
 * document is its only reader — the app shell, emails and any other document never see these values.
 */
export async function getPurchaseOrderDocumentBranding(): Promise<PurchaseOrderDocumentBranding> {
  const s = await settingsRepo.getOrCreate();
  const accent = s.poDocAccentColor?.trim();
  // The derivative is chosen by WHICH logo won above, never independently.
  const usingPoLogo = Boolean(s.poDocLogoUrl);
  return {
    logoUrl: s.poDocLogoUrl || s.logoUrl || "",
    logoPdfUrl: (usingPoLogo ? s.poDocLogoPdfUrl : s.logoPdfUrl) ?? null,
    accentColor: accent && PO_ACCENT_COLOR_RE.test(accent) ? accent : pdfSafeBrandColor(s.brandColor),
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
  /** Which provider NEW uploads go to. Never decides where an EXISTING asset lives. */
  storageProvider: "cloudinary" | "spaces";
  spacesEndpoint: string;
  spacesRegion: string;
  spacesBucket: string;
  /** Public by design, exactly like `cloudinaryApiKey`. */
  spacesAccessKeyId: string;
  spacesCdnUrl: string;
  /** Whether a secret is stored — NEVER the secret. Same convention as cloudinaryApiSecretSet. */
  spacesSecretKeySet: boolean;
  spacesConfigured: boolean;
  employeeIdPrefix: string;
  stockCodePrefix: string;
  irmCodePrefix: string;
  rentalCodePrefix: string;
  // PO document branding — the STORED overrides, "" when unset (the PO PDF then uses the app logo /
  // brand colour above; the Settings screen shows that fallback itself).
  poDocLogoUrl: string;
  poDocAccentColor: string;
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
  /** Global email 2FA. Off by default; suppresses Google sign-in while on. */
  emailTwoFactorEnabled: boolean;
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

    // ── Storage provider ──────────────────────────────────────────────────────────────────────
    // Null reads as "cloudinary" here exactly as it does everywhere else, so a fresh install shows
    // the provider it is actually using rather than an empty control.
    storageProvider: s.storageProvider === "spaces" ? "spaces" : "cloudinary",
    spacesEndpoint: s.spacesEndpoint || "",
    spacesRegion: s.spacesRegion || "",
    spacesBucket: s.spacesBucket || "",
    spacesAccessKeyId: s.spacesAccessKeyId || "",
    spacesCdnUrl: s.spacesCdnUrl || "",
    // The SECRET ITSELF NEVER CROSSES. Only whether one is stored, so the form can say "saved —
    // leave blank to keep" rather than round-tripping a credential through a browser.
    spacesSecretKeySet: Boolean(s.spacesSecretKey),
    spacesConfigured: resolveSpacesConfig(s) !== null,

    // Staff-ID prefix (effective value, default-filled).
    employeeIdPrefix: normalizeEmployeeIdPrefix(s.employeeIdPrefix),

    // Stock-entry barcode prefix (effective value, default-filled).
    stockCodePrefix: normalizeStockCodePrefix(s.stockCodePrefix),

    // IRM item-code prefix (effective value, default-filled).
    irmCodePrefix: normalizeIrmCodePrefix(s.irmCodePrefix),

    // Rental item-code prefix (effective value, default-filled).
    rentalCodePrefix: normalizeRentalCodePrefix(s.rentalCodePrefix),

    // PO document branding overrides (raw; "" when unset).
    poDocLogoUrl: s.poDocLogoUrl || "",
    poDocAccentColor: s.poDocAccentColor || "",

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

    // Security / authentication
    emailTwoFactorEnabled: s.emailTwoFactorEnabled ?? false,
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
  storageProvider?: "cloudinary" | "spaces";
  spacesEndpoint?: string;
  spacesRegion?: string;
  spacesBucket?: string;
  spacesAccessKeyId?: string;
  spacesSecretKey?: string;
  spacesCdnUrl?: string;
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
  // PO document branding. The logo can only be CLEARED here ("") — it is set by the upload.
  poDocLogoUrl?: string;
  poDocAccentColor?: string;
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
  emailTwoFactorEnabled?: boolean;
  // Goods management: the overdue window, in days. `""` clears it back to the read-time default.
  overdueAfterDays?: number | "";
}

export async function updateSettings(
  input: UpdateSettingsParams,
  actor?: AuditActor,
): Promise<PublicSettings> {
  const s = await settingsRepo.getOrCreate();
  const data: Prisma.SettingsUpdateInput = {};
  // Null reads as Cloudinary, so a fresh install comparing against "cloudinary" sees no change.
  const currentProvider = s.storageProvider === "spaces" ? "spaces" : "cloudinary";

  // --- Security / authentication ---
  // There is deliberately no "customers without a password" guard here. Google sign-in stays
  // available while 2FA is on (and is itself subject to it), so an account that signs in with
  // Google keeps working and simply receives the code — nobody is locked out by enabling this.
  //
  // The SMTP lockout guard lives BELOW, after the SMTP fields are computed: it has to judge the
  // configuration this save LEAVES BEHIND, not the one it started with.
  if (typeof input.emailTwoFactorEnabled === "boolean") {
    data.emailTwoFactorEnabled = input.emailTwoFactorEnabled;
  }

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

  /**
   * THE LOCKOUT GUARD. With 2FA on and SMTP broken, nobody can complete a login — including the
   * administrator who would need to turn 2FA back off. Recovery is editing the database by hand.
   *
   * It deliberately judges the state this save LEAVES BEHIND, which closes both doors with one
   * rule: turning 2FA on while SMTP is incomplete, AND clearing SMTP while 2FA is already on. An
   * enable-time-only check caught the first and missed the second entirely.
   *
   * `undefined` means the field was not sent, so the stored value survives; an explicit `null` means
   * CLEARED, which is exactly what this guard exists to catch — `??` would treat the two the same
   * and let a clear through.
   */
  const leftBehind = <T,>(next: T | null | undefined, saved: T | null): T | null =>
    next === undefined ? saved : next;

  // Disabling always wins: `false` short-circuits before the stored value is consulted, so a broken
  // mail server can never trap the company behind a factor nobody can receive.
  const twoFactorAfterSave = input.emailTwoFactorEnabled ?? s.emailTwoFactorEnabled;
  if (twoFactorAfterSave) {
    // The same completeness test sendConfiguredEmail applies, so the two can never disagree.
    const smtpComplete =
      leftBehind(data.smtpHost as string | null | undefined, s.smtpHost) &&
      leftBehind(data.smtpPort as number | null | undefined, s.smtpPort) &&
      leftBehind(data.smtpFromEmail as string | null | undefined, s.smtpFromEmail) &&
      leftBehind(data.smtpPassword as string | null | undefined, s.smtpPassword);

    if (!smtpComplete) {
      throw badRequest(
        s.emailTwoFactorEnabled
          ? "Two-factor authentication is on, so a working SMTP configuration is required — without it nobody could receive a sign-in code. Complete the SMTP host, port, from-address and password, or turn two-factor authentication off first."
          : "Configure SMTP under Settings → Email before turning on two-factor authentication. Without it, nobody would be able to receive a sign-in code.",
      );
    }
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

  // --- DigitalOcean Spaces (config plaintext; secret encrypted, blank-to-keep) ---
  if (typeof input.spacesEndpoint === "string") data.spacesEndpoint = input.spacesEndpoint.trim() || null;
  if (typeof input.spacesRegion === "string") data.spacesRegion = input.spacesRegion.trim() || null;
  if (typeof input.spacesBucket === "string") data.spacesBucket = input.spacesBucket.trim() || null;
  if (typeof input.spacesAccessKeyId === "string") data.spacesAccessKeyId = input.spacesAccessKeyId.trim() || null;
  if (typeof input.spacesCdnUrl === "string") data.spacesCdnUrl = input.spacesCdnUrl.trim() || null;
  // Same blank-to-keep rule as every other secret here: an empty field means "leave the stored one".
  if (typeof input.spacesSecretKey === "string" && input.spacesSecretKey.trim()) {
    data.spacesSecretKey = encryptSecret(input.spacesSecretKey.trim());
  }

  /**
   * THE SWITCH GUARD.
   *
   * Selecting a provider is not a preference — it decides where every future file goes. Saving it
   * and finding out later is the failure this prevents: uploads would start failing for everyone,
   * with the only clue being an error on a form nobody is looking at.
   *
   * It judges the configuration this save LEAVES BEHIND, not the one currently stored, because the
   * two differ exactly when it matters: an administrator pastes new credentials AND flips the
   * provider in one save, so the values to verify are the submitted ones.
   *
   * Switching TO Cloudinary needs no equivalent gate, and that asymmetry is deliberate rather than
   * an omission: Cloudinary is the default every install already runs on, and refusing to return to
   * it would be a trap — the one direction that must always stay open is back.
   */
  if (input.storageProvider && input.storageProvider !== currentProvider) {
    if (input.storageProvider === "spaces") {
      const next = await resolveSpacesTestConfig({
        spacesEndpoint: input.spacesEndpoint,
        spacesRegion: input.spacesRegion,
        spacesBucket: input.spacesBucket,
        spacesAccessKeyId: input.spacesAccessKeyId,
        spacesSecretKey: input.spacesSecretKey,
        spacesCdnUrl: input.spacesCdnUrl,
      });
      if (!next) {
        throw badRequest(
          "Complete the DigitalOcean Spaces endpoint, region, bucket, access key and secret key before selecting it.",
        );
      }
      if (!isVerified(next)) {
        throw badRequest(
          "Test the DigitalOcean Spaces connection before making it the active storage provider.",
        );
      }
    }
    data.storageProvider = input.storageProvider;
  }

  // --- Branding (empty string clears the field back to its default) ---
  if (typeof input.brandName === "string") data.brandName = input.brandName.trim() || null;
  // Only persist a well-formed hex; an empty string clears it back to the default.
  if (typeof input.brandColor === "string") {
    const c = input.brandColor.trim();
    data.brandColor = c ? safeBrandColor(c) : null;
  }
  // A derivative describes ONE source image, so it cannot outlive a write to that source. This path
  // never GENERATES one — only the branding upload does — so whatever it writes here, cleared or
  // replaced, leaves the stored variants describing an image that is no longer set. And they are not
  // merely stale: every renderer PREFERS the derivative, so a logo removed on this screen would keep
  // being printed on supplier-facing purchase orders until something overwrote it.
  if (typeof input.logoUrl === "string") {
    data.logoUrl = input.logoUrl.trim() || null;
    data.logoPdfUrl = null;
    data.logoEmailUrl = null;
  }
  if (typeof input.faviconUrl === "string") data.faviconUrl = input.faviconUrl.trim() || null;
  // A rename posts the new brand name together with the footer the form rendered under the old one,
  // so both names count as "default" here; a brand-only rename likewise releases a footer frozen
  // under the old name. A custom footer passes through unchanged either way.
  if (typeof input.footerText === "string" || typeof input.brandName === "string") {
    const previousBrand = resolveBrandName(s.brandName);
    const nextBrand =
      typeof input.brandName === "string" ? resolveBrandName(input.brandName) : previousBrand;
    const footer = typeof input.footerText === "string" ? input.footerText : (s.footerText ?? "");
    data.footerText = storedFooterText(footer, [previousBrand, nextBrand]);
  }
  // The form echoes the default back on every save; storing it would freeze it (branding.defaults.ts).
  if (typeof input.loginHeadline === "string") {
    data.loginHeadline = storedLoginHeadline(input.loginHeadline);
  }
  if (typeof input.loginSubtext === "string") {
    data.loginSubtext = storedLoginSubtext(input.loginSubtext);
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

  // --- PO document branding (the PO PDF only). Empty clears back to the app branding. The logo is only
  // ever cleared here (validation accepts "" alone); a colour is stored only when pdfkit can draw it.
  // Same rule, its own pair: the PO logo's derivative goes with the PO logo and nothing else.
  if (typeof input.poDocLogoUrl === "string") {
    data.poDocLogoUrl = input.poDocLogoUrl.trim() || null;
    data.poDocLogoPdfUrl = null;
  }
  if (typeof input.poDocAccentColor === "string") {
    const c = input.poDocAccentColor.trim();
    data.poDocAccentColor = c && PO_ACCENT_COLOR_RE.test(c) ? c : null;
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

  // Ordinary settings edits are not audited in this app, but a change to the SIGN-IN POLICY is the
  // archetypal audit target — it changes how every account authenticates.
  if (
    typeof input.emailTwoFactorEnabled === "boolean" &&
    input.emailTwoFactorEnabled !== s.emailTwoFactorEnabled
  ) {
    auditService.record({
      actor,
      action: input.emailTwoFactorEnabled ? "settings.2fa_enabled" : "settings.2fa_disabled",
      targetType: "settings",
    });
  }

  // Where every future file goes is the same class of change as how every account signs in, so it is
  // recorded the same way. The payload names the two providers and NOTHING else — no endpoint, no
  // bucket, and above all no credential.
  if (data.storageProvider && data.storageProvider !== currentProvider) {
    auditService.record({
      actor,
      action: "settings.storage_provider_changed",
      targetType: "settings",
      metadata: { from: currentProvider, to: data.storageProvider as string },
    });
  }

  return publicSettings(updated);
}

// Upload a logo/favicon image to Cloudinary and save its URL on the settings row. "po_logo" is the
// PURCHASE ORDER document's own logo: it lands on `poDocLogoUrl` and changes nothing about the app's
// branding.
export async function uploadBrandingImage(
  type: "logo" | "favicon" | "po_logo",
  image: string,
): Promise<{ url: string; settings: PublicSettings }> {
  const s = await settingsRepo.getOrCreate();
  const storage = await findActiveStorage();
  if (!storage) {
    throw badRequest(
      "File storage isn't configured. Set up a storage provider in Settings → Storage (or set that provider's credentials in the backend env).",
    );
  }
  // Deterministic public id (`logo` / `favicon`) with overwrite — a replacement lands on the same
  // asset, so there is never an older file to clean up and no identity worth storing. `immutable:
  // false` says exactly that, for a provider that has to pick a cache header at write time.
  const { url } = await storage.upload(image, type === "po_logo" ? "po-logo" : type, {
    folder: "senthra/branding",
    kind: "image",
    immutable: false,
  });
  // WHICH RENDERERS USE THIS IMAGE decides what has to be generated, and the answer differs per
  // type: the app logo is printed on PDFs AND sent in email headers; the PO logo only ever reaches
  // the purchase-order PDF; the favicon reaches neither — it is a browser-only asset, so generating
  // anything for it would be storing a file nothing will ever read.
  //
  // Skipped entirely when the provider transforms at delivery, which is the Cloudinary path and
  // stays exactly as it was: no extra work, no stored object, and a null derivative column that the
  // renderers read as "use the delivery transform".
  const intents: DerivativeIntent[] =
    type === "logo" ? ["pdf", "email"] : type === "po_logo" ? ["pdf"] : [];
  //
  // DEGRADED, NEVER FAILED. The original is already stored by the time anything here can throw, so
  // a rejection would report failure for an upload that succeeded — and `sharp` is a native binary
  // that throws on IMPORT when its prebuilt artifact does not match the host, which would make
  // branding permanently unusable on that machine. A null derivative is a render that falls back to
  // the original; a thrown error is a screen that never works. The failure is logged, not hidden.
  //
  // Scoped to the generation call ALONE: a failure to store the original, or to persist the row
  // below, is a real failure and must keep surfacing as one.
  let derivatives: Partial<Record<DerivativeIntent, string>> = {};
  if (!storage.transformsOnDelivery && intents.length > 0) {
    try {
      derivatives = await generateDerivatives(image, type === "po_logo" ? "po-logo" : type, "senthra/branding", intents, storage);
    } catch (e) {
      console.error(`[branding] could not generate ${type} derivatives:`, e instanceof Error ? e.message : e);
    }
  }

  const data: Prisma.SettingsUpdateInput =
    type === "logo"
      ? { logoUrl: url, logoPdfUrl: derivatives.pdf ?? null, logoEmailUrl: derivatives.email ?? null }
      : type === "favicon"
        ? { faviconUrl: url }
        : { poDocLogoUrl: url, poDocLogoPdfUrl: derivatives.pdf ?? null };
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
