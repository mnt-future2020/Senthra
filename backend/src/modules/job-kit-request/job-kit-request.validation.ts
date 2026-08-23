import { z } from "zod";

// Validation for the Field-Engineer "additional kit request" flow (FE raises → PM approves/declines).
// A line names one source pool (irm / customer_stock / rental / misc) + qty; the request grows the
// job's kit on approval and opens fulfilment (warehouse issue OR a job-scoped engineer transfer).
//
// RENTAL is warehouse-only, and that is a property of the pool rather than a UI choice: hired kit is
// not transferable engineer-to-engineer, so the only place a request for one can be fulfilled from is
// a depot holding a live hire with spare units. approve() enforces it — see the refusal there.

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Must be a valid ObjectId.");

const requestLineSchema = z
  .object({
    source: z.enum(["irm", "customer_stock", "rental", "misc"]),
    irmItemId: objectId.optional(),
    customerStockEntryId: objectId.optional(),
    rentalItemId: objectId.optional(),
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
      if (l.rentalItemId) ctx.addIssue({ code: "custom", path: ["rentalItemId"], message: "IRM lines can't reference a rental item." });
    } else if (l.source === "customer_stock") {
      if (!l.customerStockEntryId) ctx.addIssue({ code: "custom", path: ["customerStockEntryId"], message: "Select a customer stock item." });
      if (l.irmItemId) ctx.addIssue({ code: "custom", path: ["irmItemId"], message: "Customer-stock lines can't reference IRM." });
      if (l.rentalItemId) ctx.addIssue({ code: "custom", path: ["rentalItemId"], message: "Customer-stock lines can't reference a rental item." });
    } else if (l.source === "rental") {
      if (!l.rentalItemId) ctx.addIssue({ code: "custom", path: ["rentalItemId"], message: "Select a rental item." });
      if (l.irmItemId) ctx.addIssue({ code: "custom", path: ["irmItemId"], message: "Rental lines can't reference IRM." });
      if (l.customerStockEntryId) ctx.addIssue({ code: "custom", path: ["customerStockEntryId"], message: "Rental lines can't reference customer stock." });
    } else if (l.irmItemId || l.customerStockEntryId || l.rentalItemId) {
      ctx.addIssue({ code: "custom", path: ["source"], message: "Misc lines can't reference a source item." });
    }
  });
export type KitRequestLineInput = z.infer<typeof requestLineSchema>;

export const createKitRequestSchema = z.object({
  jobId: objectId,
  reason: z.string().trim().min(1, "Tell the planner why you need these items.").max(2000),
  notes: z.string().trim().max(2000).optional(),
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
          l.source === "irm"
            ? `irm:${l.irmItemId}`
            : l.source === "customer_stock"
              ? `cse:${l.customerStockEntryId}`
              : l.source === "rental"
                ? `rental:${l.rentalItemId}`
                // Misc keys on the NAME, so a rental line reaching this arm would dedupe against a
                // free-text item of the same name — and the composer labels both with the item name.
                : `misc:${l.itemName.trim().toLowerCase()}`;
        if (seen.has(key)) ctx.addIssue({ code: "custom", path: [i], message: "This item appears twice — combine the quantities into one line." });
        else seen.add(key);
      });
    }),
});
export type CreateKitRequestInput = z.infer<typeof createKitRequestSchema>;

