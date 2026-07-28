import { z } from "zod";

import { postcodeField as ukPostcode } from "../../utils/postcode.js";

// Job (field-work) validation. Job number / status / snapshots / timestamps are SYSTEM-owned and
// never accepted from the client. lineType/priority/installerType/jobType are validated here (the
// schema has no Prisma enums — the unions live as `as const` arrays + zod, the DB stores plain
// Strings). On create a job is born "assigned" (it always has an engineer); the status machine is
// enforced in the service. v1: NO geocoding — latitude/longitude are never set from the client.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export const JOB_STATUSES = ["draft", "assigned", "accepted", "in_progress", "completed", "rejected", "cancelled"] as const;
export const JOB_LINE_TYPES = ["customer_stock", "irm", "misc"] as const;
export const JOB_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const JOB_TYPES = ["installation", "survey", "maintenance", "decommission", "other"] as const;
export const INSTALLER_TYPES = ["internal", "external"] as const;

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const objectId = (label: string) => z.string({ error: `Select ${label}.` }).regex(OBJECT_ID_RE, `Select ${label}.`);
const optionalObjectId = (label: string) => z.preprocess(emptyToUndef, z.string().regex(OBJECT_ID_RE, `Select ${label}.`).optional());

const optionalDate = (label: string) =>
  z.preprocess(
    emptyToUndef,
    z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), `Enter a valid ${label.toLowerCase()}.`)
      .optional(),
  );

// One kit line — exactly one source pool per line (lineType). The matching source id is optional in
// the schema (a misc line has none); the service snapshots the rest.
const kitLineSchema = z
  .object({
    lineType: z.enum(JOB_LINE_TYPES, { error: "Select a line type." }),
    seCode: z.string().trim().max(120).optional(),
    itemName: z.string({ error: "Item name is required." }).trim().min(1, "Item name is required.").max(300),
    description: z.string().trim().max(2000).optional(),
    customerStockEntryId: optionalObjectId("a customer stock item"),
    irmItemId: optionalObjectId("an IRM item"),
    // Pickup warehouse — REQUIRED for irm lines (the PM chooses where to collect); for customer_stock
    // it's derived server-side from the chosen entry (sent or not, it's overridden); misc has none.
    warehouseId: optionalObjectId("a warehouse"),
    qty: z.coerce.number({ error: "Quantity is required." }).int("Quantity must be a whole number.").min(1, "Quantity must be at least 1.").max(10_000_000),
    notes: z.string().trim().max(2000).optional(),
  })
  // lineType ⇄ source-id consistency is a VALIDATION GUARANTEE (not just a service-layer cleanup):
  // customer_stock ⇒ customerStockEntryId required + no irmItemId; irm ⇒ irmItemId required + no
  // customerStockEntryId; misc ⇒ neither. Keeps lineType meaningful for every downstream consumer.
  .superRefine((l, ctx) => {
    if (l.lineType === "irm") {
      if (!l.irmItemId) ctx.addIssue({ code: "custom", path: ["irmItemId"], message: "Select an IRM item." });
      if (l.customerStockEntryId) ctx.addIssue({ code: "custom", path: ["customerStockEntryId"], message: "IRM lines can't reference customer stock." });
      if (!l.warehouseId) ctx.addIssue({ code: "custom", path: ["warehouseId"], message: "Select the warehouse to collect from." });
    } else if (l.lineType === "customer_stock") {
      if (!l.customerStockEntryId) ctx.addIssue({ code: "custom", path: ["customerStockEntryId"], message: "Select a customer stock item." });
      if (l.irmItemId) ctx.addIssue({ code: "custom", path: ["irmItemId"], message: "Customer-stock lines can't reference IRM." });
    } else {
      if (l.customerStockEntryId || l.irmItemId) ctx.addIssue({ code: "custom", path: ["lineType"], message: "Misc lines can't reference a source item." });
      if (l.warehouseId) ctx.addIssue({ code: "custom", path: ["warehouseId"], message: "Misc lines have no warehouse." });
    }
  });
export type JobKitLineInput = z.infer<typeof kitLineSchema>;

// No duplicate SOURCE item on one job: the same IRM item / customer-stock entry must appear at most
// once on the kit list (combine the quantities into a single line instead). Misc lines have no source
// id, so they're exempt — two free-text misc lines with the same name are allowed.
const kitLinesField = z
  .array(kitLineSchema)
  .min(1, "Add at least one kit line.")
  .max(500, "Too many kit lines on one job.")
  .superRefine((lines, ctx) => {
    const seenIrm = new Set<string>();
    const seenCse = new Set<string>();
    lines.forEach((l, i) => {
      if (l.lineType === "irm" && l.irmItemId) {
        // Key on item + warehouse: the same IRM item may legitimately appear once PER warehouse
        // (split pickup), but not twice for the same warehouse.
        const key = `${l.irmItemId}@${l.warehouseId ?? ""}`;
        if (seenIrm.has(key)) {
          ctx.addIssue({ code: "custom", path: [i, "irmItemId"], message: "This IRM item is already on the kit list for this warehouse — increase its quantity instead." });
        } else seenIrm.add(key);
      } else if (l.lineType === "customer_stock" && l.customerStockEntryId) {
        if (seenCse.has(l.customerStockEntryId)) {
          ctx.addIssue({ code: "custom", path: [i, "customerStockEntryId"], message: "This customer stock item is already on the kit list — increase its quantity instead." });
        } else seenCse.add(l.customerStockEntryId);
      }
    });
  });

