import { z } from "zod";

// Purchase Order validation. PROCUREMENT WORKFLOW ONLY. Codes/status/totals are SYSTEM-owned
// and never accepted from the client. Editable only in `draft` (enforced in the service).
// Required on create: supplier, delivery warehouse, order date, expected delivery date, and
// at least one line (qty ≥ 1, unit price ≥ 0). Money is integer GBP pence.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export const PO_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const PO_ATTACHMENT_TYPES = ["pdf", "docx", "png", "jpg"] as const;

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const requiredDate = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .min(1, `${label} is required.`)
    .refine((v) => !Number.isNaN(Date.parse(v)), `Enter a valid ${label.toLowerCase()}.`);
const optionalDate = z.preprocess(
  emptyToUndef,
  z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date.")
    .optional(),
);

// One PO line. Unit price is collected in PENCE (the form holds £ and converts).
const lineSchema = z.object({
  irmItemId: z.string().regex(OBJECT_ID_RE, "Select an item."),
  quantity: z.coerce
    .number({ error: "Quantity is required." })
    .int("Use a whole number.")
    .min(1, "Quantity must be at least 1.")
    .max(10_000_000),
  unitPricePence: z.coerce
    .number({ error: "Unit price is required." })
    .int("Unit price must be a whole number of pence.")
    .min(0, "Unit price can't be negative.")
    .max(1_000_000_000),
  vatRate: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.coerce.number().min(0, "VAT can't be negative.").max(100, "VAT must be 0–100%.").optional(),
  ),
  notes: z.string().trim().max(2000).optional(),
});
export type POLineInput = z.infer<typeof lineSchema>;

const noDupItems = (lines: { irmItemId: string }[]) => {
  const ids = lines.map((l) => l.irmItemId);
  return new Set(ids).size === ids.length;
};
const itemsField = z
  .array(lineSchema)
  .min(1, "Add at least one item.")
  .refine(noDupItems, { message: "Each item can only be added once." });

// Shared optional header fields.
const sharedHeader = {
  referenceNumber: z.string().trim().max(60).optional(),
  description: z.string().trim().max(2000).optional(),
  priority: z.preprocess(emptyToUndef, z.enum(PO_PRIORITIES).optional()),
  deliveryAddress: z.string().trim().max(300).optional(),
  deliveryInstructions: z.string().trim().max(500).optional(),
  internalNotes: z.string().trim().max(2000).optional(),
  supplierNotes: z.string().trim().max(2000).optional(),
};

// Expected delivery can't precede the order date (when both are present).
const datesOk = (d: { orderDate?: string; expectedDeliveryDate?: string }) => {
  if (!d.orderDate || !d.expectedDeliveryDate) return true;
  const od = Date.parse(d.orderDate);
  const ed = Date.parse(d.expectedDeliveryDate);
  return Number.isNaN(od) || Number.isNaN(ed) || ed >= od;
};
const datesError = { message: "Expected delivery date can't be before the order date.", path: ["expectedDeliveryDate"] as string[] };

export const createPurchaseOrderSchema = z
  .object({
    supplierId: z.string({ error: "Select a supplier." }).regex(OBJECT_ID_RE, "Select a supplier."),
    warehouseId: z
      .string({ error: "Select a delivery warehouse." })
      .regex(OBJECT_ID_RE, "Select a delivery warehouse."),
    orderDate: requiredDate("Order date"),
    expectedDeliveryDate: requiredDate("Expected delivery date"),
    ...sharedHeader,
    items: itemsField,
  })
  .refine(datesOk, datesError);
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

// --- multi-warehouse auto-split create --------------------------------------
// One purchasing operation whose lines each carry their OWN destination warehouse. The service
// groups lines by warehouse and creates ONE single-warehouse PO per group (a PO never spans
// warehouses). A line therefore extends the standard PO line with a `warehouseId`.
const splitLineSchema = lineSchema.extend({
  warehouseId: z.string({ error: "Select a warehouse." }).regex(OBJECT_ID_RE, "Select a warehouse."),
});
export type SplitPOLineInput = z.infer<typeof splitLineSchema>;

// The SAME item to DIFFERENT warehouses is allowed (separate POs); the same item TWICE for the
// SAME warehouse is not (it would violate the per-PO unique-item rule) — reject with a clear hint.
const noDupItemPerWarehouse = (lines: { irmItemId: string; warehouseId: string }[]) => {
  const seen = new Set<string>();
  for (const l of lines) {
    const key = `${l.warehouseId}:${l.irmItemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
};

export const createPurchaseOrdersSplitSchema = z
  .object({
    supplierId: z.string({ error: "Select a supplier." }).regex(OBJECT_ID_RE, "Select a supplier."),
    orderDate: requiredDate("Order date"),
    expectedDeliveryDate: requiredDate("Expected delivery date"),
    ...sharedHeader,
    items: z
      .array(splitLineSchema)
      .min(1, "Add at least one item.")
      .refine(noDupItemPerWarehouse, {
        message: "The same item can't be added twice for the same warehouse. Combine those into one row.",
      }),
  })
  .refine(datesOk, datesError);
export type CreatePurchaseOrdersSplitInput = z.infer<typeof createPurchaseOrdersSplitSchema>;

// Update = a full DRAFT re-save (the service blocks edits on any non-draft PO).
export const updatePurchaseOrderSchema = z
  .object({
    supplierId: z.preprocess(emptyToUndef, z.string().regex(OBJECT_ID_RE, "Select a supplier.").optional()),
    warehouseId: z.preprocess(
      emptyToUndef,
      z.string().regex(OBJECT_ID_RE, "Select a delivery warehouse.").optional(),
    ),
    orderDate: optionalDate,
    expectedDeliveryDate: optionalDate,
    ...sharedHeader,
    items: itemsField.optional(),
  })
  .refine(datesOk, datesError);
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>;

// --- workflow action bodies -------------------------------------------------
export const poRejectSchema = z.object({
  reason: z.string({ error: "A reason is required." }).trim().min(1, "A reason is required.").max(500),
});
export type PoRejectInput = z.infer<typeof poRejectSchema>;

export const poCancelSchema = z.object({ reason: z.string().trim().max(500).optional() });
export type PoCancelInput = z.infer<typeof poCancelSchema>;

// --- attachment upload (data URI from the form) -----------------------------
const TEN_MB = 10 * 1024 * 1024;
export const poAttachmentSchema = z.object({
  label: z.string().trim().max(80).optional(),
  fileName: z.string().trim().min(1, "File name is required.").max(200),
  fileType: z.enum(PO_ATTACHMENT_TYPES, { error: "Unsupported file type. Use PDF, DOCX, PNG or JPG." }),
  fileSizeBytes: z.coerce.number().int().min(1).max(TEN_MB, "File must be 10 MB or smaller."),
  data: z.string().startsWith("data:", "Upload a valid file."),
});
export type PoAttachmentInput = z.infer<typeof poAttachmentSchema>;
