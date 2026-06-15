import { z } from "zod";

import { EMAIL_RE, optionalPhoneField } from "../../utils/validation.js";

// Warehouse master-data validation. Geolocation is NOT accepted from the client — the
// service derives latitude/longitude from the postcode (postcodes.io). Code is
// auto-allocated (WH-0001). Type is a reference to the WarehouseType master (typeId).
//
// REQUIRED on create: name, typeId, addressLine1, city, postcode, country. On UPDATE
// these stay optional (partial PATCH — e.g. a status toggle), but when sent they must
// be non-empty, so a required field can never be blanked once set.

const statusEnum = z.enum(["active", "inactive"]);
const UK_POSTCODE_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// UK-only inventory system → a single-country allow-list. UK postcode validation +
// postcodes.io geocoding are UK-specific, so other countries aren't supported here.
export const COUNTRY_OPTIONS = ["United Kingdom"] as const;
// A small curated timezone list (default Europe/London) — deliberately NOT the full
// IANA set; expand later if real multi-region operations need it.
export const TIMEZONE_OPTIONS = ["Europe/London", "Europe/Dublin", "UTC"] as const;

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

// A reference to a staff user (the manager), validated against the active user list in
// the service. Three states: omitted (no change), null / "" (clear it), or a valid id.
const managerIdField = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().regex(OBJECT_ID_RE, "Select a valid manager.").nullable().optional(),
);

const timezoneField = z.preprocess(emptyToUndef, z.enum(TIMEZONE_OPTIONS).optional());
// typeId for UPDATE (optional — only changes when provided). Create requires it (below).
const optionalTypeIdField = z.preprocess(
  emptyToUndef,
  z.string().regex(OBJECT_ID_RE, "Select a valid warehouse type.").optional(),
);

// --- required fields: CREATE (mandatory) vs UPDATE (optional, non-empty when sent) ---
const addressLine1Create = z
  .string({ error: "Address line 1 is required." })
  .trim()
  .min(1, "Address line 1 is required.")
  .max(150);
const addressLine1Update = z.string().trim().min(1, "Address line 1 can't be empty.").max(150).optional();

const cityCreate = z.string({ error: "City is required." }).trim().min(1, "City is required.").max(80);
const cityUpdate = z.string().trim().min(1, "City can't be empty.").max(80).optional();

const postcodeCreate = z
  .string({ error: "Postcode is required." })
  .trim()
  .min(1, "Postcode is required.")
  .max(12)
  .refine((v) => UK_POSTCODE_RE.test(v), "Enter a valid UK postcode (e.g. EC1A 1BB).");
const postcodeUpdate = z
  .string()
  .trim()
  .min(1, "Postcode is required.")
  .max(12)
  .refine((v) => UK_POSTCODE_RE.test(v), "Enter a valid UK postcode (e.g. EC1A 1BB).")
  .optional();

const countryCreate = z.enum(COUNTRY_OPTIONS, { error: "Country is required." });
const countryUpdate = z.preprocess(emptyToUndef, z.enum(COUNTRY_OPTIONS).optional());

// Shared fields. The required ones (addressLine1/city/postcode/country/typeId) are
// optional HERE (so partial updates work) but non-empty when present; create overrides
// each to fully required below.
const sharedWarehouseFields = {
  description: z.string().trim().max(2000).optional(),
  typeId: optionalTypeIdField,
  isDefault: z.boolean().optional(),
  addressLine1: addressLine1Update,
  addressLine2: z.string().trim().max(120).optional(),
  city: cityUpdate,
  county: z.string().trim().max(80).optional(),
  postcode: postcodeUpdate,
  country: countryUpdate,
  contactPerson: z.string().trim().max(120).optional(),
  contactEmail: contactEmailField,
  contactPhone: optionalPhoneField,
  // Operational metadata (display-only).
  operatingHours: z.string().trim().max(200).optional(),
  timezone: timezoneField,
  notes: z.string().trim().max(2000).optional(),
  managerUserId: managerIdField,
  status: statusEnum.optional(),
};

export const createWarehouseSchema = z.object({
  name: z
    .string({ error: "Warehouse name is required." })
    .trim()
    .min(1, "Warehouse name is required.")
    .max(120),
  ...sharedWarehouseFields,
  // Mandatory on create (override the optional shared versions). The form preselects an
  // active type and defaults Country to United Kingdom.
  typeId: z
    .string({ error: "Select a warehouse type." })
    .regex(OBJECT_ID_RE, "Select a warehouse type."),
  addressLine1: addressLine1Create,
  city: cityCreate,
  postcode: postcodeCreate,
  country: countryCreate,
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

export const updateWarehouseSchema = z.object({
  name: z.string().trim().min(1, "Warehouse name can't be empty.").max(120).optional(),
  ...sharedWarehouseFields,
});
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;