// Shared header fields (create + update). Required-on-create fields are added per-schema.
const sharedHeader = {
  jobType: z.preprocess(emptyToUndef, z.enum(JOB_TYPES).optional()),
  technology: z.string().trim().max(120).optional(),
  customerRef: z.string().trim().max(120).optional(),
  schemeNo: z.string().trim().max(120).optional(),
  siteId: optionalObjectId("a site"),
  siteName: z.string().trim().max(200).optional(),
  trsArea: z.string().trim().max(120).optional(),
  addressLine1: z.string().trim().max(300).optional(),
  addressLine2: z.string().trim().max(300).optional(),
  city: z.string().trim().max(120).optional(),
  county: z.string().trim().max(120).optional(),
  // Validates AND normalises to canonical form ("ls14dy" → "LS1 4DY") — see utils/postcode.ts.
  postcode: ukPostcode().optional(),
  country: z.string().trim().max(120).optional(),
  floor: z.string().trim().max(60).optional(),
  suite: z.string().trim().max(60).optional(),
  rack: z.string().trim().max(60).optional(),
  shelf: z.string().trim().max(60).optional(),
  completionDate: optionalDate("Completion date"),
  priority: z.preprocess(emptyToUndef, z.enum(JOB_PRIORITIES).optional()),
  supplierId: optionalObjectId("a supplier"),
  installerType: z.preprocess(emptyToUndef, z.enum(INSTALLER_TYPES).optional()),
  plannerName: z.string().trim().max(160).optional(),
  plannerPhone: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(4000).optional(),
  attachments: z.array(z.string().trim().max(1000)).max(50).optional(),
};

export const createJobSchema = z.object({
  name: z.string({ error: "Job name is required." }).trim().min(1, "Job name is required.").max(300),
  customerId: objectId("a customer"),
  projectId: objectId("a project"),
  assignedEngineerId: objectId("an engineer"),
  ...sharedHeader,
  kitLines: kitLinesField,
});
export type CreateJobInput = z.infer<typeof createJobSchema>;

// Update = a full re-save; every field optional (kitLines optional — if provided it REPLACES).
export const updateJobSchema = z.object({
  name: z.string().trim().min(1, "Job name is required.").max(300).optional(),
  customerId: objectId("a customer").optional(),
  projectId: objectId("a project").optional(),
  assignedEngineerId: objectId("an engineer").optional(),
  ...sharedHeader,
  kitLines: kitLinesField.optional(),
});
export type UpdateJobInput = z.infer<typeof updateJobSchema>;

export const assignJobSchema = z.object({ engineerId: objectId("an engineer") });
export type AssignJobInput = z.infer<typeof assignJobSchema>;

export const cancelJobSchema = z.object({ reason: z.string().trim().max(500).optional() });
export type CancelJobInput = z.infer<typeof cancelJobSchema>;

// Engineer reject — a reason is optional but encouraged (surfaced to the PM).
export const rejectJobSchema = z.object({ reason: z.string().trim().max(500).optional() });
export type RejectJobInput = z.infer<typeof rejectJobSchema>;

// Engineer complete — declares used quantities and an optional work summary.
// usedLines defaults to [] so a completion with no stock usage is valid.
export const completeJobSchema = z.object({
  workSummary: z.string().trim().max(4000).optional(),
  usedLines: z
    .array(
      z
        .object({
          source: z.enum(["irm", "customer"]),
          irmItemId: optionalObjectId("an IRM item"),
          customerStockEntryId: optionalObjectId("a customer stock item"),
          jobKitLineId: optionalObjectId("a kit line"), // exact line used — disambiguates an item on >1 warehouse
          qty: z.coerce.number().int().min(0).max(10_000_000),
        })
        // The id must match the source — an "irm" line needs irmItemId, a "customer" line needs
        // customerStockEntryId. Caught here so the contract is explicit, not deep in the service.
        .refine((l) => (l.source === "irm" ? !!l.irmItemId : !!l.customerStockEntryId), {
          message: "Each used line needs the item id matching its source (irmItemId for irm, customerStockEntryId for customer).",
        }),
    )
    .max(500)
    .default([]),
});
export type CompleteJobInput = z.infer<typeof completeJobSchema>;
