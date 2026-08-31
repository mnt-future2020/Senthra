import type { ReportPeriod } from "./reports.period.js";

// ── The Finance result shape — computed ONCE, consumed by every surface ────────────────────────
//
// The dashboard, the report screen, the CSV (and later XLSX and scheduled runs) all render THIS
// object. No consumer re-derives a figure, which is what stops "dashboard says £41,200 and the export
// says £39,850" — the failure mode this module was commissioned to prevent.
//
// Money is integer PENCE everywhere, matching the rest of the schema. Formatting is a presentation
// concern and happens at the edge.

/** Net / VAT / Gross for any slice. The three figures a finance reader reconciles against. */
export interface MoneyTotals {
  /** Ex-VAT. The headline "spend" figure. */
  netPence: number;
  /** Sum of PER-LINE rounded VAT — never a percentage of the net subtotal. */
  vatPence: number;
  /** netPence + vatPence. */
  grossPence: number;
}

/** One row of any breakdown — supplier, item or project. */
export interface BreakdownRow extends MoneyTotals {
  /** Stable identifier for the dimension (supplierId, irmItemId, projectId, or the unattributed key). */
  key: string;
  /** What to show. Snapshot-backed, so a rename or deletion cannot blank a historical row. */
  label: string;
  /** Secondary identifier where one helps — SKU for an item, PO count for a supplier. */
  sublabel?: string;
  /** Purchase orders contributing to this row. */
  poCount: number;
  /** Line count — makes an "expensive because one huge line" row distinguishable from a busy one. */
  lineCount: number;
  /**
   * The commitment view, per row: Σ quantity × unitPricePence and Σ receivedQuantity × unitPricePence.
   *
   * Accumulated in the SAME pass as the money above rather than derived later, so a supplier's
   * ordered/received figures are the same arithmetic as the headline `tracking` block and cannot
   * drift from it. Added for the XLSX breakdown sheets, which report them per row.
   */
  orderedPence: number;
  receivedPence: number;
  outstandingPence: number;
  /** Units — meaningful on the ITEM breakdown, where "12 of 20 delivered" is the question asked. */
  orderedQty: number;
  receivedQty: number;
}

/**
 * One PO line, priced — the row-level finance view.
 *
 * Every money field is computed by the finance service (per-line VAT, same rule as everywhere else),
 * so a renderer displays these values and never recomputes them.
 */
export interface FinanceDetailRow {
  poCode: string;
  poStatus: string;
  orderDate: string;
  supplierName: string;
  projectLabel: string;
  itemName: string;
  /** The IRM item's SKU, where it has one. */
  itemCode: string;
  quantity: number;
  receivedQuantity: number;
  outstandingQuantity: number;
  unitPricePence: number;
  vatRate: number;
  netPence: number;
  vatPence: number;
  grossPence: number;
}

/** One point on the spend trend. */
export interface TrendPoint {
  /** "2026-09" for month grain, "2026-09-04" for day grain. */
  bucket: string;
  netPence: number;
  poCount: number;
}

/** Ordered vs actually received — the commitment view a finance reader asks for next. */
export interface PoTracking {
  /** Σ quantity × unitPricePence over reportable IRM lines. Ex-VAT. */
  orderedPence: number;
  /**
   * Σ receivedQuantity × unitPricePence. `receivedQuantity` is live-maintained by Goods In
   * (incrementLineReceivedTx) and INCLUDES damaged units — they were received and they were paid for.
   */
  receivedPence: number;
  /** orderedPence − receivedPence. What the company is committed to but has not yet taken delivery of. */
  outstandingPence: number;
  poCount: number;
  supplierCount: number;
  /** Orders committed but not yet issued to a supplier — the other reading of "raised". */
  preIssuePoCount: number;
  preIssueNetPence: number;
  /** Lines where 0 < receivedQuantity < quantity. */
  partiallyReceivedLines: number;
}

/**
 * Hire money, reported BESIDE IRM spend and never inside it.
 *
 * Three separate figures because they are three separate commitments with three different (and, for
 * two of them, undecided) accounting treatments. Summing them would invent a rule the client has not
 * given us.
 */
export interface RentalTotals {
  /** Hire line value — the only one of the three that IS inside the purchase order's own totals. */
  hireNetPence: number;
  hireVatPence: number;
  hireLineCount: number;
  /**
   * Cumulative extension charges, read from the hire line's running total. Deliberately NOT summed
   * with the individual HireExtension rows, which are its breakdown — that would double-count.
   * ⚠️ Whether an extension is additional procurement spend or a variation to the original order is
   * an open client question.
   */
  extensionChargePence: number;
  /**
   * DAMAGE charges quoted by suppliers on live (non-reversed) notes — kit we still hand back, charged
   * for its condition. HDM reports plus damage found on the HRN return leg.
   * ⚠️ Whether this is procurement cost, an expense, or a recoverable is an open client question.
   * `null` charges — "not yet quoted" — are excluded, not read as zero.
   */
  damageChargePence: number;
  damageChargeLines: number;
  /**
   * LOSS charges — HLS notes: equipment that is never coming back, charged at replacement.
   *
   * A SEPARATE figure from damage, because they are separate financial events and the rental module
   * keeps them as separate note directions for exactly that reason. They share the storage column
   * (`damageChargePence`, which predates the loss direction), so a report that did not split on the
   * note's direction would state that a missing tester was merely broken.
   * ⚠️ Treatment is the same open client question as damage.
   */
  lossChargePence: number;
  lossChargeLines: number;
}

/** Orders deliberately outside every figure above, surfaced so the headline is never a silent subset. */
export interface ExcludedContext {
  draftPoCount: number;
  cancelledPoCount: number;
}

/** The complete Finance result. One computation, every surface. */
export interface FinanceSummary {
  period: {
    from: string;
    to: string;
    period: ReportPeriod;
    label: string;
    /** Company timezone the boundaries were resolved in. */
    timeZone: string;
  };
  /**
   * The statuses counted, echoed so a report says what it means by "spend" on its own face rather
   * than requiring the reader to know. Changes automatically if the client rules on D1.
   */
  basis: {
    statuses: string[];
    excluded: string[];
    dateField: "orderDate";
    currency: "GBP";
  };
  /** IRM purchase spend. Rental/hire is NOT in here. */
  totals: MoneyTotals;
  tracking: PoTracking;
  trend: { grain: "day" | "month"; points: TrendPoint[] };
  bySupplier: BreakdownRow[];
  byItem: BreakdownRow[];
  /** Includes the "Unattributed / General Procurement" row whenever such spend exists. */
  byProject: BreakdownRow[];
  rental: RentalTotals;
  excluded: ExcludedContext;
  generatedAt: string;
}
