import { z } from "zod";

import { toCalendarDay } from "../../utils/calendar-day.js";

// Request shapes for hire movement notes — kit arriving IN, going back OUT, and damage found while it
// is with us. The service is authoritative about WHAT can move (it re-reads the order and caps every
// quantity against what is actually outstanding); these rules only refuse a request that could not be
// honest under any circumstances.

/** The condition summary for a whole note. Per-line `damagedQuantity` carries the detail. */
export const RECEIPT_CONDITIONS = ["good", "damaged"] as const;

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const rentalLineId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid rental line id.");

/**
 * A UTC-midnight calendar day, like every other rental date — a hire's clock is counted in days.
 *
 * The try/catch is load-bearing, not defensive. `toCalendarDay` THROWS on an unparseable value (by
 * design: a silently-invalid hire period would read as "never due"), and zod does NOT convert an
 * error thrown inside `preprocess` into an issue — it propagates straight out of `safeParse`. Since
 * `validateBody` only handles `!result.success`, an un-caught throw escapes the middleware entirely
 * and Express answers a mistyped date with a logged 500 instead of the field-level 400 every other
 * bad input gets. Handing `undefined` to `z.date()` instead is what turns it back into that 400.
 *
 * Mirrors `calendarDayField` in purchase-request.validation.ts, which does this for the same reason.
 */
const calendarDay = (message: string) =>
  z.preprocess((v) => {
    if (typeof v !== "string" && !(v instanceof Date)) return v;
    try {
      return toCalendarDay(v);
    } catch {
      return undefined;
    }
  }, z.date({ error: message }));

/**
 * What a note line says about the units it names, whichever way they went.
 *
 * The asset tags are here on EVERY direction on purpose: the tags recorded on arrival are what let a
 * return name the same physical units, and a damage report that cannot say which unit is damaged is a
 * note the supplier can argue with.
 */
const noteLineBase = {
  purchaseOrderRentalLineId: rentalLineId,
  damagedQuantity: z.coerce.number().int("Use whole units.").min(0, "Damaged can't be negative.").optional(),
  // The supplier's own asset tags for the units this note covers. Trimmed, blanks dropped — a row of
  // empty boxes on the form must not become a row of empty strings in the record.
  assetTags: z.array(z.string().trim().max(60, "An asset tag can't be longer than 60 characters.")).max(200).optional(),
  notes: z.preprocess(emptyToUndef, z.string().trim().max(1000).optional()),
};

/** The header fields every note shares. Only the DATE differs, and it is named per direction. */
const noteHeaderBase = {
  purchaseOrderId: z.string().regex(/^[a-f0-9]{24}$/i, "Invalid purchase order id."),
  condition: z.enum(RECEIPT_CONDITIONS, { error: "Choose the condition the kit was in." }).optional(),
  conditionNotes: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
  notes: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
};

/**
 * What the supplier is charging us for damage on one line, in POUNDS as the form sends it, stored as
 * integer pence — no floating point ever reaches the database.
 *
 * Optional everywhere, and that is the point: a damage report is written the day the fault is found,
 * and the quote arrives days later. A required field here would be filled with a guess, and a guessed
 * zero cannot be told apart from a settled one. It is recorded later instead, through its own route.
 *
 * The cap is a sanity bound, not a policy — £1,000,000 on one line of hired kit is a typo, and the
 * form should say so rather than storing it.
 */
const damageCharge = z.preprocess(
  (v) => (v === "" || v == null ? undefined : v),
  z.coerce
    .number({ error: "Enter the damage charge as an amount." })
    .min(0, "A damage charge can't be negative.")
    .max(1_000_000, "That damage charge looks wrong — check the figure.")
    .optional(),
);

/** The supplier's quote or invoice number for the damage — what an accounts query searches on. */
const damageChargeRef = z.preprocess(emptyToUndef, z.string().trim().max(60).optional());

/** The same line twice would double-count the running total the hire carries. */
const linesAreDistinct = (b: { lines: { purchaseOrderRentalLineId: string }[] }) =>
  new Set(b.lines.map((l) => l.purchaseOrderRentalLineId)).size === b.lines.length;

const DISTINCT_MESSAGE = { message: "Each rental line can only appear once on a note.", path: ["lines"] };

