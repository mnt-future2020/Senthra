import {
  dayValue,
  hirePricePence,
  periodsFor,
  RATE_PERIOD_OPTIONS,
  RATE_PERIODS,
  type RatePeriod,
} from "@/lib/rentalPricing";

// The PRF form's rental-line row model.
//
// Every rule here is UX ONLY — the server's rentalLineSchema is authoritative. The messages are kept
// WORD-FOR-WORD identical to it, so a user never sees two different wordings for one rule.

/**
 * Where the hire goes back. A MODE, not a bare address: an optional address field is blank on almost
 * every line, and a blank answers nothing — which is the state this replaces. Every mode resolves to
 * a real place, so the order document can print a definite collection point on every line.
 *
 * Kept in step with the server's RETURN_MODES (rentalReturn.ts) — a value offered here that the
 * server refuses is a save button that fails on a choice the UI presented as valid.
 */
export const RETURN_MODES = ["delivery", "warehouse", "other"] as const;
export type ReturnMode = (typeof RETURN_MODES)[number];

export const RETURN_MODE_OPTIONS: { value: ReturnMode; label: string }[] = [
  { value: "delivery", label: "Same as delivery" },
  { value: "warehouse", label: "Collect from warehouse" },
  { value: "other", label: "Other address…" },
];

/** A long depot name must not stretch the select past its column. */
const NAME_MAX = 22;

/**
 * The same three modes, with the WAREHOUSE one naming its depot.
 *
 * "Collect from warehouse" never said which warehouse — and on a line delivered to a site, the depot
 * is nowhere in the row to be read off. The name comes from the warehouse already selected on the
 * header, so nothing new is resolved here: this must never derive a collection ADDRESS, because the
 * one definition of where a hire is collected from lives on the server (rentalReturn.ts) and a second
 * one on the client is how a screen and a document start naming different places.
 *
 * With no warehouse picked yet the label stays as it was — a promise about a depot nobody has chosen
 * would be a guess.
 */
