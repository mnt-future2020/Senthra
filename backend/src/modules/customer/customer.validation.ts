import { z } from "zod";

import { emailField, optionalPhoneField as phoneField } from "../../utils/validation.js";

const statusEnum = z.enum(["active", "inactive"]);

// Lenient website check: empty, a bare domain, or a full URL (http/https).
const WEBSITE_RE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i;
// Standard UK postcode shape, e.g. "EC1A 1BB", "M1 1AE".
const UK_POSTCODE_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/;

// A currency SYMBOL never belongs in a customer-visible catalogue field — the
// catalogue is deliberately price-free. This guard is intentionally narrow (just
// the symbols): the old broad money-word list was dropped because it false-flagged
// legitimate telecom text such as the spec's own "High Value Item".
const CURRENCY_RE = /[£$€]/;
const NO_CURRENCY_MSG = "Remove the currency symbol — the catalogue isn't priced.";

// Required, trimmed, length-bounded text that also rejects a stray currency symbol —
// used for each customer-visible catalogue column.
const catalogueText = (max: number, label: string) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max)
    .refine((v) => !CURRENCY_RE.test(v), NO_CURRENCY_MSG);

// An empty/blank string from an unselected <select> or cleared <input> becomes
// `undefined`, so it doesn't trip an enum / format / number check downstream.
const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const websiteField = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v === "" || WEBSITE_RE.test(v), "Enter a valid website (e.g. example.com).")
  .optional();

const postcodeField = z
  .string()
  .trim()
  .max(12)
  .refine((v) => v === "" || UK_POSTCODE_RE.test(v), "Enter a valid UK postcode (e.g. EC1A 1BB).")
  .optional();

// Units of measure (UK telecom field-services stock). Kept in lockstep with the
// frontend CatalogueItemModal list.
export const UOM_OPTIONS = ["Each", "Metre", "Roll", "Pack", "Box", "Set", "Pair", "Reel"] as const;
const uomField = z.preprocess(emptyToUndef, z.enum(UOM_OPTIONS).optional());

// ISO date (from <input type="date">) or empty. Validated as parseable; the service
// turns it into a Date.
const dateField = z.preprocess(
  emptyToUndef,
  z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date.")
    .optional(),
);

// Shared optional company / contact / address fields (create + update).
const sharedCustomerFields = {
  legalName: z.string().trim().max(160).optional(),
  contactPerson: z.string().trim().max(120).optional(),
  contactJobTitle: z.string().trim().max(80).optional(),
  phone: phoneField,
  altPhone: phoneField,
  registrationNumber: z.string().trim().max(40).optional(),
  industry: z.string().trim().max(80).optional(),
  website: websiteField,
  notes: z.string().trim().max(2000).optional(),
  addressLine1: z.string().trim().max(120).optional(),
  addressLine2: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  county: z.string().trim().max(80).optional(),
  postcode: postcodeField,
  country: z.string().trim().max(80).optional(),
  status: statusEnum.optional(),
  // Company logo as a data URI (uploaded to Cloudinary by the service).
  logo: z.string().startsWith("data:image/", "Logo must be an image data URI.").optional(),
};

