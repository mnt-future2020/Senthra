import { z } from "zod";

// Purchase Request (PRF) validation. Codes/status/totals are SYSTEM-owned and never accepted
// from the client; sourceType/sourceId are provenance fields reserved for future request-module
// integrations and are likewise never client-settable. Editable only in `draft` (enforced in
// the service). Required on create: supplier, delivery warehouse, and at least one line
// (qty ≥ 1, quoted unit price ≥ 0). Money is integer GBP pence.

import { INCOTERM_CODES } from "#modules/purchase-order/purchase-order.validation.js";
import { attachmentTypeMatches, dataUriBytes } from "../../utils/data-uri.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export const PRF_ATTACHMENT_TYPES = ["pdf", "docx", "png", "jpg"] as const;

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
    .nullable() // allow an explicit null to CLEAR the date on edit
    .optional(),
);

// One PRF line. Unit price is the QUOTED price, collected in PENCE (the form holds £ and converts).
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
  // carried onto the PO) stay EXACT — matches the PO line rule.
  (l) => l.quantity * l.unitPricePence <= Number.MAX_SAFE_INTEGER,
  { message: "This line total is too large. Reduce the quantity or unit price.", path: ["unitPricePence"] },
);
export type PrfLineInput = z.infer<typeof lineSchema>;

const noDupItems = (lines: { irmItemId: string }[]) => {
  const ids = lines.map((l) => l.irmItemId);
  return new Set(ids).size === ids.length;
};
const itemsField = z
  .array(lineSchema)
  .min(1, "Add at least one item.")
  .refine(noDupItems, { message: "Each item can only be added once." });

// ── Reorder-workbench generation ──────────────────────────────────────────────
// The confirmed workbench rows. The service re-validates and CAPS each row against the LIVE
// suggestions before creating anything (stale/concurrency guard), so quantity here is a request,
// not an entitlement. itemName/warehouseName are display-only echoes used to label rows the
// revalidation skips (they never reach the database). No duplicate item × warehouse pair —
// a PRF line is unique per item and each pair maps to exactly one row.
const reorderRowSchema = z.object({
  irmItemId: z.string().regex(OBJECT_ID_RE, "Select an item."),
  warehouseId: z.string().regex(OBJECT_ID_RE, "Select a warehouse."),
  supplierId: z.string().regex(OBJECT_ID_RE, "Select a supplier."),
  quantity: z.coerce.number({ error: "Quantity is required." }).int("Use a whole number.").min(1).max(10_000_000),
  itemName: z.string().trim().max(200).optional(),
  warehouseName: z.string().trim().max(200).optional(),
});
export const generateReorderSchema = z.object({
  rows: z
    .array(reorderRowSchema)
    .min(1, "Select at least one row.")
    .max(200, "Generate at most 200 rows at a time.")
    .refine(
      (rows) => new Set(rows.map((r) => `${r.irmItemId}|${r.warehouseId}`)).size === rows.length,
      { message: "Each item × warehouse can only be selected once." },
    ),
  requiredByDate: z.preprocess(
    emptyToUndef,
    z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid required-by date.").optional(),
  ),
});
export type GenerateReorderInput = z.infer<typeof generateReorderSchema>;

// Quote validity can't precede the quote date (when both are present).
const quoteDatesOk = (d: { quoteDate?: string | null; quoteValidUntil?: string | null }) => {
  if (!d.quoteDate || !d.quoteValidUntil) return true;
  const qd = Date.parse(d.quoteDate);
  const vu = Date.parse(d.quoteValidUntil);
  return Number.isNaN(qd) || Number.isNaN(vu) || vu >= qd;
};
const quoteDatesError = { message: "Quote validity can't end before the quote date.", path: ["quoteValidUntil"] as string[] };

// Shared optional header fields.
const sharedHeader = {
  // `.nullable()` on jobId + deliveryTerms so an EDIT can explicitly CLEAR them (the form sends
  // `null`, which passes through emptyToUndef and unsets the field in the service).
  jobId: z.preprocess(emptyToUndef, z.string().regex(OBJECT_ID_RE, "Select a job.").nullable().optional()),
  projectRef: z.string().trim().max(120).optional(),
  quoteReference: z.string().trim().max(120).optional(),
  quoteDate: optionalDate,
  quoteValidUntil: optionalDate,
  justification: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(2000).optional(),
  // Commercial terms from the quote — carried onto the PO at conversion.
  deliveryTerms: z.preprocess(emptyToUndef, z.enum(INCOTERM_CODES).nullable().optional()),
  paymentTerms: z.string().trim().max(100).nullable().optional(),
};

