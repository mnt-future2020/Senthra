import { z } from "zod";
import { attachmentTypeMatches, dataUriBytes } from "../../utils/data-uri.js";

// Purchase Order validation. PROCUREMENT WORKFLOW ONLY. Codes/status/totals are SYSTEM-owned
// and never accepted from the client. Editable only in `draft` (enforced in the service).
// Required on create: supplier, delivery warehouse, order date, expected delivery date, and
// at least one line (qty ≥ 1, unit price ≥ 0). Money is integer GBP pence.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export const PO_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const PO_ATTACHMENT_TYPES = ["pdf", "docx", "png", "jpg"] as const;

// Delivery Terms — the practical UK subset of Incoterms 2020 (the terms actually used in UK
// material procurement; the maritime-only terms FAS/FOB/CFR/CIF are intentionally excluded).
// `code` is stored on the PO/PRF; `label` is the human name shown in the UI + printed on the PO.
// Ordered most-common-first for UK-domestic buying (DDP = supplier delivers all-in to our door).
export const INCOTERMS = [
  { code: "DDP", label: "DDP — Delivered Duty Paid" },
  { code: "DAP", label: "DAP — Delivered at Place" },
  { code: "DPU", label: "DPU — Delivered at Place Unloaded" },
  { code: "FCA", label: "FCA — Free Carrier" },
  { code: "CPT", label: "CPT — Carriage Paid To" },
  { code: "CIP", label: "CIP — Carriage and Insurance Paid To" },
  { code: "EXW", label: "EXW — Ex Works" },
] as const;
export const INCOTERM_CODES = INCOTERMS.map((t) => t.code) as unknown as [string, ...string[]];
// Resolve a stored code to its printable label (falls back to the raw code if unknown).
export const incotermLabel = (code: string | null | undefined): string =>
  INCOTERMS.find((t) => t.code === code)?.label ?? (code ?? "");

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
}).refine(
  // Keep quantity × unit price within JS's safe-integer range so the line total (and the totals
  // summed from it) stay EXACT — the per-field maxes alone (1e7 × 1e9 = 1e16) can exceed it.
  (l) => l.quantity * l.unitPricePence <= Number.MAX_SAFE_INTEGER,
  { message: "This line total is too large. Reduce the quantity or unit price.", path: ["unitPricePence"] },
);
export type POLineInput = z.infer<typeof lineSchema>;

const noDupItems = (lines: { irmItemId: string }[]) => {
  const ids = lines.map((l) => l.irmItemId);
  return new Set(ids).size === ids.length;
};
const itemsField = z
  .array(lineSchema)
  .min(1, "Add at least one item.")
  .refine(noDupItems, { message: "Each item can only be added once." });

// The same lines on an EDIT, where an empty array is legitimate: an order converted from a
// hire-only request has no IRM lines at all, and `.min(1)` made it impossible to edit. "Must still
// have a line of some kind" is enforced in the service, which can see the rental lines too.
const editableItemsField = z
  .array(lineSchema)
  .refine(noDupItems, { message: "Each item can only be added once." });

// Shared optional header fields.
const sharedHeader = {
  referenceNumber: z.string().trim().max(60).optional(),
  description: z.string().trim().max(2000).optional(),
  priority: z.preprocess(emptyToUndef, z.enum(PO_PRIORITIES).optional()),
  // Project reference — an optional Job link plus a free-text fallback. `.nullable()` so an EDIT
  // can explicitly CLEAR the link: the form sends `null` (not omitted), which reaches the service
  // and unsets the field. `emptyToUndef` only strips empty strings, so `null` passes through.
  jobId: z.preprocess(emptyToUndef, z.string().regex(OBJECT_ID_RE, "Select a job.").nullable().optional()),
  projectRef: z.string().trim().max(120).optional(),
  deliveryAddress: z.string().trim().max(300).optional(),
  deliveryInstructions: z.string().trim().max(500).optional(),
  // Commercial terms — Incoterm code (validated against the UK subset) + agreed payment term text.
  // `.nullable()` on both for the same clear-on-edit reason as jobId above.
  deliveryTerms: z.preprocess(emptyToUndef, z.enum(INCOTERM_CODES).nullable().optional()),
  paymentTerms: z.string().trim().max(100).nullable().optional(),
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
    items: editableItemsField.optional(),
  })
  .refine(datesOk, datesError);
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>;

