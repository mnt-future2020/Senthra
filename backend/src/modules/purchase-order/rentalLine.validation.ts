import { z } from "zod";

import { RETURN_MODES } from "./rentalReturn.js";
import { RATE_PERIODS } from "../../utils/rental-pricing.js";
import { toCalendarDay } from "../../utils/calendar-day.js";

// ── Rental lines — ONE schema for every document that carries a hire ──────────────────────────
//
// A hired item on a purchase request or a purchase order: an IRM line plus a hire period, a
// pricing basis, and where the kit is delivered and collected. Every rule shared with an IRM line
// is mirrored field-for-field, so the two can never disagree about what a valid quantity or price is.
//
// It lives HERE, in the purchase-order module, and not beside the PRF schema that first defined it,
// because a rental line is not a request-only concept any more: a purchase order raised directly
// (no PRF behind it) carries the same line, validated by the same rules. The PRF validation imports
// and re-exports it. A leaf module deliberately — purchase-request.validation already imports
// purchase-order.validation for INCOTERM_CODES, so putting this in either of those files and
// importing it from the other would be a module cycle evaluated at load time.
//
// Kept separate from the PRF's schema rather than duplicated on the PO side: a second copy of these
// rules is how a hire that the request form accepted gets refused by the order form, or the reverse.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const MAX_NOTIFY_DAYS_BEFORE = 365;

/**
 * A hire date is a CALENDAR DAY, not an instant — normalised to UTC midnight before anything
 * compares or stores it.
 *
 * Load-bearing for more than tidiness: the DB's compound unique index includes both hire dates, so
 * without this the same item, period and address could be added twice by sending one of them with a
 * time on it, and the duplicate the index exists to refuse would sail through.
 */
const calendarDayField = (message: string) =>
  z.preprocess((v) => {
    if (typeof v !== "string" && !(v instanceof Date)) return v;
    try {
      return toCalendarDay(v);
    } catch {
      return undefined;
    }
  }, z.date({ error: message }));

/**
 * The line's FIELDS, before the cross-field rules.
 *
 * Kept apart from the rules so a document that needs one more column on the line — the
 * multi-warehouse order create, where each line names its own destination — can extend the shape and
 * then have the SAME rules chained onto it, rather than re-stating them. Whether `.extend()` carries
 * refinements across is a zod implementation detail this must never depend on.
 */
export const rentalLineFields = z.object({
  rentalItemId: z.string().regex(OBJECT_ID_RE, "Select a rental item."),
  quantity: z.coerce
    .number({ error: "Quantity is required." })
    .int("Use a whole number.")
    .min(1, "Quantity must be at least 1.")
    .max(10_000_000),
  hireStartDate: calendarDayField("Select a hire start date."),
  hireEndDate: calendarDayField("Select a hire end date."),
  // A sanity range only. A lead LONGER than the hire is legitimate and gets clamped to the start
  // date when stored — refusing it here would make every hire shorter than four days unsavable,
  // because the lead defaults to 3.
  notifyDaysBefore: z.coerce
    .number()
    .int("Use a whole number of days.")
    .min(0, "Reminder days must be between 0 and 365.")
    .max(MAX_NOTIFY_DAYS_BEFORE, "Reminder days must be between 0 and 365.")
    .optional(),
  deliveryAddress: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(300, "Delivery address is too long.").nullable().optional(),
  ),
  // HOW the price was arrived at. Optional on the way in: absent means `total`, which is what
  // every line meant before a rate could be quoted.
  ratePeriod: z.enum(RATE_PERIODS, { error: "Choose how the hire is priced." }).optional(),
  ratePence: z.preprocess(
    emptyToUndef,
    z.coerce
      .number()
      .int("The rate must be a whole number of pence.")
      .min(0, "The rate can't be negative.")
      .max(1_000_000_000)
      .nullable()
      .optional(),
  ),
  // Says the agreed price is NOT the arithmetic — someone negotiated it. The service trusts the
  // sent price only on such a line; otherwise it recomputes from the rate.
  priceOverridden: z.coerce.boolean().optional(),
  // Where the hire goes BACK. A mode rather than a bare address — see rentalReturn.ts. Optional
  // on the way in so an older client (or a line written before the field existed) still saves;
  // absent means `delivery`, which is what every such line already meant.
  returnMode: z.enum(RETURN_MODES, { error: "Choose where the hire is collected from." }).optional(),
  returnAddress: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(300, "Return address is too long.").nullable().optional(),
  ),
  unitPricePence: z.coerce
    .number({ error: "Unit price is required." })
    .int("Unit price must be a whole number of pence.")
    .min(0, "Unit price can't be negative.")
    .max(1_000_000_000),
  vatRate: z.preprocess(
    emptyToUndef,
    z.coerce.number().min(0, "VAT can't be negative.").max(100, "VAT must be 0–100%.").optional(),
  ),
  notes: z.string().trim().max(2000).optional(),
});

/** What every rental line, however its document extends the shape, has to satisfy. */
type RentalLineLike = {
  hireStartDate: Date;
  hireEndDate: Date;
  ratePeriod?: string;
  ratePence?: number | null;
  returnMode?: string;
  returnAddress?: string | null;
  quantity: number;
  unitPricePence: number;
};

