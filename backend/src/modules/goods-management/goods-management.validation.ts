import { z } from "zod";

// Goods Management validation. Codes/status/snapshots are SYSTEM-owned (never from the client).
// direction issue/return are WM scan posts; consume is engineer-declared (handled in the job module).
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
// "Not provided" arrives in three shapes from a JSON client: absent, "" (an untouched text input),
// and null (an explicitly-inapplicable field — e.g. the damage report sends customerStockEntryId:
// null on a COMPANY report, since a damaged balance is keyed with exactly one owner socket set).
// All three must normalise to undefined before `.optional()` sees them, or null falls through and
// fails with "expected string, received null" on a field the caller correctly left empty.
const emptyToUndef = (v: unknown) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v);
const objectId = (label: string) => z.string({ error: `Select ${label}.` }).regex(OBJECT_ID_RE, `Select ${label}.`);
const optionalObjectId = (label: string) => z.preprocess(emptyToUndef, z.string().regex(OBJECT_ID_RE, `Select ${label}.`).optional());

export const MOVEMENT_DIRECTIONS = ["issue", "return"] as const; // consume is engineer-only (job module)
export const LINE_SOURCES = ["irm", "customer", "rental", "misc"] as const; // misc = free-text kit line, no stock/barcode
export const LINE_CONDITIONS = ["good", "damaged"] as const;

export const scanLookupSchema = z.object({
  jobId: objectId("a job"),
  warehouseId: objectId("a warehouse"), // the warehouse the WM is issuing/receiving FROM
  direction: z.enum(MOVEMENT_DIRECTIONS, { error: "Pick a direction." }),
  code: z.string({ error: "Scan or enter a code." }).trim().min(1, "Scan or enter a code.").max(120),
});
export type ScanLookupInput = z.infer<typeof scanLookupSchema>;

