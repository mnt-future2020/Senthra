import { z } from "zod";

// Validation for the non-job Van Stock Request flow (engineer ↔ warehouse).
// Restock: the engineer picks a collection warehouse PER LINE, with that warehouse's live free stock
//   shown beside it — the same shape as a job's kit list, where each line names the warehouse it is
//   picked from. Lines route the request: belongsToWarehouses() already matches on any line's
//   sourceWarehouseId, so each source warehouse sees (and scans out) only its own lines.
// Return: the engineer picks the FINAL warehouse at create (they drive there); no per-line source.
//
// Why per line rather than one warehouse for the whole request: the engineer is the one who drives.
// Asking for a single collection point forced a guess about where stock LIVES — knowledge they don't
// have — and a wrong guess meant a reviewer split the request afterwards, so the engineer discovered
// the second stop only after approval. Showing per-warehouse availability inline moves that choice to
// the person who bears its cost, before they commit. The multi-warehouse end state is unchanged: it
// is exactly what a reviewer-side split already produced, and the whole fulfilment path (per-line
// isMine, per-warehouse progress and close-short) was built for it.
//
// preferredWarehouseId is now DERIVED server-side (the shared warehouse when every line agrees, else
// null for a split) and is never accepted from the client on a restock.

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Must be a valid ObjectId.");

const requestLineSchema = z.object({
  irmItemId: objectId,
  itemName: z.string().trim().min(1, "Item name is required.").max(300),
  qty: z.number().int("Quantity must be a whole number.").min(1, "Quantity must be at least 1.").max(1_000_000),
  // RESTOCK only: where the engineer collects THIS line. Required there (superRefine below), rejected
  // on a return — a return has ONE destination the engineer drives to, named at request level.
  warehouseId: objectId.optional(),
});

// Shared line-array rule: no duplicate items on one request — scan-lookup matches a line BY irmItemId,
// so a duplicated item would make its second line unreachable by scan.
const dedupedLines = z
  .array(requestLineSchema)
  .min(1, "Add at least one item.")
  .max(100, "Too many items on one request.")
  .superRefine((lines, ctx) => {
    const seen = new Set<string>();
    lines.forEach((l, i) => {
      if (seen.has(l.irmItemId)) ctx.addIssue({ code: "custom", path: [i], message: "This item appears twice — combine the quantities into one line." });
      else seen.add(l.irmItemId);
    });
  });

export const createVanStockRequestSchema = z
  .object({
    type: z.enum(["restock", "return"]),
    reason: z.string().trim().min(1, "Tell the warehouse why you need this.").max(2000),
    notes: z.string().trim().max(2000).optional(),
    priority: z.enum(["normal", "high", "urgent"]).default("normal"),
    attachments: z.array(z.string().url("Attachment must be a valid URL.")).max(10).optional(),
    preferredWarehouseId: objectId.optional(), // restock only — REQUIRED there (routes the request)
    warehouseId: objectId.optional(), // return only — final
    lines: dedupedLines,
  })
  .superRefine((v, ctx) => {
    if (v.type === "restock") {
      // Every line names where it is collected from. Reported per line so the form can mark the
      // offending row rather than showing one error for a table.
      v.lines.forEach((l, i) => {
        if (!l.warehouseId) ctx.addIssue({ code: "custom", path: ["lines", i, "warehouseId"], message: "Pick where you'll collect this item." });
      });
      if (v.warehouseId) ctx.addIssue({ code: "custom", path: ["warehouseId"], message: "Restocks don't fix the final warehouse — the reviewer confirms it on approve." });
      // Derived from the lines — accepting it would let a caller route a request somewhere none of
      // its stock is coming from.
      if (v.preferredWarehouseId) ctx.addIssue({ code: "custom", path: ["preferredWarehouseId"], message: "Set each line's warehouse instead — the collection point is derived from them." });
    }
    if (v.type === "return") {
      if (!v.warehouseId) ctx.addIssue({ code: "custom", path: ["warehouseId"], message: "Pick the warehouse you'll return the stock to." });
      if (v.preferredWarehouseId) ctx.addIssue({ code: "custom", path: ["preferredWarehouseId"], message: "Returns fix the warehouse directly — no preference field." });
      v.lines.forEach((l, i) => {
        if (l.warehouseId) ctx.addIssue({ code: "custom", path: ["lines", i, "warehouseId"], message: "A return goes to one warehouse — set it on the request, not per line." });
      });
    }
  });
export type CreateVanStockRequestInput = z.infer<typeof createVanStockRequestSchema>;