/**
 * The cross-field rules, stated ONCE and chained onto every shape below.
 *
 * Chained explicitly rather than through a generic helper: zod types `refine` on the schema's own
 * inferred output, which a helper generic over "some object schema" cannot name — the output
 * collapses to `Record<string, unknown>` and every consumer loses the line's types. Listing the
 * rules once and reducing them onto each concrete shape keeps one definition and full typing.
 */
const RENTAL_LINE_RULES: { check: (l: RentalLineLike) => boolean; params: { message: string; path: string[] } }[] = [
  {
    // Both sides are already UTC midnights, so this compares calendar days.
    check: (l) => l.hireEndDate.getTime() > l.hireStartDate.getTime(),
    params: { message: "The hire end date must be after the start date.", path: ["hireEndDate"] },
  },
  {
    // A rate basis with no rate is a line whose price cannot be arrived at — and the price it would
    // then carry is whatever the client happened to send, which is the ambiguity this replaces.
    check: (l) => (l.ratePeriod ?? "total") === "total" || l.ratePence != null,
    params: { message: "Enter the rate for the chosen pricing basis.", path: ["ratePence"] },
  },
  {
    // "Other" is the one mode that carries no fallback: the other two resolve to an address that
    // already exists. Accepting it empty would store a line whose collection point is a promise the
    // document cannot keep.
    check: (l) => l.returnMode !== "other" || Boolean(l.returnAddress),
    params: { message: "Enter the address the hire is collected from.", path: ["returnAddress"] },
  },
  {
    check: (l) => l.quantity * l.unitPricePence <= Number.MAX_SAFE_INTEGER,
    params: { message: "This line total is too large. Reduce the quantity or unit price.", path: ["unitPricePence"] },
  },
];

// `.strip()` first: it drops anything the client invents — notably `lineTotalPence` and
// `notifyOnDate`, both of which the service computes. Accepting either is how a stored total stops
// matching its own line.
export const rentalLineSchema = RENTAL_LINE_RULES.reduce((s, r) => s.refine(r.check, r.params), rentalLineFields.strip());
export type RentalLineInput = z.infer<typeof rentalLineSchema>;

/**
 * What makes a hire line ONE line: item + period + delivery address, and nothing else.
 *
 * The same rental item MAY repeat with a different period or address — that is why those fields are
 * line-level. Only an identical (item, period, address) triple is an error, because that one merges
 * into quantity. Same rule the PRF's compound unique index enforces; on a purchase order there is
 * deliberately NO such index (extending a hire edits its end date), so this check is the only
 * guard a directly-raised order has — which is exactly why it is shared rather than copied.
 */
export const rentalLineIdentity = (l: {
  rentalItemId: string;
  hireStartDate: Date;
  hireEndDate: Date;
  deliveryAddress?: string | null;
}): string =>
  `${l.rentalItemId}|${l.hireStartDate.toISOString()}|${l.hireEndDate.toISOString()}|${l.deliveryAddress ?? ""}`;

const noDupRentalLines = (lines: RentalLineInput[]) => {
  const keys = lines.map(rentalLineIdentity);
  return new Set(keys).size === keys.length;
};

// The second sentence names what the key IGNORES. Without it the rule reads as arbitrary to the one
// person it fires on most: someone who did change something — the pricing basis — and cannot see
// why the line is still "the same". The form shows this wording verbatim.
export const DUPLICATE_RENTAL_LINE_MESSAGE =
  "The same rental item, period and delivery address can only be added once — use quantity instead. " +
  "Pricing basis, rate and return details don't make it a separate line.";

export const rentalItemsField = z.array(rentalLineSchema).refine(noDupRentalLines, {
  message: DUPLICATE_RENTAL_LINE_MESSAGE,
});

// ── The multi-warehouse order create ──────────────────────────────────────────────────────────
// One purchasing operation whose lines each carry their OWN destination warehouse; the service
// groups them and raises one single-warehouse order per group. A rental line there is the standard
// line plus the warehouse the hire is delivered to — the depot its custody is then anchored at.
export const splitRentalLineSchema = RENTAL_LINE_RULES.reduce(
  (s, r) => s.refine(r.check, r.params),
  rentalLineFields
    .extend({
      warehouseId: z.string({ error: "Select a warehouse." }).regex(OBJECT_ID_RE, "Select a warehouse."),
    })
    .strip(),
);
export type SplitRentalLineInput = z.infer<typeof splitRentalLineSchema>;

// The SAME hire to DIFFERENT warehouses is allowed (separate orders); the same hire twice for the
// SAME warehouse is not — the identity rule above, per group.
const noDupRentalLinesPerWarehouse = (lines: SplitRentalLineInput[]) => {
  const keys = lines.map((l) => `${l.warehouseId}:${rentalLineIdentity(l)}`);
  return new Set(keys).size === keys.length;
};

export const splitRentalItemsField = z.array(splitRentalLineSchema).refine(noDupRentalLinesPerWarehouse, {
  message:
    "The same rental item, period and delivery address can't be added twice for the same warehouse — use quantity instead. " +
    "Pricing basis, rate and return details don't make it a separate line.",
});

// At least one line of SOME kind. `items` alone used to carry this as `.min(1)`; a rental-only
// document is legitimate, so the rule lives on the body where both arrays are visible.
export const hasAnyLine = (b: { items?: unknown[]; rentalItems?: unknown[] }) =>
  (b.items?.length ?? 0) + (b.rentalItems?.length ?? 0) > 0;
export const hasAnyLineError = { message: "Add at least one item or rental line.", path: ["items"] };