export const createCustomerSchema = z.object({
  name: z
    .string({ error: "Customer name is required." })
    .trim()
    .min(1, "Customer name is required.")
    .max(120),
  email: emailField(),
  ...sharedCustomerFields,
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z.object({
  name: z.string().trim().min(1, "Customer name can't be empty.").max(120).optional(),
  email: emailField().optional(),
  ...sharedCustomerFields,
  // Clears the existing logo (when no new one is uploaded).
  removeLogo: z.boolean().optional(),
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

// --- nested: projects -------------------------------------------------------

const projectStatusEnum = z.enum(["active", "planned", "on_hold", "completed"]);

export const projectSchema = z.object({
  name: z
    .string({ error: "Project name is required." })
    .trim()
    .min(1, "Project name is required.")
    .max(120),
  type: z.string().trim().max(80).optional(),
  startDate: dateField,
  endDate: dateField,
  status: z.preprocess(emptyToUndef, projectStatusEnum.optional()),
  description: z.string().trim().max(2000).optional(),
});
export type ProjectInput = z.infer<typeof projectSchema>;

// --- nested: catalogue ------------------------------------------------------

export const catalogueItemSchema = z.object({
  // Fixed columns are all surfaced verbatim on the customer-facing catalogue, so
  // each rejects a stray currency symbol.
  name: catalogueText(160, "Item name"),
  sku: catalogueText(80, "SKU"),
  // A reference to a global Category (validated against the active list in the service).
  categoryId: z
    .string({ error: "Select a category." })
    .trim()
    .regex(/^[a-f0-9]{24}$/i, "Select a category."),
  description: z.string().trim().max(2000).optional(),
  uom: uomField,
  serialized: z.boolean().optional(),
  barcodeRequired: z.boolean().optional(),
  highValue: z.boolean().optional(),
  thresholdQty: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.coerce.number().int("Use a whole number.").min(0).max(1_000_000).optional(),
  ),
  status: statusEnum.optional(),
  // Dynamic per-category custom fields (e.g. { Fibre: "Singlemode" }). String
  // keys/values only (bounded), capped in count, currency-symbol-guarded.
  attributes: z
    .record(z.string().trim().min(1).max(60), z.string().max(200))
    .refine((o) => Object.keys(o).length <= 30, "Too many custom fields (max 30).")
    .refine(
      (o) => !Object.entries(o).some(([k, v]) => CURRENCY_RE.test(k) || CURRENCY_RE.test(v)),
      NO_CURRENCY_MSG,
    )
    .optional(),
});
export type CatalogueItemInput = z.infer<typeof catalogueItemSchema>;

// --- nested: sites ----------------------------------------------------------

export const siteSchema = z.object({
  name: z
    .string({ error: "Site name is required." })
    .trim()
    .min(1, "Site name is required.")
    .max(120),
  addressLine: z.string().trim().max(200).optional(),
  postcode: postcodeField,
  contactPerson: z.string().trim().max(120).optional(),
  contactNumber: phoneField,
  // No latitude/longitude here — the service geocodes them from the postcode
  // (postcodes.io). Any client-supplied coordinates are ignored (stripped).
  status: statusEnum.optional(),
});
export type SiteInput = z.infer<typeof siteSchema>;

// --- nested: customer users -------------------------------------------------

export const customerUserSchema = z.object({
  fullName: z
    .string({ error: "Full name is required." })
    .trim()
    .min(1, "Full name is required.")
    .max(120),
  email: emailField(),
  phone: phoneField,
  designation: z.string().trim().max(120).optional(),
  status: statusEnum.optional(),
});
export type CustomerUserInput = z.infer<typeof customerUserSchema>;

// --- customer stock requests (portal-submitted catalogue-add requests) -------

// What a portal user submits to REQUEST stock — an order / replenishment ask. Item
// name + quantity + a business reason are MANDATORY (an approval without a quantity or
// reason is useless for audit + inventory planning later). Categories are internal
// master-data and never appear on a customer request. The currency guard isn't
// needed here — a request isn't customer-visible catalogue content.
export const stockRequestSchema = z.object({
  name: z
    .string({ error: "Item name is required." })
    .trim()
    .min(1, "Item name is required.")
    .max(160),
  quantity: z.coerce
    .number({ error: "Quantity is required." })
    .int("Use a whole number.")
    .min(1, "Quantity must be at least 1.")
    .max(1_000_000),
  reason: z
    .string({ error: "A business reason is required." })
    .trim()
    .min(1, "A business reason is required.")
    .max(1000),
  notes: z.string().trim().max(2000).optional(),
});
export type StockRequestInput = z.infer<typeof stockRequestSchema>;

// Optional admin response note when approving / rejecting a request (shown to the
// customer).
export const stockReviewSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type StockReviewInput = z.infer<typeof stockReviewSchema>;
