import { z } from "zod";

import { emailField, optionalPhoneField as phoneField } from "../../utils/validation.js";

const statusEnum = z.enum(["active", "inactive"]);

// Lenient website check: empty, a bare domain, or a full URL (http/https).
const WEBSITE_RE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i;
// Standard UK postcode shape, e.g. "EC1A 1BB", "M1 1AE".
const UK_POSTCODE_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/;
// Monetary content — a best-effort guard so pricing can never leak onto the
// customer-facing catalogue. Catches currency symbols and common money words in
// EVERY customer-visible catalogue field (name, SKU, category AND the free-form
// attributes), not just attributes. It deliberately omits ambiguous spec words
// like "rate"/"amount" to avoid rejecting legitimate telecom specs ("Data Rate");
// the structural guarantee remains that no catalogue field shown to a customer is
// a dedicated price column.
const MONEY_RE =
  /[£$€]|\b(price|priced|pricing|cost|costs|costing|value|worth|rrp|msrp|vat|gbp|usd|eur)\b/i;
const hasMoney = (v: string): boolean => MONEY_RE.test(v);
const NO_MONEY_MSG =
  "Customers never see pricing — remove any price, cost, or monetary value.";

// Required, trimmed, length-bounded text that also rejects monetary content —
// used for each customer-visible catalogue column.
const catalogueText = (max: number, label: string) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max)
    .refine((v) => !hasMoney(v), NO_MONEY_MSG);

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

// Shared optional company / contact / address fields (create + update).
const sharedCustomerFields = {
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

// --- nested ---

export const projectSchema = z.object({
  name: z
    .string({ error: "Project name is required." })
    .trim()
    .min(1, "Project name is required.")
    .max(120),
});
export type ProjectInput = z.infer<typeof projectSchema>;

export const catalogueItemSchema = z.object({
  // Fixed columns are all surfaced verbatim on the customer-facing catalogue, so
  // each is money-guarded — pricing typed into a name/SKU/category would otherwise
  // leak just as readily as pricing in a custom field.
  name: catalogueText(160, "Item name"),
  sku: catalogueText(80, "SKU"),
  category: catalogueText(80, "Category"),
  // Dynamic per-category custom fields (e.g. { Fibre: "Singlemode" }). String
  // keys/values only (bounded), capped in count, and — since the whole attributes
  // blob is surfaced verbatim on the customer-facing catalogue — money-guarded on
  // both key and value so the "customers never see pricing" rule holds here too.
  attributes: z
    .record(z.string().trim().min(1).max(60), z.string().max(200))
    .refine((o) => Object.keys(o).length <= 30, "Too many custom fields (max 30).")
    .refine(
      (o) => !Object.entries(o).some(([k, v]) => hasMoney(k) || hasMoney(v)),
      NO_MONEY_MSG,
    )
    .optional(),
});
export type CatalogueItemInput = z.infer<typeof catalogueItemSchema>;

export const siteSchema = z.object({
  name: z
    .string({ error: "Site name is required." })
    .trim()
    .min(1, "Site name is required.")
    .max(120),
  postcode: z.string().trim().max(20).optional(),
});
export type SiteInput = z.infer<typeof siteSchema>;
