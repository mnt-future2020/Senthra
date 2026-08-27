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

// ── Priority: a two-level scale ─────────────────────────────────────────────────────────────────
//
// Normal, or Urgent. "high" was retired (2026-08-20, client request): the reviewer's queue is worked
// oldest-first, and a middle rung between "normal" and "urgent" only asked the engineer to grade
// their own hurry — three shades of "soon" that the queue never sorted by and nobody could act on
// differently. Jobs and Purchase Orders keep their own four-level scales; those are separate lists
// with separate enums, and this is deliberately not a shared constant.
export const VAN_STOCK_PRIORITIES = ["normal", "urgent"] as const;
export type VanStockPriority = (typeof VAN_STOCK_PRIORITIES)[number];

// The retired value is UNDERSTOOD on the way in, not refused. A client still offering "high" is a
// build nobody can fix from here — an engineer's phone that hasn't been reinstalled, a browser tab
// open since before the deploy — and bouncing their restock with "expected one of normal|urgent"
// strands them mid-job over a label. Rewriting it to the urgent it always meant costs the request
// nothing, and the row still lands on a live value: nothing writes "high" to Mongo again.
//
// Genuine nonsense ("asap") is still rejected, and the error names only the two live options.
const prioritySchema = z.preprocess((v) => (v === "high" ? "urgent" : v), z.enum(VAN_STOCK_PRIORITIES)).default("normal");

// Requests raised BEFORE the retirement still hold "high" in Mongo. `priority` is a plain String
// there, so closing the enum above changed writes only — nothing rewrote the rows already stored,
// and src/scripts/retire-van-stock-high-priority.ts may not have been run in every environment.
// Every read goes through this, so a legacy row surfaces as the urgent it always meant instead of a
// third value the UI has no option for. Anything unrecognised reads as normal: a junk value should
// not promote itself into the reviewer's urgent lane.
export function readPriority(stored: string): VanStockPriority {
  return stored === "urgent" || stored === "high" ? "urgent" : "normal";
}

/** The STORED values a priority filter must match — the read-side mirror of readPriority(), so
 *  filtering "Urgent" in the warehouse queue still returns the legacy high rows it renders as urgent.
 *
 *  Symmetric on purpose: the queue's filter lives in the URL (`?vPriority=`), so a reviewer's saved
 *  or shared link can still name the retired level. Matching that exactly would return NOTHING —
 *  an empty queue reading as "no urgent requests" rather than as a stale bookmark. */
export function priorityFilterValues(priority: string): string[] {
  return priority === "urgent" || priority === "high" ? ["urgent", "high"] : [priority];
}

// ── Line sources: company stock, or hired equipment ─────────────────────────────────────────────
//
// `irm` is what this flow has always carried. `rental` joins it so an engineer can collect HIRED kit
// for field work that is not tied to one job — the same pool a job kit request can draw on, reached
// from the non-job door. The two pools a JOB request also offers are deliberately absent: customer
// stock belongs to a customer's job, and `misc` free-text names nothing a warehouse could scan out.
//
// `source` DEFAULTS to "irm", which is what keeps every existing client working untouched: a payload
// that names only `irmItemId` — every request ever sent before this shipped, and the mobile app until
// its own pass lands — parses to exactly the line it always did.
export const VAN_STOCK_LINE_SOURCES = ["irm", "rental"] as const;
export type VanStockLineSource = (typeof VAN_STOCK_LINE_SOURCES)[number];