// ── IN: a delivery of hired kit ─────────────────────────────────────────────────────────────────

const receiptLineSchema = z.object({
  ...noteLineBase,
  // Zero is legitimate and ordinary: a delivery van brings two of the four lines on an order, and the
  // other two are sent with 0 rather than being omitted, so the form can post exactly what it showed.
  receivedQuantity: z.coerce.number().int("Use whole units.").min(0, "Received can't be negative."),
});

export const createRentalReceiptSchema = z
  .object({
    ...noteHeaderBase,
    deliveryDate: calendarDay("A delivery date is required."),
    carrier: z.preprocess(emptyToUndef, z.string().trim().max(120).optional()),
    deliveryNoteRef: z.preprocess(emptyToUndef, z.string().trim().max(60).optional()),
    lines: z.array(receiptLineSchema).min(1, "Add at least one line to this delivery."),
  })
  .strip()
  // A delivery that delivered nothing is not a record worth keeping — and it would move no hire, so
  // the receipt would exist only to say that a van arrived empty.
  .refine((b) => b.lines.some((l) => l.receivedQuantity > 0), {
    message: "Enter the quantity received on at least one line.",
    path: ["lines"],
  })
  // Damaged is a SUBSET of what arrived, per line. Checked here as well as in the service because the
  // pair is meaningless apart: 2 damaged out of 1 received describes nothing.
  .refine((b) => b.lines.every((l) => (l.damagedQuantity ?? 0) <= l.receivedQuantity), {
    message: "Damaged can't be more than the quantity received on the same line.",
    path: ["lines"],
  })
  // A delivery flagged DAMAGED with nothing describing the damage is a claim nobody can argue with at
  // return time — the flag is what someone scans for, and the words are what the dispute turns on.
  .refine((b) => b.condition !== "damaged" || Boolean(b.conditionNotes), {
    message: "Describe the damage in the condition notes.",
    path: ["conditionNotes"],
  })
  .refine(linesAreDistinct, DISTINCT_MESSAGE);
export type CreateRentalReceiptInput = z.infer<typeof createRentalReceiptSchema>;

// ── OUT: kit going back to the supplier ─────────────────────────────────────────────────────────

const returnLineSchema = z.object({
  ...noteLineBase,
  // Zero for the same reason as a delivery: the form posts every row it displayed, and a collection
  // rarely takes every line on the order.
  returnedQuantity: z.coerce.number().int("Use whole units.").min(0, "Returned can't be negative."),
  damageCharge,
});

export const createRentalReturnSchema = z
  .object({
    ...noteHeaderBase,
    returnDate: calendarDay("A collection date is required."),
    // Who took it away, and their paperwork reference — the mirror of the delivery's carrier fields,
    // and the only proof we have that it left our yard on the day we say it did.
    collectedBy: z.preprocess(emptyToUndef, z.string().trim().max(120).optional()),
    returnNoteRef: z.preprocess(emptyToUndef, z.string().trim().max(60).optional()),
    damageChargeRef,
    lines: z.array(returnLineSchema).min(1, "Add at least one line to this return."),
  })
  .strip()
  // Money against a line nobody said was damaged is a charge with no claim behind it — and it is far
  // more likely to be a figure typed on the wrong row than a real one.
  .refine((b) => b.lines.every((l) => l.damageCharge == null || (l.damagedQuantity ?? 0) > 0), {
    message: "Record how many units are damaged on the same line as the charge.",
    path: ["lines"],
  })
  .refine((b) => b.lines.some((l) => l.returnedQuantity > 0), {
    message: "Enter the quantity returned on at least one line.",
    path: ["lines"],
  })
  .refine((b) => b.lines.every((l) => (l.damagedQuantity ?? 0) <= l.returnedQuantity), {
    message: "Damaged can't be more than the quantity returned on the same line.",
    path: ["lines"],
  })
  // The condition it went back in is the ONE fact a hire ends on: it is what the supplier will bill
  // against, so damage claimed with nothing behind it is a dispute we have already lost.
  .refine((b) => b.condition !== "damaged" || Boolean(b.conditionNotes), {
    message: "Describe the damage in the condition notes.",
    path: ["conditionNotes"],
  })
  .refine(linesAreDistinct, DISTINCT_MESSAGE);
export type CreateRentalReturnInput = z.infer<typeof createRentalReturnSchema>;

