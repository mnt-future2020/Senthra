import { z } from "zod";

import { emailField, optionalPhoneField as phoneField } from "../../utils/validation.js";

const statusEnum = z.enum(["active", "inactive"]);

// Lenient website check: empty, a bare domain, or a full URL (http/https).
const WEBSITE_RE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i;
// Standard UK postcode shape, e.g. "EC1A 1BB", "M1 1AE".
const UK_POSTCODE_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/;

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
// frontend stock item modal list.
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

// --- customer stock requests (portal-submitted stock requests) ----------------

// What a portal user submits to REQUEST stock — an order / replenishment ask. Item
// name + quantity are MANDATORY. Reason and notes are optional free-text. Categories
// are internal master-data and never appear on a customer request.
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
  reason: z.string().trim().max(1000).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type StockRequestInput = z.infer<typeof stockRequestSchema>;

// ADMIN creates a submission on behalf of a customer (e.g. taken over the phone).
// Same shape as the portal submission plus an optional "requested by" contact name.
export const adminStockRequestSchema = stockRequestSchema.extend({
  requestedByName: z.string().trim().max(160).optional(),
});
export type AdminStockRequestInput = z.infer<typeof adminStockRequestSchema>;

// Optional admin response note when approving / rejecting a request (shown to the
// customer).
export const stockReviewSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type StockReviewInput = z.infer<typeof stockReviewSchema>;

// PM edits the request: corrects the item name + optional item link.
export const stockRequestEditSchema = z.object({
  editedName: z
    .string({ error: "Corrected item name is required." })
    .trim()
    .min(1, "Corrected item name is required.")
    .max(160),
  catalogueItemId: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{24}$/i, "Invalid catalogue item.")
    .optional(),
  note: z.string().trim().max(500).optional(),
});
export type StockRequestEditInput = z.infer<typeof stockRequestEditSchema>;

// PM assigns a request's quantity across one or more warehouses.
const warehouseAssignmentItem = z.object({
  warehouseId: z
    .string({ error: "Warehouse is required." })
    .trim()
    .regex(/^[a-f0-9]{24}$/i, "Invalid warehouse."),
  quantity: z.coerce
    .number({ error: "Quantity is required." })
    .int("Use a whole number.")
    .min(1, "Quantity must be at least 1.")
    .max(1_000_000),
});

export const stockRequestAssignSchema = z.object({
  assignments: z
    .array(warehouseAssignmentItem)
    .min(1, "At least one warehouse assignment is required.")
    .max(50),
});
export type StockRequestAssignInput = z.infer<typeof stockRequestAssignSchema>;

// Warehouse manager receives stock against an assignment.
export const stockAssignmentReceiveSchema = z.object({
  receivedQuantity: z.coerce
    .number({ error: "Received quantity is required." })
    .int("Use a whole number.")
    .min(1, "Received quantity must be at least 1.")
    .max(1_000_000),
  notes: z.string().trim().max(2000).optional(),
});
export type StockAssignmentReceiveInput = z.infer<typeof stockAssignmentReceiveSchema>;

// --- customer stock entries (product details filled after warehouse receive) ---

const objectIdField = z.string().trim().regex(/^[a-f0-9]{24}$/i, "Invalid ID.");

export const stockEntryUpdateSchema = z.object({
  itemName: z
    .string({ error: "Item name is required." })
    .trim()
    .min(1, "Item name is required.")
    .max(160),
  sku: z.string().trim().max(80).optional(),
  categoryId: objectIdField.optional(),
  description: z.string().trim().max(2000).optional(),
  uom: uomField,
  serialized: z.boolean().optional(),
  serialNumber: z.string().trim().max(120).optional(),
  highValue: z.boolean().optional(),
  attributes: z
    .record(z.string().trim().min(1).max(60), z.string().max(200))
    .refine((o) => Object.keys(o).length <= 30, "Too many custom fields (max 30).")
    .optional(),
});
export type StockEntryUpdateInput = z.infer<typeof stockEntryUpdateSchema>;

export const directStockEntrySchema = z.object({
  warehouseId: objectIdField,
  itemName: z
    .string({ error: "Item name is required." })
    .trim()
    .min(1, "Item name is required.")
    .max(160),
  sku: z.string().trim().max(80).optional(),
  categoryId: objectIdField.optional(),
  description: z.string().trim().max(2000).optional(),
  uom: uomField,
  quantity: z.number({ error: "Quantity is required." }).int().min(1, "Quantity must be at least 1."),
  serialized: z.boolean().optional(),
  serialNumber: z.string().trim().max(120).optional(),
  highValue: z.boolean().optional(),
  thresholdQty: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.coerce.number().int("Use a whole number.").min(0).max(1_000_000).optional(),
  ),
  attributes: z
    .record(z.string().trim().min(1).max(60), z.string().max(200))
    .refine((o) => Object.keys(o).length <= 30, "Too many custom fields (max 30).")
    .optional(),
});
export type DirectStockEntryInput = z.infer<typeof directStockEntrySchema>;
