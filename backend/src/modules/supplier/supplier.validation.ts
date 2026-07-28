import { z } from "zod";

import { EMAIL_RE, optionalPhoneField } from "../../utils/validation.js";
import { postcodeField as ukPostcode } from "../../utils/postcode.js";

// Supplier master-data validation. Code is auto-allocated (SUP-0001). Type references the
// SupplierType master (typeId). No geolocation — suppliers aren't geocoded.
//
// REQUIRED on create: name, typeId, addressLine1, city, postcode, country. On UPDATE these
// stay optional (partial PATCH — e.g. a status toggle), but when sent they must be
// non-empty, so a required field can never be blanked once set.

const statusEnum = z.enum(["active", "inactive"]);
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
// Lenient website check: empty, a bare domain, or a full URL (http/https).
const WEBSITE_RE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i;

// UK-only operational scope (consistent with the Warehouse module + UK postcode
// validation). Free-text country is never accepted — the form constrains to this list.
export const COUNTRY_OPTIONS = ["United Kingdom"] as const;
export const CURRENCY_OPTIONS = ["GBP", "EUR"] as const;
export const PAYMENT_TERMS_OPTIONS = [
  "Prepaid",
  "7 Days",
  "14 Days",
  "30 Days",
  "45 Days",
  "60 Days",
  "90 Days",
  "Custom",
] as const;

// Blank string from a cleared <input>/<select> → undefined, so it doesn't trip an
// enum / format check downstream.
const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

// Optional email — blank allowed (clears on update); a non-blank value must be valid.
const contactEmailField = z
  .string()
  .trim()
  .max(160)
  .refine((v) => v === "" || EMAIL_RE.test(v), "Enter a valid email.")
  .optional();

// Optional website — blank allowed; a non-blank value must look like a URL/domain.
const websiteField = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v === "" || WEBSITE_RE.test(v), "Enter a valid website (e.g. example.com).")
  .optional();

// A reference to a staff user (the internal owner), validated against the active user list
// in the service. Three states: omitted (no change), null / "" (clear it), or a valid id.
const ownerIdField = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().regex(OBJECT_ID_RE, "Select a valid owner.").nullable().optional(),
);

const currencyField = z.preprocess(emptyToUndef, z.enum(CURRENCY_OPTIONS).optional());
// 3-state (like ownerUserId): omitted = no change, "" / null = clear it, a valid term = set.
// Sending "" from the edit form clears an existing payment term instead of being ignored.
const paymentTermsField = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.enum(PAYMENT_TERMS_OPTIONS).nullable().optional(),
);

// Lead time in days — optional whole number 0–365. Blank → null (so it can be cleared);
// absent → undefined (no change on update).
const leadTimeField = z.preprocess(
  (v) => (v === "" || v === null ? null : v),
  z.coerce
    .number()
    .int("Use a whole number.")
    .min(0, "Lead time can't be negative.")
    .max(365, "Lead time can't exceed 365 days.")
    .nullable()
    .optional(),
);

// typeId for UPDATE (optional — only changes when provided). Create requires it (below).
const optionalTypeIdField = z.preprocess(
  emptyToUndef,
  z.string().regex(OBJECT_ID_RE, "Select a valid supplier type.").optional(),
);

// --- required fields: CREATE (mandatory) vs UPDATE (optional, non-empty when sent) ---
const addressLine1Create = z
  .string({ error: "Address line 1 is required." })
  .trim()
  .min(1, "Address line 1 is required.")
  .max(150);
const addressLine1Update = z
  .string()
  .trim()
  .min(1, "Address line 1 can't be empty.")
  .max(150)
  .optional();

const cityCreate = z.string({ error: "City is required." }).trim().min(1, "City is required.").max(80);
const cityUpdate = z.string().trim().min(1, "City can't be empty.").max(80).optional();

// Validates AND normalises to canonical form ("ls14dy" → "LS1 4DY") — see utils/postcode.ts.
const postcodeCreate = ukPostcode({ required: true });
const postcodeUpdate = ukPostcode({ required: true }).optional();

const countryCreate = z.enum(COUNTRY_OPTIONS, { error: "Country is required." });
const countryUpdate = z.preprocess(emptyToUndef, z.enum(COUNTRY_OPTIONS).optional());

// Shared fields. The required ones (addressLine1/city/postcode/country/typeId) are
// optional HERE (so partial updates work) but non-empty when present; create overrides
// each to fully required below.
const sharedSupplierFields = {
  legalName: z.string().trim().max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  typeId: optionalTypeIdField,
  // Contact (all optional).
  contactPerson: z.string().trim().max(120).optional(),
  contactJobTitle: z.string().trim().max(80).optional(),
  contactEmail: contactEmailField,
  contactPhone: optionalPhoneField,
  // Business (all optional).
  companyRegistrationNumber: z.string().trim().max(50).optional(),
  vatNumber: z.string().trim().max(50).optional(),
  website: websiteField,
  // Address.
  addressLine1: addressLine1Update,
  addressLine2: z.string().trim().max(120).optional(),
  city: cityUpdate,
  county: z.string().trim().max(80).optional(),
  postcode: postcodeUpdate,
  country: countryUpdate,
  // Payment.
  paymentTerms: paymentTermsField,
  customPaymentTerms: z.string().trim().max(100).optional(),
  currency: currencyField,
  // Operational.
  leadTimeDays: leadTimeField,
  notes: z.string().trim().max(2000).optional(),
  ownerUserId: ownerIdField,
  status: statusEnum.optional(),
};

// "Custom" payment terms require the free-text value alongside it. On update this only
// fires when paymentTerms="Custom" is sent without text; the service re-checks against the
// existing record for partial patches.
const customTermsRefine = (d: { paymentTerms?: string | null; customPaymentTerms?: string | null }) =>
  d.paymentTerms !== "Custom" || Boolean(d.customPaymentTerms && d.customPaymentTerms.trim());
const customTermsError = {
  message: "Enter the custom payment terms.",
  path: ["customPaymentTerms"] as string[],
};

export const createSupplierSchema = z
  .object({
    name: z
      .string({ error: "Supplier name is required." })
      .trim()
      .min(1, "Supplier name is required.")
      .max(150),
    ...sharedSupplierFields,
    // Mandatory on create (override the optional shared versions). The form preselects an
    // active type and defaults Country to United Kingdom.
    typeId: z
      .string({ error: "Select a supplier type." })
      .regex(OBJECT_ID_RE, "Select a supplier type."),
    addressLine1: addressLine1Create,
    city: cityCreate,
    postcode: postcodeCreate,
    country: countryCreate,
  })
  .refine(customTermsRefine, customTermsError);
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = z
  .object({
    name: z.string().trim().min(1, "Supplier name can't be empty.").max(150).optional(),
    ...sharedSupplierFields,
  })
  .refine(customTermsRefine, customTermsError);
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
