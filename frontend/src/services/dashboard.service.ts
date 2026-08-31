import { api } from "@/lib/api";

// Typed wrapper over the aggregated dashboard endpoint. These interfaces are a hand-maintained
// mirror of the backend's dashboard.types.ts — keep them structurally identical. Every section is
// optional: an ABSENT key = the actor lacks that permission; an empty array / zero = permitted but
// no data; `errors` lists sections that were permitted but failed server-side.

export interface StatCardData {
  count: number;
  weeklyCreated: number[];
}
export interface OpenPosCard extends StatCardData {
  /** Committed value only — open POs excluding drafts. */
  valuePence: number;
}
export interface ActiveJobsCard extends StatCardData {
  overdueCount: number;
  dueThisWeekCount: number;
}
export interface LowStockCard {
  count: number;
  criticalCount: number;
}
export interface ReorderNeededCard {
  count: number;
  criticalCount: number;
  supplierGaps: number;
}
export interface ExpectedThisWeekCard {
  dueThisWeek: number;
  overdue: number;
}
export interface GoodsReceivedCard {
  count: number;
  weeklyReceived: number[];
  /** `YYYY-MM-DD` lower bound the count was taken with, in the COMPANY timezone — the card's link
   *  passes it as the Goods In list's `receivedFrom` so the two describe one set of receipts. */
  receivedSince: string;
}
export interface OverdueHoldingsCard {
  count: number;
  days: number;
}
export type SpendPeriod = "12m" | "90d" | "30d";
export interface SpendPoint {
  /** Bucket key — `YYYY-MM` (12m) or the bucket's start date `YYYY-MM-DD` (90d/30d). */
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
  dueDate: string | null;
  ageDays: number;
  href: string;
}
export interface ActivityDTO {
  id: string;
  at: string;
  actorName: string;
  action: string;
  entity: { type: string; code: string; id: string };
}
export interface DashboardSummary {
  generatedAt: string;
  cards: {
    pendingPrfs?: StatCardData;
    openPos?: OpenPosCard;
    activeJobs?: ActiveJobsCard;
    lowStock?: LowStockCard;
    reorderNeeded?: ReorderNeededCard;
    expectedThisWeek?: ExpectedThisWeekCard;
    goodsReceived?: GoodsReceivedCard;
    overdueHoldings?: OverdueHoldingsCard;
  };
  charts: { spendTrend?: SpendPoint[]; spendPeriod?: SpendPeriod; poPipeline?: PipelinePoint[] };
  /** `total` = full backlog; `truncated` true when it's a floor (a queue hit its fetch cap → "N+").
   *  `items` is the top slice the dashboard shows. */
  worklist?: { items: WorklistItemDTO[]; total: number; truncated: boolean };
  activity?: ActivityDTO[];
  /** Section keys that were permitted but failed server-side. Absent when all sections succeeded.
   *  A no-permission section is simply absent from cards/charts and is NOT listed here. */
  errors?: string[];
}

export async function getDashboardSummary(spendPeriod: SpendPeriod = "12m"): Promise<DashboardSummary> {
  const qs = spendPeriod === "12m" ? "" : `?spendPeriod=${spendPeriod}`;
  const { summary } = await api<{ summary: DashboardSummary }>(`/dashboard/summary${qs}`);
  return summary;
}
