import { z } from "zod";

import { postcodeField as ukPostcode } from "../../utils/postcode.js";
import { MAX_OVERDUE_AFTER_DAYS, MIN_OVERDUE_AFTER_DAYS, PO_ACCENT_COLOR_RE } from "./settings.service.js";

// A network port is empty (clear it), or an integer 1–65535. Accepts the value
// as a string (from a form input) or a number. Used by both the settings patch
// and the test-email payload.
const portSchema = z
  .union([z.string(), z.number()])
  .optional()
  .refine(
    (v) =>
      v === undefined ||
      v === "" ||
      (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 65535),
    "Port must be a whole number between 1 and 65535.",
  );

// All fields optional — the settings update is a partial patch. Unknown keys are
// stripped by default. Business rules (e.g. required SMTP fields for a test send)
// live in the service, since they depend on merged saved + override values.
/**
 * A URL field that may also be cleared.
 *
 * Both storage URLs reach the network: the endpoint is where the SDK signs its requests, and the CDN
 * origin is BAKED INTO every delivery URL this app then stores on attachment, avatar and signature
 * rows. A typo in the second one is therefore not a settings mistake that can be corrected later by
 * retyping it — the bad origin is already persisted in every row written since, and undoing that is
 * a data migration. `.url()` is the cheapest possible place to stop it, and it is the same shape
 * `websiteUrl` below already uses.
 *
 * The scheme is pinned too: `z.string().url()` accepts `ftp://` and `javascript:` quite happily, and
 * neither belongs on a value the server is about to fetch.
 */