// ── DAMAGE: found broken while we have it ───────────────────────────────────────────────────────

const damageLineSchema = z.object({
  ...noteLineBase,
  damagedQuantity: z.coerce.number().int("Use whole units.").min(0, "Damaged can't be negative."),
  damageCharge,
});

export const reportHireDamageSchema = z
  .object({
    ...noteHeaderBase,
    reportedDate: calendarDay("A date is required."),
    // Pinned, not chosen: a damage report is what it says it is. The field lives on the shared header
    // so one reader serves all three notes; here it can only be the one value.
    condition: z.literal("damaged").optional(),
    conditionNotes: z.string().trim().min(3, "Describe what happened.").max(2000),
    damageChargeRef,
    lines: z.array(damageLineSchema).min(1, "Add at least one line to this report."),
  })
  .strip()
  .refine((b) => b.lines.every((l) => l.damageCharge == null || l.damagedQuantity > 0), {
    message: "Record how many units are damaged on the same line as the charge.",
    path: ["lines"],
  })
  // Nothing damaged is not a damage report. Said as a refinement rather than a per-line minimum
  // because the form posts every line it showed, most of them zero.
  .refine((b) => b.lines.some((l) => l.damagedQuantity > 0), {
    message: "Enter how many units are damaged on at least one line.",
    path: ["lines"],
  })
  .refine(linesAreDistinct, DISTINCT_MESSAGE);
export type ReportHireDamageInput = z.infer<typeof reportHireDamageSchema>;

// ── Charging one custody record ─────────────────────────────────────────────────────────────────
//
// The dialog that puts an engineer's damage report, or a declared loss, to the provider. Quantity and
// words come from the record itself, so all this collects is the money — which is the only part that
// was ever missing.
export const chargeCustodyExitSchema = z
  .object({
    // Nullable AND optional, both meaning "no figure agreed yet". A missing quote is a different fact
    // from a zero charge, and the record shows "not yet charged" rather than "charged nothing".
    charge: z.preprocess(emptyToUndef, damageCharge.nullable().optional()),
    chargeRef: z.preprocess(emptyToUndef, z.string().trim().max(60).optional()),
  })
  .strip();
export type ChargeCustodyExitInput = z.infer<typeof chargeCustodyExitSchema>;

// ── The charge, recorded after the fact ─────────────────────────────────────────────────────────
//
// The one value on a note that may be set later instead of requiring the note to be reversed. It
// drives no running total, so correcting it cannot leave a stored figure disagreeing with the records
// it summarises — which is the whole reason quantities are reverse-only. See the field's own note in
// schema.prisma, and the audit entry the service writes for every change.

export const recordDamageChargeSchema = z
  .object({
    /** The supplier's quote or invoice number. Sent alone, it updates only the reference. */
    damageChargeRef,
    lines: z
      .array(
        z.object({
          purchaseOrderRentalLineId: rentalLineId,
          // NULL is a real instruction here, and a different one from omitting the line: it CLEARS a
          // charge that turned out not to be coming. Omitting the line leaves whatever is on file.
          damageCharge: z.preprocess(
            (v) => (v === "" ? null : v),
            z.union([
              z.coerce
                .number()
                .min(0, "A damage charge can't be negative.")
                .max(1_000_000, "That damage charge looks wrong — check the figure."),
              z.null(),
            ]),
          ),
        }),
      )
      .max(200)
      .optional(),
  })
  .strip()
  .refine((b) => b.damageChargeRef !== undefined || (b.lines?.length ?? 0) > 0, {
    message: "Enter a charge or a supplier reference.",
    path: ["lines"],
  })
  .refine((b) => !b.lines || linesAreDistinct({ lines: b.lines }), DISTINCT_MESSAGE);
export type RecordDamageChargeInput = z.infer<typeof recordDamageChargeSchema>;

// ── Reversing any of the three ──────────────────────────────────────────────────────────────────

export const reverseRentalReceiptSchema = z.object({
  // Required, unlike most notes: a reversal rewrites how much of a hire moved, and "why" is the only
  // thing that makes that readable a month later.
  reason: z.string().trim().min(3, "Say why this record is being reversed.").max(500),
});
export type ReverseRentalReceiptInput = z.infer<typeof reverseRentalReceiptSchema>;
