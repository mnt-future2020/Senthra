import { z } from "zod";

// Goods Out (Dispatch) validation. DISPATCH WORKFLOW ONLY. Code/status/snapshots/ledger rows/balances
// are SYSTEM-owned and never accepted from the client. Editable only in `draft` (service-enforced).
// Serial/batch-tracked + non-inventory-tracked items are rejected in the service (they need the IRM
// track flags). jobId/projectId/customerStockRequestId are accepted but are future Job-Pack sockets.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export const DISPATCH_STATUSES = ["draft", "dispatched", "cancelled"] as const;
export const DISPATCH_REASONS = [
  "job_work",
  "customer_request",
  "installation",
  "maintenance",
  "replacement",
  "warehouse_replenishment",
  "emergency_dispatch",
  "other",
] as const;

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const objectId = (label: string) => z.string({ error: `Select ${label}.` }).regex(OBJECT_ID_RE, `Select ${label}.`);
const optionalObjectId = (label: string) => z.preprocess(emptyToUndef, z.string().regex(OBJECT_ID_RE, `Select ${label}.`).optional());

const requiredDate = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .min(1, `${label} is required.`)
    .refine((v) => !Number.isNaN(Date.parse(v)), `Enter a valid ${label.toLowerCase()}.`);
const optionalDate = (label: string) =>
  z.preprocess(
    emptyToUndef,
    z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), `Enter a valid ${label.toLowerCase()}.`)
      .optional(),
  );

// One dispatch line — dispatches ONE IRM item.
const lineSchema = z.object({
  irmItemId: z.string().regex(OBJECT_ID_RE, "Select an item."),
  quantity: z.coerce.number({ error: "Quantity is required." }).int("Quantity must be a whole number.").min(1, "Quantity must be at least 1.").max(10_000_000),
  notes: z.string().trim().max(2000).optional(),
});
export type GoodsOutLineInput = z.infer<typeof lineSchema>;

const noDupLines = (lines: { irmItemId: string }[]) => {
  const ids = lines.map((l) => l.irmItemId);
  return new Set(ids).size === ids.length;
};
const itemsField = z
  .array(lineSchema)
  .min(1, "Add at least one item to dispatch.")
  .max(500, "Too many lines on one dispatch.")
  .refine(noDupLines, { message: "The same item appears more than once — combine the quantities." });

// Shared header fields (create + draft update).
const sharedHeader = {
  dispatchReason: z.enum(DISPATCH_REASONS, { error: "Select a dispatch reason." }),
  expectedReturnDate: optionalDate("Expected return date"),
  authorizedById: optionalObjectId("an authoriser"),
  authorizedByName: z.string().trim().max(160).optional(),
  // Future Job-Pack sockets — accepted, optional, no business logic in v1.
  jobId: optionalObjectId("a job"),
  projectId: optionalObjectId("a project"),
  customerStockRequestId: optionalObjectId("a request"),
  referenceNumber: z.string().trim().max(60).optional(),
  description: z.string().trim().max(2000).optional(),
  internalNotes: z.string().trim().max(2000).optional(),
};

export const createGoodsOutSchema = z.object({
  warehouseId: objectId("a source warehouse"),
  engineerId: objectId("an engineer"),
  dispatchDate: requiredDate("Dispatch date"),
  ...sharedHeader,
  items: itemsField,
});
export type CreateGoodsOutInput = z.infer<typeof createGoodsOutSchema>;

// Update = a full DRAFT re-save (the service additionally blocks edits on any non-draft dispatch).
export const updateGoodsOutSchema = z.object({
  warehouseId: objectId("a source warehouse").optional(),
  engineerId: objectId("an engineer").optional(),
  dispatchDate: requiredDate("Dispatch date").optional(),
  dispatchReason: z.preprocess(emptyToUndef, z.enum(DISPATCH_REASONS).optional()),
  expectedReturnDate: optionalDate("Expected return date"),
  authorizedById: optionalObjectId("an authoriser"),
  authorizedByName: z.string().trim().max(160).optional(),
  jobId: optionalObjectId("a job"),
  projectId: optionalObjectId("a project"),
  customerStockRequestId: optionalObjectId("a request"),
  referenceNumber: z.string().trim().max(60).optional(),
  description: z.string().trim().max(2000).optional(),
  internalNotes: z.string().trim().max(2000).optional(),
  items: itemsField.optional(),
});
export type UpdateGoodsOutInput = z.infer<typeof updateGoodsOutSchema>;

export const cancelGoodsOutSchema = z.object({ reason: z.string().trim().max(500).optional() });
export type GoodsOutCancelInput = z.infer<typeof cancelGoodsOutSchema>;