// PER-LINE fulfilment source. Requested stock is rarely all in one place — the warehouse may hold
// some items while another engineer's van holds the rest — so each line names its own source:
//   warehouse → warehouseId required (IRM lines; misc/customer-stock derive or need none)
//   engineer  → engineerId required (that line joins the transfer opened from that engineer)
// A line MAY be split across both: `engineerQty` says how many units come off the van, and the
// remainder is collected from `warehouseId`. Omit engineerQty and the whole line comes from the one
// source, which is the original behaviour.
//
// The split exists because either/or had no answer for the common case — 5 requested, 2 on the shelf,
// 29 on a colleague's van: the warehouse can't cover it, and taking all 5 off the van strips someone
// who may need them. The kit line already merges sources downstream (see the note on
// findVanSourcesByKitLines), so this only removes an artificial limit in the review step.
//
// engineerQty is NOT bounded against the line here — the schema can't see the request's quantities.
// approve() owns that check, where the lines are loaded.
const lineSourceSchema = z
  .object({
    requestLineId: objectId,
    sourceType: z.enum(["warehouse", "engineer"]),
    warehouseId: objectId.optional(),
    engineerId: objectId.optional(),
    engineerQty: z.number().int().positive().optional(),
    // The reviewer's TRIM: approve fewer than were asked for. Absent ⇒ the full requested quantity.
    // ZERO is meaningful and deliberately allowed — it EXCLUDES the line, letting a planner refuse one
    // item while approving the rest instead of declining the whole request. Not bounded above here;
    // the schema can't see the request, so approve() checks it against the line.
    approvedQty: z.number().int().min(0).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.sourceType === "engineer" && !v.engineerId) {
      ctx.addIssue({ code: "custom", path: ["engineerId"], message: "Pick the engineer to transfer this item from." });
    }
    if (v.sourceType === "warehouse" && v.engineerQty !== undefined) {
      ctx.addIssue({ code: "custom", path: ["engineerQty"], message: "A warehouse line can't take part of its quantity from a van." });
    }
  });

export const approveKitRequestSchema = z
  .object({
    // Legacy request-level mode. Optional now that sources are chosen per line — kept so older
    // clients (and the all-warehouse / all-transfer shorthand) keep working unchanged.
    fulfillmentMode: z.enum(["warehouse_issue", "engineer_transfer"]).optional(),
    // Warehouse-issue mode: the pickup warehouse chosen PER IRM request line (requestLineId → warehouseId),
    // so different items can be collected from different warehouses. Customer-stock lines derive their
    // warehouse from the stock entry; misc lines have none. Ignored in engineer-transfer mode.
    lineWarehouses: z.array(z.object({ requestLineId: objectId, warehouseId: objectId })).max(100).optional(),
    // Engineer-transfer mode: the engineer to pull stock from (must hold every stock-tracked line). No
    // warehouse is involved — the stock comes from their van.
    fromEngineerId: objectId.optional(),
    // Per-line sources — the preferred shape. When present it fully describes the fulfilment and
    // takes precedence over fulfillmentMode/lineWarehouses/fromEngineerId.
    lineSources: z.array(lineSourceSchema).max(100).optional(),
    decisionNote: z.string().trim().max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    // Exactly one shape must describe the fulfilment: per-line sources, or the legacy mode.
    if (!v.lineSources?.length && !v.fulfillmentMode) {
      ctx.addIssue({ code: "custom", path: ["lineSources"], message: "Choose where each item will be fulfilled from." });
      return;
    }
    if (!v.lineSources?.length && v.fulfillmentMode === "engineer_transfer" && !v.fromEngineerId) {
      ctx.addIssue({ code: "custom", path: ["fromEngineerId"], message: "Pick the engineer to transfer stock from." });
    }
    // One source per request line — a duplicate would make the winning source ambiguous.
    if (v.lineSources?.length) {
      const seen = new Set<string>();
      v.lineSources.forEach((l, i) => {
        if (seen.has(l.requestLineId)) {
          ctx.addIssue({ code: "custom", path: ["lineSources", i], message: "This item has two sources — choose one." });
        }
        seen.add(l.requestLineId);
      });
    }
  });
export type ApproveKitRequestInput = z.infer<typeof approveKitRequestSchema>;

export const declineKitRequestSchema = z.object({
  decisionNote: z.string().trim().max(2000).optional(),
});
export type DeclineKitRequestInput = z.infer<typeof declineKitRequestSchema>;
