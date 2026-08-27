import type { Prisma } from "@prisma/client";

// ── THE canonical Finance definitions — one file, every consumer ───────────────────────────────
//
// The dashboard, the report, the CSV (and later XLSX and scheduled runs) all resolve their status
// rule and their "what counts as spend" rule from HERE. Nothing else in the reporting path may write
// a status literal.
//
// This exists because the codebase already shipped THREE disagreeing answers to "what is spend":
//   • ISSUED_PO_STATUSES        sent…closed              — the dashboard spend trend
//   • spendPenceForSupplier     fully_received | closed  — the supplier Procurement tab
//   • COMMITTED_PO_STATUSES     open-except-draft        — the open-commitment summary
// The supplier page and the dashboard therefore show DIFFERENT totals for the same supplier today.
// Those three stay exactly as they are — they answer their own questions and other screens depend on
// them — but Finance reporting resolves through this module and only this module.

/**
 * What Finance counts as spend.
 *
 * ⚠️ BUSINESS DEFINITION — "based on Purchase Orders raised" (client FLOW 10) does not say whether
 * "raised" means APPROVED (a commitment exists) or SENT (the supplier has it). Pending the client's
 * answer we count the whole committed lifecycle and exclude only the two statuses that are not spend
 * by anyone's reading:
 *   • draft     — "a draft is workload, not spend" (the codebase's own words, purchase-order.repository)
 *   • cancelled — retains a value on the row, but the money was never committed
 *
 * If the client rules that "raised" means SENT, this array is the ONE edit — every count, breakdown,
 * export and total follows it. That is the whole reason it is a named constant and not a `where`
 * clause written at each call site.
 */
export const REPORTABLE_PO_STATUSES = [
  "pending_approval",
  "approved",
  "pm_review",
  "sent",
  "supplier_accepted",
  "partially_received",
  "fully_received",
  "closed",
] as const;

/**
 * Committed but not yet with the supplier — reported as its own line so BOTH readings of "raised"
 * are visible on the same screen and neither is hidden behind the other. If the client picks the
 * narrower reading, this subset is what moves out of the headline figure.
 */
export const PRE_ISSUE_PO_STATUSES = ["pending_approval", "approved", "pm_review"] as const;

/** Statuses deliberately outside every Finance figure. Named so a reader sees the intent, not a gap. */
export const EXCLUDED_PO_STATUSES = ["draft", "cancelled"] as const;

/**
 * Soft-delete guard for a purchase order.
 *
 * Mongo does not match `{ deletedAt: null }` against a row whose insert omitted the field, so both
 * shapes have to be asked for — the same OR every other read in this codebase carries. Getting this
 * wrong silently drops every pre-column order out of the accounts.
 */
export const LIVE_PO = {
  OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
} satisfies Prisma.PurchaseOrderWhereInput;

/**
 * The single Finance `where` on purchase orders. Every Finance read starts here.
 *
 * `orderDate` is the date key: it is the business date the supplier sees on the printed order, it is
 * required at create, and it is what the existing spend trend already keys on. `createdAt` is the
 * system fact and would disagree with the paperwork; `sentAt` is null for anything not yet issued.
 */
export function financePoWhere(range: { from: Date; to: Date }): Prisma.PurchaseOrderWhereInput {
  return {
    ...LIVE_PO,
    status: { in: [...REPORTABLE_PO_STATUSES] },
    orderDate: { gte: range.from, lte: range.to },
  };
}

/**
 * The widest custom period a CALLER may ask Finance for, in days.
 *
 * A financial year is the largest window this report describes — the trend axis already switches to
 * month grain above ~62 days and has nothing further to say beyond twelve of them. Without a bound,
 * `?period=custom&from=2000-01-01&to=2030-12-31` made the two-step read fetch every purchase order
 * ever raised, and every line under it, into one process's memory. 366 covers a leap year, so no
 * legitimate full-year request is refused.
 *
 * Applied at the HTTP boundary only. The scheduler composes its own range from a cadence and is
 * bounded by construction, so it is not subject to a rule about what a user may type into a URL.
 */
export const MAX_CUSTOM_RANGE_DAYS = 366;

/**
 * Hard ceiling on the purchase orders one Finance read will load.
 *
 * Defence in depth behind the range bound: if a single legitimate year ever exceeded this, the read
 * REFUSES rather than silently returning a subset. A truncated set of orders is a wrong total, and a
 * wrong total that looks like a right one is the worst failure a finance report has.
 */
export const MAX_FINANCE_POS = 20_000;

/** The label an unattributed row is reported under. ONE string — screens, CSV and tests share it. */
export const UNATTRIBUTED_PROJECT_LABEL = "Unattributed / General Procurement";
/** Stable key for the unattributed bucket, so a consumer can find it without matching on the label. */
export const UNATTRIBUTED_PROJECT_KEY = "__unattributed__";

/**
 * Stable key for the folded remainder of a capped breakdown. Lets a renderer style it as the summary
 * row it is rather than matching on a label that has a count in it.
 */
export const OTHER_BREAKDOWN_KEY = "__other__";

/**
 * How many breakdown rows the SCREEN receives per dimension.
 *
 * The screen only: exports pass no limit and carry every row, because a file is where the detail is
 * meant to live and a spreadsheet has no trouble with two thousand lines. The remainder is folded
 * into one row rather than dropped, so both containers still reconcile to the same headline.
 */
export const SCREEN_BREAKDOWN_ROWS = 50;

/**
 * VAT for one line, in pence.
 *
 * A MIRROR of purchase-order.service.ts `computeTotals`, deliberately: it rounds PER LINE and then
 * sums, so a Finance re-sum ties EXACTLY to the stored header on an IRM-only order. Rounding a
 * bucket subtotal instead (per supplier, per month) would drift from the orders it is built from and
 * a finance reader would find totals that do not reconcile to any document.
 *
 * Kept as its own function rather than imported from the purchase-order service to avoid a module
 * cycle (that service imports the rental predicate, which the reports layer also reaches). The rule
 * is pinned by a tie-out test against real PO totals.
 */
export function lineVatPence(lineTotalPence: number, vatRate: number): number {
  return Math.round((lineTotalPence * vatRate) / 100);
}

/**
 * The file formats a scheduled report can be delivered in.
 *
 * Here rather than in reportSchedule.service so the ROUTE's body schema can name the same list
 * without importing the service (and, through it, the repository and Prisma) into a validation
 * module. One vocabulary, two readers: the schema rejects anything else at the boundary and the
 * service still re-checks it, because the service outlives any one request path.
 */
export const SCHEDULE_FORMATS = ["xlsx", "csv"] as const;
export type ScheduleFormat = (typeof SCHEDULE_FORMATS)[number];