const requestLineSchema = z
  .object({
    source: z.enum(VAN_STOCK_LINE_SOURCES).default("irm"),
    irmItemId: objectId.optional(),
    rentalItemId: objectId.optional(),
    itemName: z.string().trim().min(1, "Item name is required.").max(300),
    qty: z.number().int("Quantity must be a whole number.").min(1, "Quantity must be at least 1.").max(1_000_000),
    // RESTOCK only: where the engineer collects THIS line. Required there (superRefine below), rejected
    // on a return — a return has ONE destination the engineer drives to, named at request level.
    warehouseId: objectId.optional(),
  })
  // source ⇄ id consistency, mirroring the job kit-line rules. Rejecting the WRONG id rather than
  // ignoring it is the point: a line carrying both would otherwise persist with one silently dropped,
  // and the request would name an item nobody asked for.
  .superRefine((l, ctx) => {
    if (l.source === "rental") {
      if (!l.rentalItemId) ctx.addIssue({ code: "custom", path: ["rentalItemId"], message: "Select a rental item." });
      if (l.irmItemId) ctx.addIssue({ code: "custom", path: ["irmItemId"], message: "Rental lines can't reference an IRM item." });
    } else {
      if (!l.irmItemId) ctx.addIssue({ code: "custom", path: ["irmItemId"], message: "Select an IRM item." });
      if (l.rentalItemId) ctx.addIssue({ code: "custom", path: ["rentalItemId"], message: "IRM lines can't reference a rental item." });
    }
  });

// Shared line-array rule: no duplicate items on one request — scan-lookup matches a line BY its item
// id, so a duplicated item would make its second line unreachable by scan.
//
// Keyed by SOURCE + id, not id alone. An IRM item and a rental item are separate catalogues with
// separate id spaces, so collapsing them onto a bare id would be wrong in both directions: two
// genuinely different items could collide, and — far worse — nothing would catch the same tester
// added twice.
function lineKey(l: { source: VanStockLineSource; irmItemId?: string; rentalItemId?: string }): string {
  return l.source === "rental" ? `rental:${l.rentalItemId}` : `irm:${l.irmItemId}`;
}

const dedupedLines = z
  .array(requestLineSchema)
  .min(1, "Add at least one item.")
  .max(100, "Too many items on one request.")
  .superRefine((lines, ctx) => {
    const seen = new Set<string>();
    lines.forEach((l, i) => {
      const key = lineKey(l);
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: [i], message: "This item appears twice — combine the quantities into one line." });
      else seen.add(key);
    });
  });

export const createVanStockRequestSchema = z
  .object({
    type: z.enum(["restock", "return"]),
    reason: z.string().trim().min(1, "Tell the warehouse why you need this.").max(2000),
    notes: z.string().trim().max(2000).optional(),
    priority: prioritySchema,
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
  priority: prioritySchema,
  notes: z.string().trim().max(2000).optional(),
  // IRM ONLY — hired kit is deliberately NOT issuable over the counter in this phase.
  //
  // Not an oversight and not a technical limit: a walk-in is pre-approved and scanned out in one
  // motion, which is precisely the review step that a hire — third-party equipment with a return
  // deadline and a bill attached — should not skip. Whether the counter may hand out hired kit is a
  // business call nobody has made, so this refuses it loudly rather than quietly issuing one.
  lines: dedupedLines.superRefine((lines, ctx) => {
    lines.forEach((l, i) => {
      if (l.source === "rental") {
        ctx.addIssue({ code: "custom", path: [i, "source"], message: "Hired equipment can't be issued over the counter — the engineer must raise a field stock request for it." });
      }
    });
  }),
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
    // `application/octet-stream` used to be accepted here. It is the media type a browser emits when it
    // knows nothing about a file, so accepting it meant this endpoint accepted ANY payload — an
    // executable, an archive — as long as the caller labelled it that way. The picker filters to
    // `image/*`, and a file the browser cannot type is not one we can either.
    .regex(
      // Anchored to `;base64,`. Without it `data:image/png,hello` passed validation and failed later
      // inside Cloudinary — an error from the wrong layer, wearing a message about nothing the caller
      // did. Every other image endpoint (settings, user, customer) anchors it.
      /^data:(image\/(png|jpe?g|gif|webp|svg\+xml)|application\/pdf);base64,/i,
      "Attachment must be a PDF or a PNG, JPG, GIF, WEBP or SVG image.",
    ),
});
export type UploadImageInput = z.infer<typeof uploadImageSchema>;
