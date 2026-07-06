import { z } from "zod";

// Validation for the Field-Engineer "additional kit request" flow (FE raises → PM approves/declines).
// A line names one source pool (irm / customer_stock / misc) + qty; the request grows the job's kit on
// approval and opens fulfilment (warehouse issue OR a job-scoped engineer transfer).

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Must be a valid ObjectId.");

const requestLineSchema = z
  .object({
    source: z.enum(["irm", "customer_stock", "misc"]),
    irmItemId: objectId.optional(),
    customerStockEntryId: objectId.optional(),
    itemName: z.string().trim().min(1, "Item name is required.").max(300),
    qty: z
      .number()
      .int("Quantity must be a whole number.")
      .min(1, "Quantity must be at least 1.")
      .max(1_000_000, "Quantity exceeds maximum allowed."),
  })
  // source ⇄ id consistency, mirroring the job kit-line rules.
  .superRefine((l, ctx) => {
    if (l.source === "irm") {
      if (!l.irmItemId) ctx.addIssue({ code: "custom", path: ["irmItemId"], message: "Select an IRM item." });
      if (l.customerStockEntryId) ctx.addIssue({ code: "custom", path: ["customerStockEntryId"], message: "IRM lines can't reference customer stock." });
    } else if (l.source === "customer_stock") {
      if (!l.customerStockEntryId) ctx.addIssue({ code: "custom", path: ["customerStockEntryId"], message: "Select a customer stock item." });
      if (l.irmItemId) ctx.addIssue({ code: "custom", path: ["irmItemId"], message: "Customer-stock lines can't reference IRM." });
    } else if (l.irmItemId || l.customerStockEntryId) {
      ctx.addIssue({ code: "custom", path: ["source"], message: "Misc lines can't reference a source item." });
    }
  });
export type KitRequestLineInput = z.infer<typeof requestLineSchema>;

export const createKitRequestSchema = z.object({
  jobId: objectId,
  reason: z.string().trim().min(1, "Tell the planner why you need these items.").max(2000),
  notes: z.string().trim().max(2000).optional(),
  attachments: z.array(z.string().url("Attachment must be a valid URL.")).max(10).optional(),
  lines: z
    .array(requestLineSchema)
    .min(1, "Add at least one item.")
    .max(100, "Too many items on one request.")
    // No duplicate source item / misc name within one request — keeps kit-line matching unambiguous
    // (the same item must be one line with a combined quantity).
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((l, i) => {
        const key =
          l.source === "irm" ? `irm:${l.irmItemId}` : l.source === "customer_stock" ? `cse:${l.customerStockEntryId}` : `misc:${l.itemName.trim().toLowerCase()}`;
        if (seen.has(key)) ctx.addIssue({ code: "custom", path: [i], message: "This item appears twice — combine the quantities into one line." });
        else seen.add(key);
      });
    }),
});
export type CreateKitRequestInput = z.infer<typeof createKitRequestSchema>;

export const approveKitRequestSchema = z
  .object({
    fulfillmentMode: z.enum(["warehouse_issue", "engineer_transfer"]),
    // Warehouse-issue mode: the pickup warehouse chosen PER IRM request line (requestLineId → warehouseId),
    // so different items can be collected from different warehouses. Customer-stock lines derive their
    // warehouse from the stock entry; misc lines have none. Ignored in engineer-transfer mode.
    lineWarehouses: z.array(z.object({ requestLineId: objectId, warehouseId: objectId })).max(100).optional(),
    // Engineer-transfer mode: the engineer to pull stock from (must hold every stock-tracked line). No
    // warehouse is involved — the stock comes from their van.
    fromEngineerId: objectId.optional(),
    decisionNote: z.string().trim().max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.fulfillmentMode === "engineer_transfer" && !v.fromEngineerId) {
      ctx.addIssue({ code: "custom", path: ["fromEngineerId"], message: "Pick the engineer to transfer stock from." });
    }
  });
export type ApproveKitRequestInput = z.infer<typeof approveKitRequestSchema>;

export const declineKitRequestSchema = z.object({
  decisionNote: z.string().trim().max(2000).optional(),
});
export type DeclineKitRequestInput = z.infer<typeof declineKitRequestSchema>;

// ~2 MB budget (same as branding / engineer-transfer uploads).
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