export function returnModeOptions(warehouseName: string | null): { value: ReturnMode; label: string }[] {
  const name = warehouseName?.trim();
  if (!name) return RETURN_MODE_OPTIONS;
  const shown = name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1).trimEnd()}…` : name;
  return RETURN_MODE_OPTIONS.map((o) =>
    o.value === "warehouse" ? { ...o, label: `Collect from warehouse (${shown})` } : o,
  );
}

/**
 * How the hire price was arrived at.
 *
 * Suppliers quote either a figure for the whole hire or a RATE. Both are kept: the rate is the input
 * basis, the agreed unit price is the money. The RULES — part weeks bill in full, a month is a
 * CALENDAR month, the return date is not charged — live in `lib/rentalPricing`, shared with the On
 * hire screen and mirroring `backend/src/utils/rental-pricing.ts`. This file keeps only the
 * row-shaped wrappers the PRF form needs.
 */
export { RATE_PERIOD_OPTIONS, RATE_PERIODS };
export type { RatePeriod };

export interface RentalLineRow {
  _key: string;
  rentalItemId: string;
  quantity: string;
  hireStartDate: string;
  hireEndDate: string;
  notifyDaysBefore: string;
  deliveryAddress: string;
  returnMode: ReturnMode;
  returnAddress: string;
  ratePeriod: RatePeriod;
  /** The quoted rate in POUNDS, as typed. Empty on the `total` basis. */
  rate: string;
  /** Set once someone types over the calculated price — see agreedUnitPrice. */
  priceOverridden: boolean;
  unitPrice: string;
  vatRate: string;
  notes: string;
}

/** The server's default reminder lead. Shared so the blank row and the reminder readout agree. */
export const DEFAULT_NOTIFY_DAYS = 3;

export const blankRentalLine = (): RentalLineRow => ({
  _key: crypto.randomUUID(),
  rentalItemId: "",
  quantity: "1",
  hireStartDate: "",
  hireEndDate: "",
  // The server's default. Shown so the user can see and change what they will be reminded on.
  notifyDaysBefore: String(DEFAULT_NOTIFY_DAYS),
  deliveryAddress: "",
  // The default every line had before the field existed, and the right answer most of the time.
  returnMode: "delivery",
  returnAddress: "",
  // The basis every line had before a rate could be quoted: one agreed figure for the hire.
  ratePeriod: "total",
  rate: "",
  priceOverridden: false,
  unitPrice: "",
  vatRate: "20",
  notes: "",
});

/** A row the user has actually started filling in. Blank spare rows are dropped, never validated. */
const isFilled = (r: RentalLineRow) => Boolean(r.rentalItemId);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How many chargeable periods this row's hire spans. */
export function billablePeriods(r: RentalLineRow): number | null {
  return periodsFor(r.ratePeriod, r.hireStartDate, r.hireEndDate);
}

/**
 * The calculated price for ONE unit, in POUNDS — null when the basis or the rate cannot give one.
 *
 * Pence throughout, converted only at the end: the money is integer pence everywhere it is stored,
 * and £0.055/day must not accumulate a fraction of a penny per day.
 */
export function calculatedUnitPrice(r: RentalLineRow): number | null {
  if (r.rate.trim() === "") return null;
  const pence = hirePricePence(r.ratePeriod, Math.round(Number(r.rate) * 100), r.hireStartDate, r.hireEndDate);
  return pence == null ? null : pence / 100;
}

/**
 * The price the line will actually be saved with.
 *
 * The arithmetic on a rate basis — UNLESS someone typed over it, because a supplier-negotiated price
 * is a commercial fact, not a calculation. The server applies the identical rule on save.
 */
/**
 * The row patch for switching the pricing basis.
 *
 * Switching basis is a COMMERCIAL change, not a formatting one — £55/day and £55/week are different
 * money — so the rate is kept and the figure re-shown for review rather than silently carried.
 *
 * Moving to "total" is the case that needed care. On a rate basis the price box RENDERS the
 * calculated figure while `unitPrice` itself stays "", because it is only written when someone types
 * over it. "Total" has no rate to derive from, so `agreedUnitPrice` falls through to
 * `Number("" || 0)` — and the switch alone turned a £55/day × 10-day hire into a line saved at zero,
 * with the price box going visibly blank as the only warning. Carrying the calculated figure across
 * keeps the money that was on screen a moment earlier.
 *
 * A price the user TYPED is left exactly as typed: it is already the agreed figure, and overwriting
 * a negotiated total with the arithmetic is the mistake in the other direction.
 */
export function applyBasisChange(r: RentalLineRow, next: RatePeriod): Partial<RentalLineRow> {
  if (next !== "total") return { ratePeriod: next };
  const carried = r.unitPrice.trim() === "" ? calculatedUnitPrice(r) : null;
  return {
    ratePeriod: next,
    priceOverridden: false,
    ...(carried != null ? { unitPrice: carried.toFixed(2) } : {}),
  };
}

export function agreedUnitPrice(r: RentalLineRow): number {
  if (r.ratePeriod !== "total" && !r.priceOverridden) {
    const calculated = calculatedUnitPrice(r);
    if (calculated != null) return calculated;
  }
  return Number(r.unitPrice || 0);
}

/**
 * The day the reminder actually goes out, for the row's own readout.
 *
 * Mirrors the server's `computeNotifyOnDate`, CLAMP INCLUDED: a lead longer than the hire is
 * legitimate (the lead defaults to 3, so a two-day hire would otherwise be unsavable) and lands on
 * the start date rather than before it. Shown because "3" beside a date field answers "three days
 * before what?" only if you already know — a date answers it outright.
 */
export function reminderDate(r: RentalLineRow): Date | null {
  const start = dayValue(r.hireStartDate);
  const end = dayValue(r.hireEndDate);
  const lead = notifyLead(r);
  if (start == null || end == null || end <= start || lead == null) return null;
  return new Date(Math.max(end - lead * MS_PER_DAY, start));
}

/** The wire's own ceiling — `validateRentalLines` and the server both accept 0…365. */
export const MAX_NOTIFY_DAYS = 365;

/**
 * The largest lead this hire can actually honour, for the box's own `max`.
 *
 * A lead longer than the hire is not an error — the server clamps it to the start date rather than
 * refusing it — but it is a lead that cannot happen, and a box offering it produces a row that reads
 * as broken: "3" beside a reminder dated the first day of a two-day hire. So the ceiling follows the
 * dates, the same way Hire end's `min` follows the start date.
 *
 * Unknown dates stay UNCAPPED at the wire's 365. Never cap anyone on a guess.
 */
export function notifyLeadMax(hireDays: number | null): number {
  return hireDays != null && hireDays > 0 ? Math.min(hireDays, MAX_NOTIFY_DAYS) : MAX_NOTIFY_DAYS;
}

/**
 * A reminder lead, capped to the hire it belongs to — for both the box and the payload.
 *
 * `max` alone is advisory: a typed value walks straight past it, and a lead typed against a longer
 * hire outlives the shortening of that hire. So the cap is applied at READ time, exactly as the
 * kit-request modal caps quantities against availability (see `capQty`): the number on screen and
 * the number in the request body are the same by construction, and neither can be a lead the row's
 * own dates say is impossible.
 *
 * Read time, not a write back into state: the typed lead survives, so stretching the hire out again
 * brings it back rather than making someone retype it.
 *
 * A blank box is left blank — it means "the server's default", which is not a number to cap. Garbage
 * is left alone too, so `validateRentalLines` is the thing that speaks about it.
 */
export function capNotifyLead(lead: string, hireDays: number | null): string {
  if (lead.trim() === "") return lead;
  const n = Number(lead);
  if (!Number.isFinite(n)) return lead;
  const max = notifyLeadMax(hireDays);
  // Only ever REPLACES an impossible value. A lead that already fits is returned untouched, so "03"
  // is not silently reformatted under a user mid-edit.
  return n > max ? String(max) : lead;
}

/**
 * The lead in days that will ACTUALLY be stored.
 *
 * A blank box is not zero: the field is optional on the wire and the server fills in its own
 * default, so the row must promise the day that will really be used.
 */
function notifyLead(r: RentalLineRow): number | null {
  const lead = r.notifyDaysBefore.trim() === "" ? DEFAULT_NOTIFY_DAYS : Number(r.notifyDaysBefore);
  return Number.isFinite(lead) && lead >= 0 ? lead : null;
}

/**
 * The one blocking problem a single row can state for itself: an end date at or before the start.
 *
 * `validateRentalLines` already refuses it on submit, but that message lands in ONE banner under the
 * whole section — with three hire lines on screen, it says something is wrong and leaves the reader
 * to find which. This is the same rule, said on the row it belongs to, the moment the date changes.
 * The wording is the server's, word for word.
 */
export function hireRangeError(r: RentalLineRow): string | undefined {
  const start = dayValue(r.hireStartDate);
  const end = dayValue(r.hireEndDate);
  if (start == null || end == null) return undefined;
  return end <= start ? "The hire end date must be after the start date." : undefined;
}

/**
 * A NON-BLOCKING notice about a hire period that has already started, or already finished.
 *
 * Back-dating is legitimate — the tester was collected last week and the paperwork is catching up —
 * so this must never refuse the line. But an unnoticed typo in the year or the month produces a
 * purchase order that is overdue the moment it exists: the hire lands straight on the red "Hires
 * overdue for return" badge, and the reminder for it is already due. Saying so at the point the date
 * is typed costs nothing and catches the typo.
 *
 * `today` is passed in rather than read here, so this stays pure and testable (and so the caller can
 * resolve "today" once, in the viewer's timezone, without an impure read during render).
 */
export function hireDateNotice(r: RentalLineRow, today: string): string | undefined {
  const now = dayValue(today);
  const start = dayValue(r.hireStartDate);
  const end = dayValue(r.hireEndDate);
  if (now == null || start == null) return undefined;
  // The stronger case first: a period that has already ended is overdue on arrival.
  if (end != null && end < now) return "This hire period has already ended — it will show as overdue as soon as the order exists.";
  if (start < now) return "This hire has already started — check the date if that isn't deliberate.";
  return undefined;
}

/**
 * What makes a hire line ONE line.
 *
 * Item + period + delivery address, and nothing else. The physical fact — this kit, this window,
 * this place — is the identity; the price is what it costs, not what it is. So two lines that differ
 * only in pricing basis, rate, agreed price, notes or return mode are the same hire entered twice,
 * which means one delivery and one collection billed as two.
 *
 * The same composite is enforced in THREE places, and this is the readable one:
 *  - `@@unique([purchaseRequestId, rentalItemId, hireStartDate, hireEndDate, deliveryAddress])`
 *  - the server's `noDupRentalLines`, so an API client gets a message and not a raw P2002
 *  - the audit diff's `lineKey`, which pairs a line's before with its after — two lines sharing a
 *    key there make the change log pair the wrong two and report edits nobody made
 *
 * Trimmed, because the server trims and turns "" into null before it compares: an address differing
 * only in spaces is the same address on both sides of the wire.
 */
function rentalLineKey(r: RentalLineRow): string {
  return [r.rentalItemId, r.hireStartDate, r.hireEndDate, r.deliveryAddress.trim()].join("|");
}

/**
 * The `_key`s of rows that repeat an EARLIER row's identity — never the first of a set.
 *
 * Said on the row for the same reason `hireRangeError` is: the submit banner sits under the whole
 * section, and "something is duplicated" with four hire lines on screen leaves the reader to work out
 * which two. The first occurrence is deliberately left unmarked — it is the line to keep, and
 * flagging both makes the row to delete ambiguous.
 */
export function duplicateRentalRowKeys(rows: RentalLineRow[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const r of rows) {
    if (!isFilled(r)) continue;
    const key = rentalLineKey(r);
    if (seen.has(key)) dupes.add(r._key);
    else seen.add(key);
  }
  return dupes;
}

/**
 * What a duplicated row says about itself — ONE short sentence, like every other row message here.
 *
 * It names the three fields that DO make the identity, which answers "but I changed the pricing
 * basis" without a second sentence about what doesn't count: that belongs in the submit banner, where
 * there is room for the whole rule. Two sentences on the row put a paragraph of red text under a
 * 3-line hire card, next to siblings that are all one line.
 */
export const DUPLICATE_ROW_MESSAGE =
  "Same item, period and delivery address as a line above — raise that line's quantity instead.";

/** Whole days in a hire, for the form's live "30 days" readout. */
export function rowHireDays(r: RentalLineRow): number | null {
  const a = dayValue(r.hireStartDate);
  const b = dayValue(r.hireEndDate);
  return a == null || b == null ? null : Math.round((b - a) / MS_PER_DAY);
}

/** First problem found, or undefined. Returns one message so the form shows one banner. */
export function validateRentalLines(rows: RentalLineRow[]): string | undefined {
  const filled = rows.filter(isFilled);

  for (const r of filled) {
    const qty = Number(r.quantity);
    if (!Number.isFinite(qty) || qty < 1) return "Quantity must be at least 1.";
    const price = Number(r.unitPrice);
    if (r.unitPrice !== "" && (!Number.isFinite(price) || price < 0)) return "Unit price can't be negative.";
    const vat = Number(r.vatRate);
    if (r.vatRate !== "" && (!Number.isFinite(vat) || vat < 0 || vat > 100)) return "VAT must be 0–100%.";

    const start = dayValue(r.hireStartDate);
    const end = dayValue(r.hireEndDate);
    if (start == null) return "Select a hire start date.";
    if (end == null) return "Select a hire end date.";
    if (end <= start) return "The hire end date must be after the start date.";

    const lead = Number(r.notifyDaysBefore);
    if (r.notifyDaysBefore !== "" && (!Number.isFinite(lead) || lead < 0 || lead > 365)) {
      return "Reminder days must be between 0 and 365.";
    }
    if (r.deliveryAddress.trim().length > 300) return "Delivery address is too long.";
    // The one mode with no fallback to resolve to — the other two point at an address that already
    // exists. Word-for-word the server's message.
    if (r.returnMode === "other" && !r.returnAddress.trim()) return "Enter the address the hire is collected from.";
    if (r.returnAddress.trim().length > 300) return "Return address is too long.";
    if (r.ratePeriod !== "total" && r.rate.trim() === "") return "Enter the rate for the chosen pricing basis.";
    if (r.ratePeriod !== "total" && !(Number(r.rate) >= 0)) return "The rate can't be negative.";
    // The mirror of the rule above, for the one basis that has no rate to fall back on. Every other
    // basis derives its price from the rate, so an empty box there is harmless; on "total" the box IS
    // the price, and `agreedUnitPrice` reads an empty one as 0 — a hire saved at nothing. An explicit
    // "0" passes, because kit lent at no charge is a real answer and this only rejects the blank.
    if (r.ratePeriod === "total" && r.unitPrice.trim() === "") return "Enter the agreed price for the hire period.";
  }

  // The same identity the DB's compound unique index refuses — through `rentalLineKey`, so this and
  // the row-level marker can never disagree about which lines collide. A lead longer than the hire is
  // NOT checked: the server clamps it to the start date rather than refusing it.
  const keys = filled.map(rentalLineKey);
  if (new Set(keys).size !== keys.length) {
    // Word for word the server's message.
    return "The same rental item, period and delivery address can only be added once — use quantity instead. Pricing basis, rate and return details don't make it a separate line.";
  }
  return undefined;
}

export interface RentalLinePayload {
  rentalItemId: string;
  quantity: number;
  hireStartDate: string;
  hireEndDate: string;
  notifyDaysBefore?: number;
  deliveryAddress?: string;
  returnMode?: ReturnMode;
  returnAddress?: string;
  ratePeriod?: RatePeriod;
  ratePence?: number;
  priceOverridden?: boolean;
  unitPricePence: number;
  vatRate?: number;
  notes?: string;
}

/**
 * Rows → request body. Pounds become pence here, and `lineTotalPence` / `notifyOnDate` are never
 * sent: the server computes both, and sending them only invites the two to drift apart.
 */
export function toRentalPayload(rows: RentalLineRow[]): RentalLinePayload[] {
  return rows.filter(isFilled).map((r) => {
    const address = r.deliveryAddress.trim();
    const notes = r.notes.trim();
    return {
      rentalItemId: r.rentalItemId,
      quantity: Number(r.quantity),
      hireStartDate: r.hireStartDate,
      hireEndDate: r.hireEndDate,
      // The lead the BOX shows, not the one behind it. Sending the larger number would store a lead
      // the screen has never displayed, and the server would clamp it to the identical notify date
      // anyway — so the only thing the difference could ever do is make the field change value on
      // the next load.
      ...(r.notifyDaysBefore === "" ? {} : { notifyDaysBefore: Number(capNotifyLead(r.notifyDaysBefore, rowHireDays(r))) }),
      ...(address ? { deliveryAddress: address } : {}),
      ratePeriod: r.ratePeriod,
      // Only travels with a basis that uses it; the server nulls it for `total` anyway, and sending
      // a rate the user has switched away from invites the two to disagree.
      ...(r.ratePeriod !== "total" && r.rate.trim() !== "" ? { ratePence: Math.round(Number(r.rate) * 100) } : {}),
      priceOverridden: r.ratePeriod !== "total" && r.priceOverridden,
      returnMode: r.returnMode,
      // Only ever sent with the mode that uses it — the server nulls it for the other two anyway,
      // and sending a stale address the user has switched away from invites the two to disagree.
      ...(r.returnMode === "other" && r.returnAddress.trim() ? { returnAddress: r.returnAddress.trim() } : {}),
      unitPricePence: Math.round(agreedUnitPrice(r) * 100),
      ...(r.vatRate === "" ? {} : { vatRate: Number(r.vatRate) }),
      ...(notes ? { notes } : {}),
    };
  });
}

/** The rental half of the form's estimated total, in pence. */
export function rentalSubtotalPence(rows: RentalLineRow[]): number {
  return rows
    .filter(isFilled)
    .reduce((sum, r) => sum + Number(r.quantity || 0) * Math.round(agreedUnitPrice(r) * 100), 0);
}