const httpUrl = (message: string) =>
  z.union([
    z.literal(""),
    z
      .string()
      .url(message)
      .refine((v) => /^https?:\/\//i.test(v), message)
      .refine((v) => v.length <= 2048, "That URL is too long."),
  ]);

export const updateSettingsSchema = z.object({
  googleEnabled: z.boolean().optional(),
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  smtpEnabled: z.boolean().optional(),
  smtpHost: z.string().optional(),
  smtpPort: portSchema,
  smtpSecure: z.boolean().optional(),
  smtpUsername: z.string().optional(),
  smtpFromName: z.string().optional(),
  smtpFromEmail: z.string().optional(),
  smtpPassword: z.string().optional(),
  // Cloudinary (image CDN) credentials — UI-configurable.
  cloudinaryCloudName: z.string().optional(),
  cloudinaryApiKey: z.string().optional(),
  cloudinaryApiSecret: z.string().optional(),
  // Which provider NEW uploads go to. An enum, not a free string: an unrecognised value would fall
  // back to Cloudinary at read time and look like the save silently did nothing.
  storageProvider: z.enum(["cloudinary", "spaces"]).optional(),
  // DigitalOcean Spaces — UI-configurable. The secret follows the blank-to-keep rule every other
  // secret here uses, so the form never has to hold one to save the rest.
  spacesEndpoint: httpUrl("Enter a valid Spaces endpoint URL (including https://).").optional(),
  spacesRegion: z.string().optional(),
  spacesBucket: z.string().optional(),
  spacesAccessKeyId: z.string().optional(),
  spacesSecretKey: z.string().optional(),
  spacesCdnUrl: httpUrl("Enter a valid CDN URL (including https://).").optional(),
  // Branding (all public). Logo/favicon are normally set via the upload endpoint,
  // but accepting the URL here lets the UI clear them (send "").
  brandName: z.string().max(60).optional(),
  // Brand accent — a hex color used across the app and in emails. Empty clears it
  // back to the default.
  brandColor: z
    .string()
    .trim()
    // Only valid CSS hex lengths (3, 4, 6 or 8 digits). The previous {3,8} range
    // accepted 5/7-digit values that aren't valid colors and silently break the
    // `--accent` custom property across the dashboard.
    .regex(
      /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
      "Brand color must be a hex value like #7b6ef0.",
    )
    .or(z.literal(""))
    .optional(),
  logoUrl: z.string().optional(),
  faviconUrl: z.string().optional(),
  footerText: z.string().max(200).optional(),
  loginHeadline: z.string().max(120).optional(),
  loginSubtext: z.string().max(200).optional(),
  // Staff-ID prefix: 2–5 letters (case-insensitive; the service uppercases it).
  // Empty string clears it back to the default. Not tied to brandName.
  employeeIdPrefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,5}$/, "Employee ID prefix must be 2–5 letters.")
    .or(z.literal(""))
    .optional(),
  // Customer stock-entry barcode prefix: 2–5 letters (case-insensitive; the service
  // uppercases it). Empty string clears it back to the default.
  stockCodePrefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,5}$/, "Stock code prefix must be 2–5 letters.")
    .or(z.literal(""))
    .optional(),
  // IRM item-code prefix: 2–5 letters (case-insensitive; the service uppercases it).
  // Empty string clears it back to the default.
  irmCodePrefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,5}$/, "IRM code prefix must be 2–5 letters.")
    .or(z.literal(""))
    .optional(),
  // Rental item-code prefix: 2–5 letters (case-insensitive; the service uppercases it).
  // Empty string clears it back to the default.
  rentalCodePrefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,5}$/, "Rental code prefix must be 2–5 letters.")
    .or(z.literal(""))
    .optional(),

  // --- PO document branding (the PO PDF only; see getPurchaseOrderDocumentBranding) ---
  // #RGB or #RRGGBB only: pdfkit mis-reads the alpha forms the app's brandColor accepts, so an 8-digit
  // colour would print as the wrong colour on the supplier's document. Empty clears it → app colour.
  poDocAccentColor: z
    .string()
    .trim()
    .regex(PO_ACCENT_COLOR_RE, "PO accent colour must be a hex value like #1f3a8a.")
    .or(z.literal(""))
    .optional(),
  // CLEAR ONLY. The PO logo is set by the branding upload (type "po_logo"), never typed in — the server
  // fetches this image on every PO render, so it must only ever point at an asset we uploaded.
  poDocLogoUrl: z.literal("", { error: "Upload the PO logo instead of entering a URL." }).optional(),

  // --- Company profile (legal identity for official documents). All optional;
  // empty string clears the field back to null (default applied on read). ---
  companyLegalName: z.string().max(200).optional(),
  companyRegNumber: z.string().max(40).optional(),
  vatNumber: z.string().max(40).optional(),
  companyAddressLine1: z.string().max(200).optional(),
  companyAddressLine2: z.string().max(200).optional(),
  companyCity: z.string().max(100).optional(),
  companyCounty: z.string().max(100).optional(),
  // Validates AND normalises to canonical form ("ls14dy" → "LS1 4DY") — see utils/postcode.ts.
  companyPostcode: ukPostcode().optional(),
  companyCountry: z.string().max(80).optional(),
  companyPhone: z.string().max(40).optional(),
  // Empty string allowed (clears it); a non-empty value must be a valid email / URL.
  companyEmail: z.union([z.literal(""), z.string().email("Enter a valid company email address.")]).optional(),
  websiteUrl: z.union([z.literal(""), z.string().url("Enter a valid website URL (including https://).")]).optional(),

  // --- Regional formatting. Empty clears back to the default applied on read. ---
  // Controlled set (UK-based app); mirrors the frontend dropdown. Extend BOTH sides
  // together for future expansion. Empty clears to null → default "Europe/London" on read.
  timezone: z.enum(["Europe/London", "Europe/Dublin", "UTC", "Europe/Paris", "Europe/Berlin"]).or(z.literal("")).optional(),
  dateFormat: z.enum(["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]).or(z.literal("")).optional(),
  timeFormat: z.enum(["24h", "12h"]).or(z.literal("")).optional(),

  // --- Engineer transfer feature flags ---
  engineerTransferRequireSignature: z.boolean().optional(),
  // --- Security / authentication ---
  emailTwoFactorEnabled: z.boolean().optional(),
  // Whole days. Coerced because a number input posts a string. Bounded so a slip like "3650" can't
  // turn the overdue list into every job the business has ever run. `""` clears it back to the
  // read-time default, the same escape hatch every other nullable setting here offers — without it,
  // "" coerces to 0 and gets rejected by the minimum, so the field could never be un-set.
  overdueAfterDays: z.coerce
    .number({ error: "Enter the number of days." })
    .int("Use a whole number of days.")
    .min(MIN_OVERDUE_AFTER_DAYS, `Must be at least ${MIN_OVERDUE_AFTER_DAYS} day.`)
    .max(MAX_OVERDUE_AFTER_DAYS, `Must be ${MAX_OVERDUE_AFTER_DAYS} days or fewer.`)
    .or(z.literal(""))
    .optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

// Logo / favicon upload — the image arrives as a base64 data URI and is streamed
// to Cloudinary; only the resulting URL is stored. We bound the size and restrict
// the MIME type so an authenticated caller can't push an arbitrary/oversized blob
// to the (paid) CDN. base64 inflates bytes by ~33%, so ~3 MB of characters caps
// the binary at roughly 2.2 MB — comfortably above the 2 MB the UI allows.
const MAX_IMAGE_DATA_URI_CHARS = 3 * 1024 * 1024;
export const uploadBrandingSchema = z.object({
  // "po_logo" = the PURCHASE ORDER document's own logo (Settings → Purchase Orders), not the app's.
  type: z.enum(["logo", "favicon", "po_logo"]),
  image: z
    .string()
    .max(MAX_IMAGE_DATA_URI_CHARS, "Image is too large (max ~2 MB).")
    .regex(
      /^data:image\/(png|jpe?g|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,/i,
      "Image must be a base64 data URI of a supported type (PNG, JPG, GIF, WEBP, SVG or ICO).",
    ),
});
export type UploadBrandingInput = z.infer<typeof uploadBrandingSchema>;

export const testEmailSchema = z.object({
  // Empty string is allowed so the service can return its friendly
  // "recipient required" message; a non-empty value must be a valid email.
  to: z.union([z.literal(""), z.string().email("Enter a valid email address.")]).optional(),
  smtpHost: z.string().optional(),
  smtpPort: portSchema,
  smtpSecure: z.boolean().optional(),
  smtpUsername: z.string().optional(),
  smtpPassword: z.string().optional(),
  smtpFromName: z.string().optional(),
  smtpFromEmail: z.string().optional(),
});
export type TestEmailInput = z.infer<typeof testEmailSchema>;

/**
 * What a storage connection test carries.
 *
 * THE VALUES CURRENTLY ON SCREEN, which may not be saved. Testing the stored row while the form
 * holds unsaved edits would confirm a configuration nobody is about to use. Every field is optional
 * and falls back to what is stored — which is also how a blank secret means "keep the saved one".
 */
export const testStorageSchema = z.object({
  provider: z.enum(["cloudinary", "spaces"]),
  // Cloudinary's own fields, for the same reason the Spaces ones are here: the test judges what is
  // ON SCREEN. Without these it would confirm the stored credentials while the form held new ones.
  cloudinaryCloudName: z.string().optional(),
  cloudinaryApiKey: z.string().optional(),
  cloudinaryApiSecret: z.string().optional(),
  spacesEndpoint: httpUrl("Enter a valid Spaces endpoint URL (including https://).").optional(),
  spacesRegion: z.string().optional(),
  spacesBucket: z.string().optional(),
  spacesAccessKeyId: z.string().optional(),
  spacesSecretKey: z.string().optional(),
  spacesCdnUrl: httpUrl("Enter a valid CDN URL (including https://).").optional(),
});
export type TestStorageInput = z.infer<typeof testStorageSchema>;