export const approveVanStockRequestSchema = z.object({
  warehouseId: objectId, // FINAL fulfilment warehouse (may differ from the engineer's preference)
  lineApprovals: z
    .array(
      z.object({
        lineId: objectId,
        approvedQty: z.number().int().min(0).max(1_000_000), // 0 = exclude the line
        sourceWarehouseId: objectId.optional(), // omitted ⇒ primary warehouseId
      }),
    )
    .max(100)
    .optional(),
  decisionNote: z.string().trim().max(2000).optional(),
});
export type ApproveVanStockRequestInput = z.infer<typeof approveVanStockRequestSchema>;

export const declineVanStockRequestSchema = z.object({
  // The warehouse tab the reviewer is declining FROM — only its own lines are refused, mirroring
  // closeShortSchema. Without it the service had to guess from the actor's permissions, and an
  // unrestricted actor (super admin, no warehouse scope) declined every warehouse's lines at once.
  warehouseId: objectId,
  decisionNote: z.string().trim().min(1, "Tell the engineer why this was declined.").max(2000),
});
export type DeclineVanStockRequestInput = z.infer<typeof declineVanStockRequestSchema>;

const fulfilEntrySchema = z
  .object({
    lineId: objectId,
    qty: z.number().int().min(1).max(1_000_000),
    condition: z.enum(["good", "damaged"]).default("good"),
    damagePhotoUrl: z.string().url().max(2000).optional(),
    damageReason: z.string().trim().max(2000).optional(),
    // REQUIRED: every posted entry must come from a scan — the code physically read (or typed) off the
    // item. Mirrors Goods Management, which has no manual-add path for catalogue items. The lookup
    // resolves code | barcode | SKU, so an item with no printed barcode is still reachable by its IRM
    // code. Enforced here (not just in the UI) so a direct API call can't post unverified stock.
    scannedCode: z.string().trim().min(1, "Every line must be scanned in.").max(200),
  })
  .superRefine((e, ctx) => {
    if (e.condition === "damaged") {
      if (!e.damagePhotoUrl) ctx.addIssue({ code: "custom", path: ["damagePhotoUrl"], message: "A photo is required for damaged stock." });
      if (!e.damageReason?.trim()) ctx.addIssue({ code: "custom", path: ["damageReason"], message: "A reason is required for damaged stock." });
    }
  });

export const fulfilVanStockRequestSchema = z.object({
  // The single warehouse this posting issues FROM (restock) / receives INTO (return) — the tab the
  // reviewer is acting in. Every entry's line must be sourced to it; the service enforces that even for
  // an admin, so a line is only ever posted out of the warehouse it belongs to.
  warehouseId: objectId,
  entries: z.array(fulfilEntrySchema).min(1, "Scan at least one item.").max(200),
});
export type FulfilVanStockRequestInput = z.infer<typeof fulfilVanStockRequestSchema>;

export const closeShortSchema = z.object({
  // The warehouse tab the reviewer is closing short FROM — only its own outstanding lines are written
  // off (enforced in the service), so an admin can't write off another warehouse's lines from one tab.
  warehouseId: objectId,
  note: z.string().trim().min(1, "Say why the remaining quantity won't be fulfilled.").max(2000),
});
export type CloseShortInput = z.infer<typeof closeShortSchema>;

export const walkInSchema = z.object({
  engineerId: objectId,
  warehouseId: objectId,
  reason: z.string().trim().min(1, "A reason is required.").max(2000),
  priority: z.enum(["normal", "high", "urgent"]).default("normal"),
  notes: z.string().trim().max(2000).optional(),
  lines: dedupedLines,
});
export type WalkInInput = z.infer<typeof walkInSchema>;

export const scanLookupSchema = z.object({
  requestId: objectId,
  // The warehouse tab the scan is happening in — the line must be sourced to it (enforced in the
  // service), so a scan only ever resolves against the warehouse it's meant to be issued from.
  warehouseId: objectId,
  code: z.string().trim().min(1).max(200),
});
export type ScanLookupInput = z.infer<typeof scanLookupSchema>;

// ~2 MB budget (same as kit-request / engineer-transfer uploads).
const MAX_DATA_URI_CHARS = 3 * 1024 * 1024;
export const uploadImageSchema = z.object({
  image: z
    .string()
    .max(MAX_DATA_URI_CHARS, "Attachment is too large (max ~2 MB).")
    .regex(/^data:(image\/(png|jpe?g|gif|webp|svg\+xml)|application\/pdf|application\/octet-stream)/i, "Attachment must be a base64 data URI."),
});
export type UploadImageInput = z.infer<typeof uploadImageSchema>;
