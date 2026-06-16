import { z } from "zod";

// Goods In (GRN) validation. RECEIVING WORKFLOW ONLY. Codes/status/accepted/previouslyReceived
// and all inventory writes are SYSTEM-owned and never accepted from the client. Editable only in
// `draft` (enforced in the service). Required on create: purchase order, received date, and at
// least one line receiving ≥ 1. Serial/batch COUNT rules (= accepted) are service-enforced
// because they need the IRM track flags + the computed accepted quantity.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export const GRN_QUALITY_STATUSES = ["passed", "partial", "failed"] as const;
export const GRN_ATTACHMENT_TYPES = ["pdf", "docx", "png", "jpg"] as const;

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

const intQty = (label: string) =>
  z.coerce.number({ error: `${label} is required.` }).int(`${label} must be a whole number.`).min(0, `${label} can't be negative.`).max(10_000_000);

// A batch / lot line (only meaningful when the IRM item tracks batches).
const batchSchema = z.object({
  batchNumber: z.string().trim().min(1, "Batch number is required.").max(120),
  expiryDate: optionalDate,
  quantity: z.coerce.number({ error: "Batch quantity is required." }).int("Batch quantity must be a whole number.").min(1, "Batch quantity must be at least 1.").max(10_000_000),
});

// One received line — receives against ONE PO line.
const lineSchema = z
  .object({
    purchaseOrderItemId: z.string().regex(OBJECT_ID_RE, "Select a purchase order line."),
    receivedQuantity: intQty("Received quantity"),
    damagedQuantity: z.preprocess(emptyToUndef, intQty("Damaged quantity").optional()),
    notes: z.string().trim().max(2000).optional(),
    serials: z.array(z.string().trim().min(1, "Serial number can't be blank.").max(120)).max(5000, "Too many serial numbers on one line.").optional(),
    batches: z.array(batchSchema).max(500, "Too many batches on one line.").optional(),
  })
  .refine((l) => (l.damagedQuantity ?? 0) <= l.receivedQuantity, {
    message: "Damaged quantity can't exceed received quantity.",
    path: ["damagedQuantity"],
  });
export type GRNLineInput = z.infer<typeof lineSchema>;

const noDupLines = (lines: { purchaseOrderItemId: string }[]) => {
  const ids = lines.map((l) => l.purchaseOrderItemId);
  return new Set(ids).size === ids.length;
};
const itemsField = z
  .array(lineSchema)
  .min(1, "Add at least one item to receive.")
  .max(500, "Too many lines on one goods receipt.")
  .refine(noDupLines, { message: "Each purchase-order line can only be received once per receipt." })
  .refine((lines) => lines.some((l) => l.receivedQuantity >= 1), {
    message: "Receive a quantity of at least 1 for at least one item.",
  });

// Shared optional header fields.
const sharedHeader = {
  referenceNumber: z.string().trim().max(60).optional(),
  carrier: z.string().trim().max(120).optional(),
  deliveryNoteNumber: z.string().trim().max(80).optional(),
  vehicleRegistration: z.string().trim().max(20).optional(),
  description: z.string().trim().max(2000).optional(),
  qualityStatus: z.preprocess(emptyToUndef, z.enum(GRN_QUALITY_STATUSES).optional()),
  qualityNotes: z.string().trim().max(2000).optional(),
  internalNotes: z.string().trim().max(2000).optional(),
};

export const createGoodsReceiptSchema = z.object({
  purchaseOrderId: z.string({ error: "Select a purchase order." }).regex(OBJECT_ID_RE, "Select a purchase order."),
  receivedDate: requiredDate("Received date"),
  ...sharedHeader,
  items: itemsField,
});
export type CreateGoodsReceiptInput = z.infer<typeof createGoodsReceiptSchema>;

// Update = a full DRAFT re-save. The purchase order (and so the warehouse/supplier) is fixed at
// create and never changes; the service additionally blocks edits on any non-draft GRN.
export const updateGoodsReceiptSchema = z.object({
  receivedDate: optionalDate,
  ...sharedHeader,
  items: itemsField.optional(),
});
export type UpdateGoodsReceiptInput = z.infer<typeof updateGoodsReceiptSchema>;

// --- workflow + attachments -------------------------------------------------
export const grnCancelSchema = z.object({ reason: z.string().trim().max(500).optional() });
export type GRNCancelInput = z.infer<typeof grnCancelSchema>;

const TEN_MB = 10 * 1024 * 1024;
export const grnAttachmentSchema = z.object({
  label: z.string().trim().max(80).optional(),
  fileName: z.string().trim().min(1, "File name is required.").max(200),
  fileType: z.enum(GRN_ATTACHMENT_TYPES, { error: "Unsupported file type. Use PDF, DOCX, PNG or JPG." }),
  fileSizeBytes: z.coerce.number().int().min(1).max(TEN_MB, "File must be 10 MB or smaller."),
  data: z.string().startsWith("data:", "Upload a valid file."),
});
export type GRNAttachmentInput = z.infer<typeof grnAttachmentSchema>;
