// The GET /dashboard/summary contract as typed interfaces (design principle: no stringly-typed
// payloads). Every section key is optional — an ABSENT key means "actor lacks permission" or
// "section failed" (see `errors`); an empty array / zero means "permitted but no data".

export interface StatCard {
  count: number;
  weeklyCreated: number[];
}
export interface OpenPosCard extends StatCard {
  /** Committed value only — open POs EXCLUDING drafts (a draft is not yet a commitment). */
  valuePence: number;
}
export interface ActiveJobsCard extends StatCard {
  /** Active jobs whose completionDate is before today (UTC). */
  overdueCount: number;
  /** Active jobs due within the next 7 days (today inclusive). */
  dueThisWeekCount: number;
}
export interface LowStockCard {
  count: number;
  criticalCount: number;
}
export interface ReorderNeededCard {
  /** Actionable Reorder-workbench rows (netted vs reservations, incoming POs, open PRFs, planned job demand). */
  count: number;
  /** Actionable rows at/below the item's critical level (or projected negative). */
  criticalCount: number;
  /** Actionable rows blocked from generation — no active primary supplier on the item. */
  supplierGaps: number;
}
export interface ExpectedThisWeekCard {
  /** Open receivable POs whose expected delivery falls within the next 7 days. */
  dueThisWeek: number;
  /** Open receivable POs whose expected delivery date has already passed. */
  overdue: number;
}
export interface GoodsReceivedCard {
  /** Completed GRNs received in the last 7 days. */
  count: number;
  /** Completed GRNs per week over the sparkline window. */
  weeklyReceived: number[];
  /**
   * The `YYYY-MM-DD` lower bound `count` was taken with, in the COMPANY timezone — what the card's
   * link passes as the Goods In list's `receivedFrom`, so the two describe one set of receipts.
   * A lower bound only, matching the count (which has no upper bound either).
   */
  receivedSince: string;
}
export interface OverdueHoldingsCard {
  /** Unreconciled jobs with stock issued more than `days` days ago. */
  count: number;
  days: number;
}
/** Spend selector window. 12m buckets by month, 90d by ISO week, 30d by day. */
export type SpendPeriod = "12m" | "90d" | "30d";
export interface SpendPoint {
  /** Bucket key — `YYYY-MM` (12m), or the bucket's start date `YYYY-MM-DD` (90d/30d). */
  period: string;
  totalPence: number;
}
export interface PipelinePoint {
  status: string;
  count: number;
}

export interface WorklistItemDTO {
  kind: string;
  id: string;
  code: string;
  title: string | null;
  priority: string | null;
  dueDate: string | null; // ISO
  ageDays: number;
  href: string;
}

export interface ActivityDTO {
  id: string;
  at: string; // ISO
  actorName: string;
  action: string;
  entity: { type: string; code: string; id: string };
}

export interface DashboardCards {
  pendingPrfs?: StatCard;
  openPos?: OpenPosCard;
  activeJobs?: ActiveJobsCard;
  lowStock?: LowStockCard;
  reorderNeeded?: ReorderNeededCard;
  expectedThisWeek?: ExpectedThisWeekCard;
  goodsReceived?: GoodsReceivedCard;
  overdueHoldings?: OverdueHoldingsCard;
}
export interface DashboardCharts {
  spendTrend?: SpendPoint[];
  /** Echoes the window the spendTrend series was computed for. */
  spendPeriod?: SpendPeriod;
  poPipeline?: PipelinePoint[];
}

export interface DashboardSummary {
  generatedAt: string; // server UTC ISO — never generated on the client
  cards: DashboardCards;
  charts: DashboardCharts;
  /** `total` is the full backlog size; `truncated` is true when a source queue hit its fetch cap,
   *  so `total` is a floor (render as "N+"). `items` is the top slice shown on the dashboard. */
  worklist?: { items: WorklistItemDTO[]; total: number; truncated: boolean };
  activity?: ActivityDTO[];
  /** Section keys that were permitted but failed to compute (partial-failure signal for the FE).
   *  A no-permission section is simply absent and is NOT listed here. Absent/empty when all good. */
  errors?: string[];
}