export const createPurchaseRequestSchema = z
  .object({
    supplierId: z.string({ error: "Select a supplier." }).regex(OBJECT_ID_RE, "Select a supplier."),
    warehouseId: z
      .string({ error: "Select a delivery warehouse." })
      .regex(OBJECT_ID_RE, "Select a delivery warehouse."),
    // REQUIRED: when the goods are needed on site. This becomes the generated PO's expected
    // delivery date — nothing else derives it, so without it a PO would be born dateless and
    // stuck (it can't be approved or sent). Editable later while the PRF is still a draft.
    requiredByDate: requiredDate("Required-by date"),
    ...sharedHeader,
    items: itemsField,
  })
  .refine(quoteDatesOk, quoteDatesError);
export type CreatePurchaseRequestInput = z.infer<typeof createPurchaseRequestSchema>;

// Update = a full DRAFT re-save (the service blocks edits on any non-draft PRF).
export const updatePurchaseRequestSchema = z
  .object({
    supplierId: z.preprocess(emptyToUndef, z.string().regex(OBJECT_ID_RE, "Select a supplier.").optional()),
    warehouseId: z.preprocess(
      emptyToUndef,
      z.string().regex(OBJECT_ID_RE, "Select a delivery warehouse.").optional(),
    ),
    // Optional on PATCH ("leave unchanged") but NOT nullable — once set it can be moved, never
    // cleared back to nothing, since conversion has no other source for the PO's delivery date.
    requiredByDate: z.preprocess(
      emptyToUndef,
      z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid required-by date.").optional(),
    ),
    ...sharedHeader,
    items: itemsField.optional(),
  })
  .refine(quoteDatesOk, quoteDatesError);
export type UpdatePurchaseRequestInput = z.infer<typeof updatePurchaseRequestSchema>;

// --- workflow action bodies -------------------------------------------------
export const prfRejectSchema = z.object({
  reason: z.string({ error: "A reason is required." }).trim().min(1, "A reason is required.").max(500),
});
export type PrfRejectInput = z.infer<typeof prfRejectSchema>;

// Reopen-for-revision (approved → draft) — a reason is mandatory (audit trail of WHY the
// approved request was revised, per the price-revision workflow).
export const prfReopenSchema = z.object({
  reason: z.string({ error: "A reason is required." }).trim().min(1, "A reason is required.").max(500),
});
export type PrfReopenInput = z.infer<typeof prfReopenSchema>;

export const prfCancelSchema = z.object({ reason: z.string().trim().max(500).optional() });
export type PrfCancelInput = z.infer<typeof prfCancelSchema>;

// --- attachment upload (data URI from the form) -----------------------------
const TEN_MB = 10 * 1024 * 1024;

/**
 * How many documents one purchase request may carry.
 *
 * NOT copied from the GRN's 5. A PRF is raised against ONE supplier and its attachments are that
 * supplier's quotation package — the quote, a revision, a datasheet, a spec sheet, sometimes the email
 * it arrived in. Ten leaves room for a thorough package while keeping the collection bounded: the
 * detail read loads every attachment on the record, so an unbounded array degrades the one screen a
 * buyer opens most.
 *
 * It also sets the floor for the PO's cap — conversion COPIES these rows onto the order, so the PO
 * must be able to absorb a full PRF and still accept its own documents. See PO_ATTACHMENT_MAX_COUNT.
 */
export const PRF_ATTACHMENT_MAX_COUNT = 10;

/**
 * And how many BYTES those ten may add up to.
 *
 * The count alone leaves a gap the GRN does not have: ten files at the 10 MB per-file ceiling is 100 MB
 * on one request. A quotation package is PDFs — a quote is typically well under 2 MB — so 40 MB is
 * roughly double a realistic worst case while keeping a single record's storage bounded.
 *
 * Summed from the sizes already stored, which are MEASURED from the payload rather than declared, so
 * this is a ceiling that actually holds.
 */
export const PRF_ATTACHMENT_MAX_TOTAL_BYTES = 40 * 1024 * 1024;
// The declared `fileType` and `fileSizeBytes` above are the CALLER'S CLAIMS about a payload the
// server used to never open — so "pdf, 40 KB" would carry anything, at any size. Both are now
// settled against `data` itself:
//
//   size  measured from the payload, so the per-file ceiling above is real. It also makes the
//         PRF total a cap that holds, since that total is summed from stored sizes.
//   type  read from the file's leading bytes (%PDF-, PK, PNG, JPEG), not from the URI's media type
//         — that media type is text the caller wrote, so checking it only relocates the claim.
//
// Refined on the OBJECT rather than the `data` field because both checks compare two fields. Each
// reports against the field the user can act on.
export const prfAttachmentSchema = z.object({
  label: z.string().trim().max(80).optional(),
  fileName: z.string().trim().min(1, "File name is required.").max(200),
  fileType: z.enum(PRF_ATTACHMENT_TYPES, { error: "Unsupported file type. Use PDF, DOCX, PNG or JPG." }),
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
export type PrfAttachmentInput = z.infer<typeof prfAttachmentSchema>;
