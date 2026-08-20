import { z } from "zod";

import { UOM_OPTIONS } from "../../utils/uom.js";

import { emailField, optionalPhoneField as phoneField } from "../../utils/validation.js";
import { postcodeField as ukPostcode } from "../../utils/postcode.js";

const statusEnum = z.enum(["active", "inactive"]);

// Lenient website check: empty, a bare domain, or a full URL (http/https).
const WEBSITE_RE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i;

// An empty/blank string from an unselected <select> or cleared <input> becomes
// `undefined`, so it doesn't trip an enum / format / number check downstream.
const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const websiteField = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v === "" || WEBSITE_RE.test(v), "Enter a valid website (e.g. example.com).")
  .optional();

// Validates AND normalises to canonical form ("ls14dy" → "LS1 4DY") — see utils/postcode.ts.
const postcodeField = ukPostcode().optional();

// Units of measure (UK telecom field-services stock). Kept in lockstep with the
// frontend stock item modal list.
// One vocabulary for the whole app — see utils/uom.ts.
export { UOM_OPTIONS } from "../../utils/uom.js";
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
  //
  // Held to the same rule as a user's avatar, not to the branding rule — the two are the closest
  // analogues in the app: both are picked from the same form helper (lib/image.ts, 2 MB client-side),
  // both are stored on a record rather than in Settings, and both render through <Avatar>. Branding
  // is deliberately looser because a favicon needs ICO and an admin sets it once.
  //
  // RASTER ONLY. SVG is excluded for the reason user.validation gives: it can carry script, and these
  // land on a public Cloudinary URL that opens in its own tab, where an <img> tag's protection does
  // not apply. GIF/WEBP are allowed because the avatar rule allows them and a logo is the same kind
  // of picture.
  //
  // The size cap matters as much as the type. This field had neither, so the only ceiling was the
  // body parser's 5mb — meaning a caller could push a ~3.7 MB blob to a PAID CDN through a field the
  // UI limits to 2 MB, and every read of that customer would serve it. base64 inflates by ~33%, so
  // ~3 MB of characters caps the binary near 2.2 MB: above what the picker allows, below anything
  // worth calling an upload.
  logo: z
    .string()
    .max(3 * 1024 * 1024, "Logo is too large (max ~2 MB).")
    .regex(/^data:image\/(png|jpe?g|gif|webp);base64,/i, "Logo must be a PNG, JPG, GIF or WEBP image.")
    .optional(),
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
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  county: z.string().trim().max(120).optional(),
  postcode: postcodeField,
  country: z.string().trim().max(120).optional(),
  contactPerson: z.string().trim().max(120).optional(),
  contactNumber: phoneField,
  // No latitude/longitude here — the service geocodes them from the postcode
  // (postcodes.io). Any client-supplied coordinates are ignored (stripped).
  status: statusEnum.optional(),
});
export type SiteInput = z.infer<typeof siteSchema>;

// Bulk site import. Route-level guard only: an array of RAW row objects, size-bounded.
// Per-row validation is intentionally deferred to the service (siteSchema.safeParse per
// row) so one bad row reports as `failed` instead of rejecting the whole batch.
export const bulkSiteSchema = z.object({
  fileName: z.string().trim().max(260).optional(),
  // Raw, per-row-unvalidated: even a non-object element is accepted here so the service can
  // report it as a `failed` row (via siteSchema.safeParse) instead of 400-ing the whole batch.
  sites: z
    .array(z.unknown())
    .min(1, "Add at least one site.")
    .max(500, "Import up to 500 sites per batch."),
});
export type BulkSiteInput = z.infer<typeof bulkSiteSchema>;

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

// What a portal user submits to REQUEST stock — an order / replenishment ask.
// Quantity is MANDATORY. The item is EITHER a free-text new name OR a link to an
// existing stock line (`linkedStockEntryId`) the submission tops up — exactly one is
// required (enforced by the refine below). Reason and notes are optional free-text.
// Categories are internal master-data and never appear on a customer request.
const stockRequestBase = z.object({
  name: z.string().trim().max(160).optional(),
  // Existing stock line this submission adds to (top-up). When present, the item name
  // is derived server-side from that line, so `name` becomes optional.
  linkedStockEntryId: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{24}$/i, "Invalid item.")
    .optional(),
  quantity: z.coerce
    .number({ error: "Quantity is required." })
    .int("Use a whole number.")
    .min(1, "Quantity must be at least 1.")
    .max(1_000_000),
  reason: z.string().trim().max(1000).optional(),
  notes: z.string().trim().max(2000).optional(),
});

const hasNameOrLink = (v: { name?: string; linkedStockEntryId?: string }) =>
  Boolean((v.name && v.name.trim().length > 0) || v.linkedStockEntryId);
const nameOrLinkIssue: { message: string; path: PropertyKey[] } = {
  message: "Enter an item name or select an existing item.",
  path: ["name"],
};

export const stockRequestSchema = stockRequestBase.refine(hasNameOrLink, nameOrLinkIssue);
export type StockRequestInput = z.infer<typeof stockRequestSchema>;

// ADMIN creates a submission on behalf of a customer (e.g. taken over the phone).
// Same shape as the portal submission plus an optional "requested by" contact name.
export const adminStockRequestSchema = stockRequestBase
  .extend({ requestedByName: z.string().trim().max(160).optional() })
  .refine(hasNameOrLink, nameOrLinkIssue);
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

// Short-closing a delivery is a judgement call that ends the line permanently, so the reason is
// REQUIRED — a bare `.min(1)` would let a single space through, hence the trim first.
export const stockAssignmentCloseShortSchema = z.object({
  reason: z
    .string({ error: "A reason is required." })
    .trim()
    .min(3, "Give a short reason (at least 3 characters).")
    .max(500, "Keep the reason under 500 characters."),
});
export type StockAssignmentCloseShortInput = z.infer<typeof stockAssignmentCloseShortSchema>;

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

// --- customer stock transfer (warehouse → warehouse consignment move) -----------

// NB: the source entry id comes from the route param (`/stock-entries/:id/transfer`), NOT the body —
// the controller reads it via `param(req, "id")`. Requiring it here too would 400 every legitimate call.
export const customerStockTransferSchema = z.object({
  toWarehouseId: objectIdField,
  quantity: z.coerce
    .number({ error: "Quantity is required." })
    .int("Use a whole number.")
    .min(1, "Quantity must be at least 1.")
    .max(1_000_000),
  notes: z.string().trim().max(2000).optional(),
});
export type CustomerStockTransferInput = z.infer<typeof customerStockTransferSchema>;

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
  quantity: z.number({ error: "Quantity is required." }).int().min(1, "Quantity must be at least 1.").max(1_000_000, "Quantity is too large."),
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
