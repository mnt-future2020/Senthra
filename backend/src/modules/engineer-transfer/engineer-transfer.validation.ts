import { z } from "zod";

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Must be a valid ObjectId.");

// Individual line schema — the refinement enforces that company lines carry an irmItemId
// and customer lines carry a customerStockEntryId. quantity must be a positive integer.
const lineSchema = z
  .object({
    ownership: z.enum(["company", "customer"]),
    irmItemId: objectId.optional(),
    customerStockEntryId: objectId.optional(),
    // Set only when this transfer fulfils a job kit request (created via the kit-request approve flow,
    // not the ordinary composer) — attributes the received qty to that kit line on completion.
    jobKitLineId: objectId.optional(),
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

// ~2 MB budget (same as branding uploads)
const MAX_DATA_URI_CHARS = 3 * 1024 * 1024;

export const acknowledgeSchema = z.object({
  // A base64 data URI signature image.
  //
  // PNG is what the app produces: the recipient DRAWS this on a canvas and it is captured with
  // `canvas.toDataURL("image/png")` (EngineerTransfers.tsx) — there is no upload alternative. JPEG is
  // accepted alongside it because that is the app's established signature contract (user.validation's
  // `signatureImage`), so a future upload option needs no second rule.
  //
  // This used to accept any `data:image/…`, which included `svg+xml`. A signature is EVIDENCE that a
  // named person took delivery, and an SVG is a document that can render differently in different
  // viewers — the one property such a record must not have. It could also carry script, and these
  // land on a public Cloudinary URL.
  //
  // The size ceiling is the app-wide data-URI budget, and it was previously absent altogether: the
  // only limit was the global body parser's, so this single field could carry ~3.7 MB. A drawn
  // signature is tens of kilobytes.
  signature: z
    .string()
    .min(1, "Signature is required.")
    .max(MAX_DATA_URI_CHARS, "Signature is too large (max ~2 MB).")
    .regex(/^data:image\/(png|jpe?g);base64,/i, "Signature must be a PNG or JPG image."),
});
export type AcknowledgeInput = z.infer<typeof acknowledgeSchema>;
export const uploadAttachmentSchema = z.object({
  image: z
    .string()
    .max(MAX_DATA_URI_CHARS, "Attachment is too large (max ~2 MB).")
    .regex(
      // `application/octet-stream` used to be accepted here. It is the media type a browser emits
      // when it knows nothing about a file, so accepting it meant this endpoint accepted ANY payload
      // — an executable, an archive — as long as the caller labelled it that way. Nothing produces it:
      // the picker filters to `image/*`, and a file the browser cannot type is not one we can either.
      // Anchored to `;base64,`. Without it `data:image/png,hello` passed validation and failed later
      // inside Cloudinary — an error from the wrong layer, wearing a message about nothing the caller
      // did. Every other image endpoint (settings, user, customer) anchors it.
      /^data:(image\/(png|jpe?g|gif|webp|svg\+xml)|application\/pdf);base64,/i,
      "Attachment must be a PDF or a PNG, JPG, GIF, WEBP or SVG image.",
    ),
});
export type UploadAttachmentInput = z.infer<typeof uploadAttachmentSchema>;
