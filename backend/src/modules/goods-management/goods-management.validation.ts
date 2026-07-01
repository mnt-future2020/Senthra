import { z } from "zod";

// Goods Management validation. Codes/status/snapshots are SYSTEM-owned (never from the client).
// direction issue/return are WM scan posts; consume is engineer-declared (handled in the job module).
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const objectId = (label: string) => z.string({ error: `Select ${label}.` }).regex(OBJECT_ID_RE, `Select ${label}.`);
const optionalObjectId = (label: string) => z.preprocess(emptyToUndef, z.string().regex(OBJECT_ID_RE, `Select ${label}.`).optional());

export const MOVEMENT_DIRECTIONS = ["issue", "return"] as const; // consume is engineer-only (job module)
export const LINE_SOURCES = ["irm", "customer", "misc"] as const; // misc = free-text kit line, no stock/barcode
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

export const closeReconcileSchema = z.object({
  writeOffLost: z.boolean().optional(), // book any unaccounted units as lost on close
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