// --- workflow action bodies -------------------------------------------------
export const poRejectSchema = z.object({
  reason: z.string({ error: "A reason is required." }).trim().min(1, "A reason is required.").max(500),
});
export type PoRejectInput = z.infer<typeof poRejectSchema>;

// Cancellation reason is MANDATORY (explicit cancellation matrix — the reason is audited and,
// on an already-issued order, referenced by the supplier cancellation email).
export const poCancelSchema = z.object({
  reason: z.string({ error: "A reason is required." }).trim().min(1, "A reason is required.").max(500),
});
export type PoCancelInput = z.infer<typeof poCancelSchema>;

// --- PM routing (approved → pm_review; re-assign while in pm_review) ---------
export const poAssignPmSchema = z.object({
  pmUserId: z.string({ error: "Select a project manager." }).regex(OBJECT_ID_RE, "Select a project manager."),
});
export type PoAssignPmInput = z.infer<typeof poAssignPmSchema>;

// --- supplier acceptance (sent → supplier_accepted) --------------------------
const optionalDateField = z.preprocess(
  emptyToUndef,
  z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date.")
    .optional(),
);
export const poSupplierAcceptSchema = z
  .object({
    acceptedDate: optionalDateField, // defaults to "now" server-side
    // CONDITIONALLY required, and the condition is the order's STATUS — which a body schema cannot
    // see, so the service enforces it (recordSupplierAcceptance).
    //
    // On an order still awaiting delivery it is mandatory: accepting means committing to a date, and
    // that date is what the warehouse plans against. Once the goods are IN there is nothing left to
    // plan against, the real arrival is already on the receipt, and demanding a "confirmed delivery
    // date" invites somebody to type the date it actually turned up — filing an arrival under a field
    // that means "what the supplier promised". A late acknowledgement is about the reference and the
    // notes; the promise is optional history.
    confirmedDeliveryDate: optionalDateField,
    supplierAckReference: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  // A confirmed delivery date can't precede the acceptance date (a supplier can't promise to
  // deliver BEFORE they accepted). This is a DATE-ONLY comparison: both sides are compared at the
  // day level so "accept today, deliver today" is allowed. When acceptedDate is omitted the server
  // stamps "now" — but we must compare against TODAY'S DATE, not the current instant, or a same-day
  // confirmed delivery (parsed to 00:00 UTC) would be wrongly rejected as "before" a mid-day now.
  .refine(
    (d) => {
      if (!d.confirmedDeliveryDate) return true;
      const dayStart = (v: string) => Date.parse(v.slice(0, 10)); // normalise to the date's 00:00 UTC
      const confirmed = dayStart(d.confirmedDeliveryDate);
      const accepted = d.acceptedDate ? dayStart(d.acceptedDate) : dayStart(new Date().toISOString());
      return Number.isNaN(confirmed) || Number.isNaN(accepted) || confirmed >= accepted;
    },
    { message: "Confirmed delivery date can't be before the acceptance date.", path: ["confirmedDeliveryDate"] },
  );
export type PoSupplierAcceptInput = z.infer<typeof poSupplierAcceptSchema>;

// --- confirmed-delivery-date revision (any non-terminal PO that already has one; audited) -----
export const poDeliveryDateSchema = z.object({
  confirmedDeliveryDate: requiredDate("Confirmed delivery date"),
  reason: z.string().trim().max(500).optional(),
});
export type PoDeliveryDateInput = z.infer<typeof poDeliveryDateSchema>;

// --- attachment upload (data URI from the form) -----------------------------
const TEN_MB = 10 * 1024 * 1024;

/**
 * How many USER documents one purchase order may carry.
 *
 * Higher than the PRF's ten, and deliberately so: conversion copies a full PRF's attachments onto the
 * order, so a cap equal to the PRF's would be exhausted the moment the PO existed — the buyer could
 * never attach the supplier's confirmation, the invoice, or a delivery note. Twenty absorbs a complete
 * quotation package and still leaves a working budget for the order's own life.
 *
 * The archived issued-PO document is EXCLUDED from this count. It is written by the system at send
 * time, fire-and-forget, and its failure is deliberately silent — so a cap that could consume its slot
 * would quietly leave an order with no document of record.
 */
export const PO_ATTACHMENT_MAX_COUNT = 20;

/**
 * And the byte ceiling for those twenty, on the same reasoning as the count: higher than the PRF's
 * because conversion copies a full request's documents onto the order, so a PO that inherited 40 MB
 * must still have room for the supplier's confirmation and the invoice.
 *
 * The archived issued-PO document is excluded here as well — it is written by the system, its failure
 * is silent, and a total that could consume its allowance would leave an order with no document of
 * record for exactly the reason the count cap already guards against.
 */
export const PO_ATTACHMENT_MAX_TOTAL_BYTES = 80 * 1024 * 1024;
// The declared `fileType` and `fileSizeBytes` above are the CALLER'S CLAIMS about a payload the
// server used to never open — so "pdf, 40 KB" would carry anything, at any size. Both are now
// settled against `data` itself:
//
//   size  measured from the payload, so the per-file ceiling above is real. It also makes the
//         PO total a cap that holds, since that total is summed from stored sizes.
//   type  read from the file's leading bytes (%PDF-, PK, PNG, JPEG), not from the URI's media type
//         — that media type is text the caller wrote, so checking it only relocates the claim.
//
// Refined on the OBJECT rather than the `data` field because both checks compare two fields. Each
// reports against the field the user can act on.
export const poAttachmentSchema = z.object({
  label: z.string().trim().max(80).optional(),
  fileName: z.string().trim().min(1, "File name is required.").max(200),
  fileType: z.enum(PO_ATTACHMENT_TYPES, { error: "Unsupported file type. Use PDF, DOCX, PNG or JPG." }),
  fileSizeBytes: z.coerce.number().int().min(1).max(TEN_MB, "File must be 10 MB or smaller."),
  data: z.string().startsWith("data:", "Upload a valid file."),
})
  .superRefine((v, ctx) => {
    const actual = dataUriBytes(v.data);
    if (actual === 0) {
      ctx.addIssue({ code: "custom", path: ["data"], message: "Upload a valid file." });
      return;
    }
    if (actual > TEN_MB) {
      ctx.addIssue({ code: "custom", path: ["data"], message: "File must be 10 MB or smaller." });
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
export type PoAttachmentInput = z.infer<typeof poAttachmentSchema>;

// ── Rental hire actions ───────────────────────────────────────────────────────────────────────
// `hireStatus` is never client-settable as a free string — "return" is its own endpoint, so the
// only transition a caller can ask for is the one that endpoint performs.

export const extendHireSchema = z.object({
  hireEndDate: z.string({ error: "Select a new hire end date." }).refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date."),
  // Optional: extending may also change how much warning the new deadline gets. Same 0–365 sanity
  // range as the PRF line — a lead longer than the hire is clamped, not refused.
  notifyDaysBefore: z.coerce.number().int().min(0, "Reminder days must be between 0 and 365.").max(365, "Reminder days must be between 0 and 365.").optional(),
  // What the extension was AGREED at, when that is not what the rate calculates — the supplier may
  // quote the extra days differently, and on the `total` basis there is no rate to calculate from at
  // all. Absent means "use the calculated figure".
  additionalChargePence: z.coerce
    .number()
    .int("The additional charge must be a whole number of pence.")
    .min(0, "The additional charge can't be negative.")
    .max(1_000_000_000)
    .optional(),
});
export type ExtendHireInput = z.infer<typeof extendHireSchema>;

// Closing a hire short — the outstanding units are never arriving.
//
// The reason is REQUIRED and cannot be blank, exactly as it is on a customer stock assignment's short
// close: this write is the only record that the shortfall was a decision rather than an oversight,
// and "where did the other three go?" is the one question anyone asks of the line afterwards.
export const closeHireShortSchema = z.object({
  reason: z
    .string({ error: "Give a reason for closing this hire short." })
    .trim()
    .min(1, "Give a reason for closing this hire short.")
    .max(500, "Keep the reason under 500 characters."),
});
export type CloseHireShortInput = z.infer<typeof closeHireShortSchema>;
