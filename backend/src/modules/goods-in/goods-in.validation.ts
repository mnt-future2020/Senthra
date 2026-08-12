import { z } from "zod";
import { attachmentTypeMatches, dataUriBytes } from "../../utils/data-uri.js";

// Goods In (GRN) validation. RECEIVING WORKFLOW ONLY. Codes/status/damaged/previouslyReceived
// and all inventory writes are SYSTEM-owned and never accepted from the client. Editable only in
// `draft` (enforced in the service). Required on create: purchase order, received date, and at
// least one line receiving ≥ 1. Serial/batch COUNT rules (= accepted) are service-enforced
// because they need the IRM track flags alongside the accepted quantity.
//
// The client sends received + ACCEPTED (what QC physically passed); damaged is DERIVED
// (received − accepted) in the service. acceptedQuantity is deliberately REQUIRED, not
// optional-defaulting-to-0: a missing field would otherwise silently mean "everything was
// damaged" and quietly keep good stock out of inventory.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export const GRN_QUALITY_STATUSES = ["passed", "partial", "failed"] as const;
export const GRN_ATTACHMENT_TYPES = ["pdf", "docx", "png", "jpg"] as const;

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

// Guard for a REQUIRED quantity that must never default to 0. z.coerce.number() happily turns
// "", null, [], false and true into numbers, so a missing/blank value would sail through as a
// meaningful 0. Anything that isn't a number or a non-blank numeric string becomes `undefined`
// here, which the required inner schema then rejects with a proper "is required" message.
const numericOnly = (v: unknown) => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return v;
  return undefined;
};

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
    // Deliberately NOT bare `intQty`: z.coerce.number() coerces "", null, [] and false all to 0,
    // so any of them would parse as "zero accepted" — i.e. the whole delivery silently marked
    // damaged, posting no stock while the PO still advances by the full received qty. Only a
    // real number (or a numeric string from a form) may reach the coercion.
    acceptedQuantity: z.preprocess(numericOnly, intQty("Accepted quantity")),
    notes: z.string().trim().max(2000).optional(),
    serials: z.array(z.string().trim().min(1, "Serial number can't be blank.").max(120)).max(5000, "Too many serial numbers on one line.").optional(),
    batches: z.array(batchSchema).max(500, "Too many batches on one line.").optional(),
  })
  .refine((l) => l.acceptedQuantity <= l.receivedQuantity, {
    message: "Accepted quantity can't exceed received quantity.",
    path: ["acceptedQuantity"],
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

// Attachment limits — the SINGLE SOURCE OF TRUTH (the frontend mirrors these numbers).
// Per-file size + type are enforced by the schema below; count + total are enforced in the
// service's addAttachment (it has the GRN's existing attachments loaded).
export const GRN_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file
export const GRN_ATTACHMENT_MAX_COUNT = 5; // at most 5 documents per GRN
export const GRN_ATTACHMENT_MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB total per GRN

// The declared `fileType` and `fileSizeBytes` above are the CALLER'S CLAIMS about a payload the
// server used to never open — so "pdf, 40 KB" would carry anything, at any size. Both are now
// settled against `data` itself:
//
//   size  measured from the payload, so the per-file ceiling above is real. It also makes the
//         GRN_ATTACHMENT_MAX_TOTAL_BYTES ceiling a cap that holds, since that total is summed from stored sizes.
//   type  read from the file's leading bytes (%PDF-, PK, PNG, JPEG), not from the URI's media type
//         — that media type is text the caller wrote, so checking it only relocates the claim.
//
// Refined on the OBJECT rather than the `data` field because both checks compare two fields. Each
// reports against the field the user can act on.
export const grnAttachmentSchema = z.object({
  label: z.string().trim().max(80).optional(),
  fileName: z.string().trim().min(1, "File name is required.").max(200),
  fileType: z.enum(GRN_ATTACHMENT_TYPES, { error: "Unsupported file type. Use PDF, DOCX, PNG or JPG." }),
  fileSizeBytes: z.coerce.number().int().min(1).max(GRN_ATTACHMENT_MAX_BYTES, "File must be 5 MB or smaller."),
  data: z.string().startsWith("data:", "Upload a valid file."),
})
  .superRefine((v, ctx) => {
    const actual = dataUriBytes(v.data);
    if (actual === 0) {
      ctx.addIssue({ code: "custom", path: ["data"], message: "Upload a valid file." });
      return;
    }
    if (actual > GRN_ATTACHMENT_MAX_BYTES) {
      ctx.addIssue({ code: "custom", path: ["data"], message: "File must be 5 MB or smaller." });
    } else if (actual !== v.fileSizeBytes) {
      // A mismatch means the two halves of one upload disagree — a broken client, or a declaration
      // aimed at slipping past the ceiling. Neither is worth storing under a size nobody can trust.
      ctx.addIssue({ code: "custom", path: ["fileSizeBytes"], message: "File size doesn't match the uploaded file." });
    }
    if (!attachmentTypeMatches(v.data, v.fileType)) {
      ctx.addIssue({
        code: "custom",
        path: ["fileType"],
        message: "That file isn't a valid PDF, DOCX, PNG or JPG.",
      });
    }
  });
export type GRNAttachmentInput = z.infer<typeof grnAttachmentSchema>;
