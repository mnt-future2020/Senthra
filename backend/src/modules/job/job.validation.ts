import { z } from "zod";

import { postcodeField as ukPostcode } from "../../utils/postcode.js";
import { isHttpUrl } from "../../utils/http-url.js";

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
// "" (or null) means CLEAR THIS FIELD, as distinct from a missing key meaning "leave it alone".
// A plain text field gets this for free — z.string() keeps the "" and the service's trimToNull
// turns it into null. An id or a date can't: their inner validator rejects "", so they were wrapped
// in emptyToUndef, which collapsed "the user emptied this box" into "the client said nothing" —
// making a site, a supplier or a completion date settable but never removable.
const emptyToNull = (v: unknown) => (v === null || (typeof v === "string" && v.trim() === "") ? null : v);

const objectId = (label: string) => z.string({ error: `Select ${label}.` }).regex(OBJECT_ID_RE, `Select ${label}.`);
const optionalObjectId = (label: string) => z.preprocess(emptyToUndef, z.string().regex(OBJECT_ID_RE, `Select ${label}.`).optional());
// Header ids the user can un-pick. Kit-line ids deliberately keep optionalObjectId: a line's source
// id isn't "cleared", the whole line is replaced, and null there would only widen what the service
// has to defend against.
const clearableObjectId = (label: string) => z.preprocess(emptyToNull, z.string().regex(OBJECT_ID_RE, `Select ${label}.`).nullable().optional());

// A plain PREDICATE, with the message passed as refine's second argument. Returning the message from
// the predicate instead (`ok || "..."`) reads naturally and is silently wrong: refine treats any
// truthy return as "valid", so the failure message itself passes validation and every malformed date
// is accepted.
const isDateString = (v: string) => !Number.isNaN(Date.parse(v));
const badDate = (label: string) => `Enter a valid ${label.toLowerCase()}.`;

// A job's completion date is REQUIRED, and deliberately NOT part of sharedHeader: create and update
// need different rules, and a field whose rule differs per flow is exactly the one that goes wrong
// when it is inherited silently.
//
// Why required at all: this app has no draft/backlog state — `createJob` hardcodes status "assigned"
// and demands an engineer, so a job is DISPATCHED WORK from the moment it exists. A job with no due
// date is invisible to every escalation path there is (the goods queue's due filter, the dashboard's
// overdue + due-this-week counts, the engineer's Overdue filter) — not less visible, absent. It can
// only ever be found by someone already scrolling the full active list, which is the one situation
// those lists exist to avoid.
const requiredDateOnCreate = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .refine(isDateString, badDate(label));

// PATCH semantics: an ABSENT key means "leave it alone" and stays legal, so an edit that touches only
// the address needn't resend the date. But an empty string must be REJECTED rather than cleared —
// `optionalFor("edit")` sends "" for a box the user blanked, which is precisely the attempt to remove
// a date that is now mandatory. No `emptyToUndef` preprocessing here: that would rewrite "" into
// "absent" and silently accept the clear it is meant to refuse.
const requiredDateOnUpdate = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} can't be removed — a job must say when it is due.`)
    .refine(isDateString, badDate(label))
    .optional();

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
  siteId: clearableObjectId("a site"),
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
  priority: z.preprocess(emptyToUndef, z.enum(JOB_PRIORITIES).optional()),
  supplierId: clearableObjectId("a supplier"),
  installerType: z.preprocess(emptyToUndef, z.enum(INSTALLER_TYPES).optional()),
  plannerName: z.string().trim().max(160).optional(),
  plannerPhone: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(4000).optional(),
  // http(s) only. These are typed in as free text and rendered as links — on the customer portal
  // now, not just the office page — and `javascript:` / `data:` are valid URLs that execute when
  // clicked. A shape check would pass both, so the SCHEME is what this pins (utils/http-url).
  attachments: z
    .array(z.string().trim().max(1000).refine(isHttpUrl, "Attachments must be an http:// or https:// link."))
    .max(50)
    .optional(),
};

export const createJobSchema = z
  .object({
    name: z.string({ error: "Job name is required." }).trim().min(1, "Job name is required.").max(300),
    customerId: objectId("a customer"),
    projectId: objectId("a project"),
    assignedEngineerId: objectId("an engineer"),
    ...sharedHeader,
    completionDate: requiredDateOnCreate("Completion date"),
    kitLines: kitLinesField,
  })
  // A job DISPATCHES an engineer somewhere, so it has to name a destination — one of the two ways
  // the form offers: pick a saved site, or type an address. Both were optional, so a job could be
  // created pointing nowhere and the engineer's job detail would show "—" for every location field.
  //
  // Deliberately siteId OR addressLine1, NOT "an address is required": a customer site's own
  // addressLine1/city/postcode are all optional (siteSchema), so a site can legitimately be saved
  // with just a name. Demanding an address would reject someone who correctly picked such a site —
  // punishing them for a gap that belongs on the SITE record, not on every job that references it.
  //
  // The SAME rule applies on update, but it can't be expressed here: an update is a PATCH, so a
  // payload that omits both keys says nothing about them and the rule is only decidable against the
  // merged result (existing row + patch). It therefore lives in job.service.updateJob, next to the
  // other guards that need the existing record. updateJobSchema is intentionally rule-free.
  .superRefine((v, ctx) => {
    if (!v.siteId && !v.addressLine1?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["siteId"],
        message: "Pick a site, or enter an address for where the work happens.",
      });
    }
  });
export type CreateJobInput = z.infer<typeof createJobSchema>;

// Update = a full re-save; every field optional (kitLines optional — if provided it REPLACES).
export const updateJobSchema = z.object({
  name: z.string().trim().min(1, "Job name is required.").max(300).optional(),
  customerId: objectId("a customer").optional(),
  projectId: objectId("a project").optional(),
  assignedEngineerId: objectId("an engineer").optional(),
  ...sharedHeader,
  // Same rule as create, expressed for PATCH — see requiredDateOnUpdate. Create demanding a date
  // while edit let it be blanked is the exact inconsistency the Site field had.
  completionDate: requiredDateOnUpdate("Completion date"),
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
