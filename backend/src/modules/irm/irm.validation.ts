import { z } from "zod";

import { UOM_OPTIONS } from "../../utils/uom.js";

// IRM Catalogue item validation. Company-owned internal stock MASTER DATA. Code is
// auto-allocated (IRM-0001). Type + Category reference the IRM masters (NOT the customer
// Category). Cost is collected in POUNDS here and stored as integer pence by the service.
//
// REQUIRED on create: name, typeId, irmCategoryId, baseUnit. Suppliers are OPTIONAL — an item
// may have none (not every item is bought in) — but when rows ARE sent they must be unique and
// mark at most one primary. On UPDATE everything is optional (partial PATCH) but
// non-empty / valid when sent; an empty suppliers array clears all links.

const statusEnum = z.enum(["active", "inactive"]);
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// Units of measure — same list the customer catalogue uses.
// One vocabulary for the whole app — see utils/uom.ts. Re-exported so existing readers of
// `irm.validation` keep working without learning a new import path.
export { UOM_OPTIONS } from "../../utils/uom.js";
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

// One supplier link row (becomes an IrmItemSupplier junction row).
const supplierRowSchema = z.object({
  supplierId: z.string().regex(OBJECT_ID_RE, "Select a supplier."),
  isPrimary: z.boolean().optional(),
  priority: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(0).max(1000).optional()),
  supplierSku: z.string().trim().max(80).optional(),
  leadTimeDays: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(0).max(365).optional()),
});
export type SupplierRowInput = z.infer<typeof supplierRowSchema>;

// Optional: zero suppliers is allowed. When rows are present they must be unique and mark at
// most one primary (an empty list simply has no primary).
const suppliersValid = (arr: { supplierId: string; isPrimary?: boolean }[]) => {
  const ids = arr.map((s) => s.supplierId);
  const noDup = new Set(ids).size === ids.length;
  const primaries = arr.filter((s) => s.isPrimary === true).length;
  return noDup && primaries <= 1;
};
const suppliersMessage = "Each supplier can only be added once, and only one can be primary.";
const suppliersField = z.array(supplierRowSchema).refine(suppliersValid, { message: suppliersMessage }).optional();

// Shared optional fields (create + update). Required ones are overridden on create.
const sharedIrmFields = {
  description: z.string().trim().max(2000).optional(),
  brand: z.string().trim().max(120).optional(),
  manufacturer: z.string().trim().max(120).optional(),
  mpn: z.string().trim().max(120).optional(),
  typeId: optionalTypeIdField,
  irmCategoryId: optionalCategoryIdField,
  // SKU is MANDATORY on both create and update — every IRM item carries one. It stays `optional()`
  // here in the 3-state sense (omitted = no change on update; blank on create = let the server
  // generate one from the name + category), but an explicitly EMPTY value is rejected: once an item
  // has a SKU it can never go back to having none. The service normalizes the shape.
  sku: z.string().trim().min(1, "SKU is required.").max(80).optional(),
  baseUnit: baseUnitUpdate,
  packSize: packSizeField,
  reorderLevel: optionalInt(1_000_000, "Reorder level"),
  maximumStock: optionalInt(1_000_000, "Maximum stock"),
  criticalLevel: optionalInt(1_000_000, "Critical level"),
  standardCost: standardCostField,
  currency: currencyField,
  vatRatePercent: vatField,
  trackInventory: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional(),
  status: statusEnum.optional(),
};

// Stock policy coherence. These used to compare maximumStock against `minimumStock` — a field the
// reorder engine never read, so the one cross-field rule in the form was guarding a number that did
// nothing. The three thresholds that DO drive reordering must stack: critical ≤ reorder ≤ maximum.
const maxGteReorder = (d: { reorderLevel?: number | null; maximumStock?: number | null }) =>
  !(typeof d.reorderLevel === "number" && typeof d.maximumStock === "number") || d.maximumStock >= d.reorderLevel;
const maxGteReorderError = {
  message: "Maximum stock must be greater than or equal to the reorder level — an order has to lift stock clear of the line that triggered it.",
  path: ["maximumStock"] as string[],
};

const criticalLteReorder = (d: { reorderLevel?: number | null; criticalLevel?: number | null }) =>
  !(typeof d.reorderLevel === "number" && typeof d.criticalLevel === "number") || d.criticalLevel <= d.reorderLevel;
const criticalLteReorderError = {
  message: "Critical level must be at or below the reorder level — it is the more urgent line, not a second trigger.",
  path: ["criticalLevel"] as string[],
};

// Closes the chain. The two rules above both hinge on `reorderLevel`, so with it left blank nothing
// compared critical against maximum — critical 200 with a maximum of 50 passed, and the comment above
// claimed an ordering the code only half-enforced. Every adjacent pair is now checked, so any two of
// the three that are present must still stack.
const criticalLteMax = (d: { criticalLevel?: number | null; maximumStock?: number | null }) =>
  !(typeof d.criticalLevel === "number" && typeof d.maximumStock === "number") || d.criticalLevel <= d.maximumStock;
const criticalLteMaxError = {
  message: "Critical level must be at or below the maximum stock — it is the lowest of the three lines.",
  path: ["criticalLevel"] as string[],
};

export const createIrmItemSchema = z
  .object({
    name: z.string({ error: "Item name is required." }).trim().min(1, "Item name is required.").max(150),
    ...sharedIrmFields,
    typeId: z.string({ error: "Select an IRM type." }).regex(OBJECT_ID_RE, "Select an IRM type."),
    irmCategoryId: z.string({ error: "Select an IRM category." }).regex(OBJECT_ID_RE, "Select an IRM category."),
    baseUnit: baseUnitCreate,
    suppliers: suppliersField,
  })
  .refine(maxGteReorder, maxGteReorderError)
  .refine(criticalLteReorder, criticalLteReorderError)
  .refine(criticalLteMax, criticalLteMaxError);
export type CreateIrmItemInput = z.infer<typeof createIrmItemSchema>;

export const updateIrmItemSchema = z
  .object({
    name: z.string().trim().min(1, "Item name can't be empty.").max(150).optional(),
    ...sharedIrmFields,
    suppliers: suppliersField,
  })
  .refine(maxGteReorder, maxGteReorderError)
  .refine(criticalLteReorder, criticalLteReorderError)
  .refine(criticalLteMax, criticalLteMaxError);
export type UpdateIrmItemInput = z.infer<typeof updateIrmItemSchema>;