const movementLineSchema = z
  .object({
    source: z.enum(LINE_SOURCES, { error: "Pick a source." }),
    irmItemId: optionalObjectId("an IRM item"),
    customerStockEntryId: optionalObjectId("a customer stock item"),
    rentalItemId: optionalObjectId("a rental item"),
    // WHICH HIRE these units come off. Server-resolved on a scan (the allocator picks the hire whose
    // deadline is soonest) and echoed back by the client on post, so the units committed are the ones
    // the scan previewed. Never invented by the client: an id naming a hire at another warehouse, or
    // one with nothing left on it, is refused in the service.
    purchaseOrderRentalLineId: optionalObjectId("a hire"),
    jobKitLineId: optionalObjectId("a kit line"),
    qty: z.coerce.number({ error: "Quantity is required." }).int("Whole number.").min(1, "At least 1.").max(10_000_000),
    condition: z.enum(LINE_CONDITIONS).optional(), // returns only; defaults to "good" server-side
    scannedCode: z.string().trim().max(120).optional(),
    damagePhotoUrl: z.string().trim().max(2000).optional(),
    damageReason: z.string().trim().max(500).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .superRefine((l, ctx) => {
    if (l.source === "irm" && !l.irmItemId) ctx.addIssue({ code: "custom", path: ["irmItemId"], message: "Select an IRM item." });
    if (l.source === "customer" && !l.customerStockEntryId) ctx.addIssue({ code: "custom", path: ["customerStockEntryId"], message: "Select a customer stock item." });
    if (l.source === "rental") {
      if (!l.rentalItemId) ctx.addIssue({ code: "custom", path: ["rentalItemId"], message: "Select a rental item." });
      // The hire is REQUIRED on a rental line, unlike every other id here, because a hire is what
      // carries the deadline and the provider we owe the kit back to. A movement that recorded only
      // the catalogue item would move units belonging to no particular hire, and the return could
      // then credit the wrong one — leaving a hire that was handed back sitting on the overdue badge
      // while a hire still in a van reads as settled.
      if (!l.purchaseOrderRentalLineId) ctx.addIssue({ code: "custom", path: ["purchaseOrderRentalLineId"], message: "Select which hire these units come from." });
      // The KIT LINE is required too, and rental is the only stock source where it has to be. Every
      // tally that decides whether a hire is still out — the queue, the job pack, the reconcile guard
      // — is keyed by jobKitLineId, so a movement stored with a null one is invisible to all of them:
      // the units come back physically, the line still reads as outstanding forever, and the job can
      // never reconcile. IRM survives that mistake because it can be written off as lost; a hire
      // cannot, by design, so for rental it is unrecoverable. The scan always supplies it.
      if (!l.jobKitLineId) ctx.addIssue({ code: "custom", path: ["jobKitLineId"], message: "Select which kit line these units come off." });
    }
    // misc lines reference only their kit line (no barcode/stock) — issued by count, not scan.
    if (l.source === "misc" && !l.jobKitLineId) ctx.addIssue({ code: "custom", path: ["jobKitLineId"], message: "Select a misc kit line." });
    if (l.condition === "damaged") {
      if (!l.damagePhotoUrl) ctx.addIssue({ code: "custom", path: ["damagePhotoUrl"], message: "Attach a photo of the damage." });
      if (!l.damageReason) ctx.addIssue({ code: "custom", path: ["damageReason"], message: "Give a reason for the damage." });
    }
  });
export type MovementLineInput = z.infer<typeof movementLineSchema>;

export const postMovementSchema = z.object({
  direction: z.enum(MOVEMENT_DIRECTIONS, { error: "Pick a direction." }),
  warehouseId: objectId("a warehouse"), // the warehouse the WM is issuing/receiving FROM
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(movementLineSchema).min(1, "Scan at least one item.").max(500),
});
export type PostMovementInput = z.infer<typeof postMovementSchema>;

// Damage-photo upload: the raw data URI from the client, uploaded server-side to Cloudinary.
// ~15 MB cap (base64 inflates ~33%, so this allows ≈11 MB of binary data — more than enough
// for a mobile photo taken at medium quality).
const MAX_DAMAGE_PHOTO_CHARS = 15_000_000;
export const uploadDamagePhotoSchema = z.object({
  image: z
    .string({ error: "Image is required." })
    .max(MAX_DAMAGE_PHOTO_CHARS, "Image is too large (max ~10 MB).")
    .regex(
      /^data:image\/(png|jpe?g|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,/i,
      "Image must be a base64 data URI (PNG, JPG, GIF, WEBP, SVG or ICO).",
    ),
});
export type UploadDamagePhotoInput = z.infer<typeof uploadDamagePhotoSchema>;

// Why stock is being booked as lost. A fixed list rather than free text because these repeat and
// because free text collects the word "lost" — which answers nothing six months later when someone
// asks where the units went. Mirrors STOCK_ADJUST_DOWN_REASONS' shape (enum + optional notes).
// NOTE: there is deliberately no "damaged" reason here. Damaged stock has its own route — return it on
// the Goods In side with a damaged portion (photo + reason required), which posts it to the damaged
// pool where it can back a supplier or insurance claim and can be restored. Writing it off as LOST
// records `condition: "lost"`, so the units never reach that pool and the evidence trail is gone. An
// option saying "damaged beyond recovery" would quietly steer people out of the flow built for it.
export const WRITE_OFF_REASONS = [
  "not_returned",
  "lost_in_transit",
  "engineer_left",
  "site_theft",
  "other",
] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

export const closeReconcileSchema = z
  .object({
    writeOffLost: z.boolean().optional(), // book any unaccounted units as lost on close
    writeOffReason: z.enum(WRITE_OFF_REASONS).optional(),
    writeOffNotes: z.string().trim().max(2000).optional(),
    /**
     * The request is the OVERDUE TAB's escape hatch, not an everyday close.
     *
     * Both screens post here, so without this marker the relaxation written for the Overdue tab (see
     * closeReconcile) also reached the warehouse scan panel, where it could reconcile — and write off —
     * a job the engineer is still working, locking it against any further issue or return.
     *
     * A routing marker, NEVER an override: the service still reads the window from Settings and checks
     * the job's own issue movements against it, so this cannot close a job that isn't genuinely overdue.
     */
    fromOverdue: z.boolean().optional(),
  })
  // Writing stock off as lost is irreversible (the job locks) and is a real financial loss, so it may
  // not happen anonymously. Every other destructive stock action here — report damage, close a delivery
  // short, adjust stock down — already demands a reason; this was the one exception.
  .superRefine((v, ctx) => {
    if (!v.writeOffLost) return;
    if (!v.writeOffReason) {
      ctx.addIssue({ code: "custom", path: ["writeOffReason"], message: "Select why this stock is being written off." });
    }
    // "Other" without a note is the same dead end as free text defaulting to "lost".
    if (v.writeOffReason === "other" && !v.writeOffNotes?.trim()) {
      ctx.addIssue({ code: "custom", path: ["writeOffNotes"], message: "Describe the reason when choosing Other." });
    }
  });
export type CloseReconcileInput = z.infer<typeof closeReconcileSchema>;

// Restore damaged stock back to usable pool (reversal of a write-off).
// Exactly one of irmItemId (company) or customerStockEntryId (customer) is required.
export const restoreDamagedSchema = z
  .object({
    warehouseId: objectId("a warehouse"),
    ownerType: z.enum(["company", "customer"], { error: "ownerType must be 'company' or 'customer'." }),
    irmItemId: optionalObjectId("an IRM item"),
    customerStockEntryId: optionalObjectId("a customer stock entry"),
    quantity: z.coerce
      .number({ error: "Quantity is required." })
      .int("Use a whole number.")
      .min(1, "Quantity must be at least 1.")
      .max(1_000_000),
    notes: z.string({ error: "Notes are required." }).trim().min(1, "Notes are required.").max(2000),
  })
  .superRefine((v, ctx) => {
    if (v.ownerType === "company" && !v.irmItemId) {
      ctx.addIssue({ code: "custom", path: ["irmItemId"], message: "Select an IRM item for company-owned stock." });
    }
    if (v.ownerType === "customer" && !v.customerStockEntryId) {
      ctx.addIssue({ code: "custom", path: ["customerStockEntryId"], message: "Select a customer stock entry for customer-owned stock." });
    }
  });
export type RestoreDamagedInput = z.infer<typeof restoreDamagedSchema>;

// Report damage on stock ALREADY SITTING in a warehouse — the forklift-through-a-box case. Until
// this existed the damaged pool could only be fed by a field return (a job return or a van return),
// so damage discovered in our own racking had no correct home: operators reached for Adjust Stock →
// "damage correction", which silently removed the units from inventory WITHOUT creating a damaged
// row, a photo or an evidence trail. That reason has been retired from the adjust flow in favour of
// this one (see STOCK_ADJUST_DOWN_REASONS).
//
// `reason` and `damagePhotoUrl` are REQUIRED, exactly as they are on a damaged return line
// (movementLineSchema above). The damaged pool's whole purpose is retrievable evidence for a
// supplier claim, an insurance claim or a customer dispute — an entry point that let either be
// skipped would quietly hollow that out.
export const reportDamageSchema = z
  .object({
    warehouseId: objectId("a warehouse"),
    ownerType: z.enum(["company", "customer"], { error: "ownerType must be 'company' or 'customer'." }),
    irmItemId: optionalObjectId("an IRM item"),
    customerStockEntryId: optionalObjectId("a customer stock entry"),
    quantity: z.coerce
      .number({ error: "Quantity is required." })
      .int("Use a whole number.")
      .min(1, "Quantity must be at least 1.")
      .max(1_000_000),
    reason: z.string({ error: "Give a reason for the damage." }).trim().min(1, "Give a reason for the damage.").max(500),
    damagePhotoUrl: z.string({ error: "Attach a photo of the damage." }).trim().min(1, "Attach a photo of the damage.").max(2000),
    notes: z.string().trim().max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    // ownerType decides WHICH id is required — a damaged balance is keyed with exactly one of the
    // two sockets set, so accepting the wrong one would silently target a different (or no) row.
    if (v.ownerType === "company" && !v.irmItemId) {
      ctx.addIssue({ code: "custom", path: ["irmItemId"], message: "Select an IRM item for company-owned stock." });
    }
    if (v.ownerType === "customer" && !v.customerStockEntryId) {
      ctx.addIssue({ code: "custom", path: ["customerStockEntryId"], message: "Select a customer stock entry for customer-owned stock." });
    }
  });
export type ReportDamageInput = z.infer<typeof reportDamageSchema>;
