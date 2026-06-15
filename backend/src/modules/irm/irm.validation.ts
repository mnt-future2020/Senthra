import { z } from "zod";

// IRM Catalogue item validation. Company-owned internal stock MASTER DATA. Code is
// auto-allocated (IRM-0001). Type + Category reference the IRM masters (NOT the customer
// Category). Cost is collected in POUNDS here and stored as integer pence by the service.
//
// REQUIRED on create: name, typeId, irmCategoryId, baseUnit, and at least one supplier with
// exactly one marked primary. On UPDATE everything is optional (partial PATCH) but
// non-empty / valid when sent.

const statusEnum = z.enum(["active", "inactive"]);
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// Units of measure — same list the customer catalogue uses.
export const UOM_OPTIONS = ["Each", "Metre", "Roll", "Pack", "Box", "Set", "Pair", "Reel"] as const;
export const CURRENCY_OPTIONS = ["GBP", "EUR"] as const;

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

// Optional bounded whole number — blank/null → null (clears); absent → undefined (no change).
const optionalInt = (max: number, label: string) =>
  z.preprocess(
    (v) => (v === "" || v === null ? null : v),
    z.coerce
      .number()
      .int(`${label} must be a whole number.`)
      .min(0, `${label} can't be negative.`)
      .max(max)
      .nullable()
      .optional(),
  );

// Internal owner — 3-state: omitted (no change), "" / null (clear), or a valid id.
const ownerIdField = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().regex(OBJECT_ID_RE, "Select a valid owner.").nullable().optional(),
);

const currencyField = z.preprocess(emptyToUndef, z.enum(CURRENCY_OPTIONS).optional());
const baseUnitCreate = z.enum(UOM_OPTIONS, { error: "Select a base unit." });
const baseUnitUpdate = z.preprocess(emptyToUndef, z.enum(UOM_OPTIONS).optional());

const optionalTypeIdField = z.preprocess(
  emptyToUndef,
  z.string().regex(OBJECT_ID_RE, "Select a valid IRM type.").optional(),
);
const optionalCategoryIdField = z.preprocess(
  emptyToUndef,
  z.string().regex(OBJECT_ID_RE, "Select a valid IRM category.").optional(),
);

// Standard cost — collected in POUNDS; the service converts to integer pence.
const standardCostField = z.preprocess(
  (v) => (v === "" || v === null ? null : v),
  z.coerce.number().min(0, "Cost can't be negative.").max(10_000_000, "Cost is too large.").nullable().optional(),
);
const vatField = z.preprocess(
  (v) => (v === "" || v === null ? null : v),
  z.coerce.number().min(0, "VAT can't be negative.").max(100, "VAT must be 0–100%.").nullable().optional(),
);
const packSizeField = z.preprocess(
  (v) => (v === "" || v === null ? null : v),
  z.coerce.number().int("Pack size must be a whole number.").min(1, "Pack size must be at least 1.").max(1_000_000).nullable().optional(),
);
const conversionField = z.preprocess(
  (v) => (v === "" || v === null ? null : v),
  z.coerce.number().positive("Conversion ratio must be greater than 0.").max(1_000_000).nullable().optional(),
);

// One supplier link row (becomes an IrmItemSupplier junction row).
const supplierRowSchema = z.object({
  supplierId: z.string().regex(OBJECT_ID_RE, "Select a supplier."),
  isPrimary: z.boolean().optional(),
  priority: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(0).max(1000).optional()),
  supplierSku: z.string().trim().max(80).optional(),
  leadTimeDays: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(0).max(365).optional()),
});
export type SupplierRowInput = z.infer<typeof supplierRowSchema>;

// Mandatory: at least one supplier, exactly one primary, no duplicate supplier.
const suppliersValid = (arr: { supplierId: string; isPrimary?: boolean }[]) => {
  const ids = arr.map((s) => s.supplierId);
  const noDup = new Set(ids).size === ids.length;
  const primaries = arr.filter((s) => s.isPrimary === true).length;
  return noDup && primaries === 1;
};
const suppliersMessage = "Add at least one supplier and mark exactly one as primary (no duplicates).";
const suppliersCreate = z
  .array(supplierRowSchema)
  .min(1, "Add at least one supplier.")
  .refine(suppliersValid, { message: suppliersMessage });
const suppliersUpdate = z
  .array(supplierRowSchema)
  .min(1, "Add at least one supplier.")
  .refine(suppliersValid, { message: suppliersMessage })
  .optional();

// Shared optional fields (create + update). Required ones are overridden on create.
const sharedIrmFields = {
  description: z.string().trim().max(2000).optional(),
  brand: z.string().trim().max(120).optional(),
  manufacturer: z.string().trim().max(120).optional(),
  mpn: z.string().trim().max(120).optional(),
  typeId: optionalTypeIdField,
  irmCategoryId: optionalCategoryIdField,
  sku: z.string().trim().max(80).optional(),
  barcode: z.string().trim().max(80).optional(),
  qrCode: z.string().trim().max(80).optional(),
  baseUnit: baseUnitUpdate,
  packSize: packSizeField,
  conversionRatio: conversionField,
  minimumStock: optionalInt(1_000_000, "Minimum stock"),
  reorderLevel: optionalInt(1_000_000, "Reorder level"),
  reorderQuantity: optionalInt(1_000_000, "Reorder quantity"),
  maximumStock: optionalInt(1_000_000, "Maximum stock"),
  safetyStock: optionalInt(1_000_000, "Safety stock"),
  criticalLevel: optionalInt(1_000_000, "Critical level"),
  standardCost: standardCostField,
  currency: currencyField,
  vatRatePercent: vatField,
  trackInventory: z.boolean().optional(),
  trackSerialNumbers: z.boolean().optional(),
  trackBatchNumbers: z.boolean().optional(),
  allowNegativeStock: z.boolean().optional(),
  ownerUserId: ownerIdField,
  notes: z.string().trim().max(2000).optional(),
  status: statusEnum.optional(),
};

// Soft cross-field check: maximum ≥ minimum when both present.
const maxGteMin = (d: { minimumStock?: number | null; maximumStock?: number | null }) =>
  !(typeof d.minimumStock === "number" && typeof d.maximumStock === "number") || d.maximumStock >= d.minimumStock;
const maxGteMinError = { message: "Maximum stock must be greater than or equal to minimum stock.", path: ["maximumStock"] as string[] };

export const createIrmItemSchema = z
  .object({
    name: z.string({ error: "Item name is required." }).trim().min(1, "Item name is required.").max(150),
    ...sharedIrmFields,
    typeId: z.string({ error: "Select an IRM type." }).regex(OBJECT_ID_RE, "Select an IRM type."),
    irmCategoryId: z.string({ error: "Select an IRM category." }).regex(OBJECT_ID_RE, "Select an IRM category."),
    baseUnit: baseUnitCreate,
    suppliers: suppliersCreate,
  })
  .refine(maxGteMin, maxGteMinError);
export type CreateIrmItemInput = z.infer<typeof createIrmItemSchema>;

export const updateIrmItemSchema = z
  .object({
    name: z.string().trim().min(1, "Item name can't be empty.").max(150).optional(),
    ...sharedIrmFields,
    suppliers: suppliersUpdate,
  })
  .refine(maxGteMin, maxGteMinError);
export type UpdateIrmItemInput = z.infer<typeof updateIrmItemSchema>;
