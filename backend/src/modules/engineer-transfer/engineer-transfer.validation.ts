import { z } from "zod";

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Must be a valid ObjectId.");

// Individual line schema — the refinement enforces that company lines carry an irmItemId
// and customer lines carry a customerStockEntryId. quantity must be a positive integer.
const lineSchema = z
  .object({
    ownership: z.enum(["company", "customer"]),
    irmItemId: objectId.optional(),
    customerStockEntryId: objectId.optional(),
    quantity: z
      .number()
      .int("Quantity must be a whole number.")
      .min(1, "Quantity must be at least 1.")
      .max(1_000_000, "Quantity exceeds maximum allowed."),
  })
  .superRefine((v, ctx) => {
    if (v.ownership === "company" && !v.irmItemId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["irmItemId"], message: "irmItemId is required for company-ownership lines." });
    }
    if (v.ownership === "customer" && !v.customerStockEntryId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["customerStockEntryId"], message: "customerStockEntryId is required for customer-ownership lines." });
    }
  });

export const createTransferSchema = z.object({
  // fromEngineerId = who holds the stock (required — the engineer being requested FROM)
  fromEngineerId: objectId,
  // toEngineerId is optional; when omitted the service defaults to the calling engineer (self-service)
  toEngineerId: objectId.optional(),
  lines: z.array(lineSchema).min(1, "At least one line is required."),
  reason: z.string().trim().min(1, "Reason is required."),
  notes: z.string().trim().optional(),
  jobId: objectId.optional(),
  customerId: objectId.optional(),
  attachments: z.array(z.string().url("Attachment must be a valid URL.")).optional(),
});
export type CreateTransferInput = z.infer<typeof createTransferSchema>;
export type TransferLineInput = z.infer<typeof lineSchema>;

export const declineSchema = z.object({
  reason: z.string().trim().optional(),
});
export type DeclineInput = z.infer<typeof declineSchema>;

export const acknowledgeSchema = z.object({
  // A base64 data URI signature image
  signature: z
    .string()
    .min(1, "Signature is required.")
    .regex(/^data:image\//i, "Signature must be a base64 image data URI."),
});
export type AcknowledgeInput = z.infer<typeof acknowledgeSchema>;

// ~2 MB budget (same as branding uploads)
const MAX_DATA_URI_CHARS = 3 * 1024 * 1024;
export const uploadAttachmentSchema = z.object({
  image: z
    .string()
    .max(MAX_DATA_URI_CHARS, "Attachment is too large (max ~2 MB).")
    .regex(
      /^data:(image\/(png|jpe?g|gif|webp|svg\+xml)|application\/pdf|application\/octet-stream)/i,
      "Attachment must be a base64 data URI.",
    ),
});
export type UploadAttachmentInput = z.infer<typeof uploadAttachmentSchema>;
