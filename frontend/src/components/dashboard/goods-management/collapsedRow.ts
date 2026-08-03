import type { GoodsLineStatus, QueueKitLine } from "@/types/goodsManagement";

/**
 * Totals for a COLLAPSED job row — the single line shown in place of the job's kit lines.
 *
 * Collapsing has to AGGREGATE, never blank out. A folded row whose number columns went empty would
 * be strictly worse than not folding at all: the manager loses the figures that make the queue worth
 * scanning and has to expand every job to get them back, which is the opposite of shrinking the view.
 *
 * `returned` and `toReturn` come from the caller's maps rather than off the line, because both are
 * apportioned across an item's warehouse lines (effectiveReturns / distributeToReturn) — a line's own
 * `returnedQty` holds the ITEM's total, so summing it raw would count a split item's returns once per
 * warehouse and report more coming back than ever went out.
 *
 * MISC lines contribute to `planned`/`issued` only. They are free text, not stock-tracked, so the
 * expanded rows print "—" for used/returned/to-return; counting them as 0 here keeps the folded total
 * equal to the sum of what those rows actually showed.
 */
export interface CollapsedTotals {
  items: number;
  planned: number;
  issued: number;
  used: number;
  returned: number;
  toReturn: number;
}

export function summariseLines(
  lines: readonly QueueKitLine[],
  effReturns: Map<string, number>,
  toReturns: Map<string, number>,
): CollapsedTotals {
  const t: CollapsedTotals = { items: lines.length, planned: 0, issued: 0, used: 0, returned: 0, toReturn: 0 };
  for (const l of lines) {
    t.planned += l.plannedQty;
    t.issued += l.issuedQty;
    if (l.lineType === "misc") continue;
    t.used += l.usedQty;
    t.returned += effReturns.get(l.id) ?? l.returnedQty;
    t.toReturn += toReturns.get(l.id) ?? 0;
  }
  return t;
}

// How far along the lifecycle each state is. Only the ORDER matters.
const RANK: Record<GoodsLineStatus, number> = {
  not_issued: 0,
  partially_issued: 1,
  issued: 2,
  awaiting_return: 3,
  returned: 4,
  used: 5,
  reconciled: 6,
};

/**
 * The status chip for a folded job row, derived from the statuses of the lines it folded.
 *
 * It must describe the SAME lines the folded row's numbers describe. Using the job's own
 * `goodsStatus` instead looked reasonable and quietly contradicted the row: that field covers the
 * WHOLE job including lines at other warehouses, so a job partly issued elsewhere read "Partial"
 * here next to an Issued column of 0 — the chip and the numbers beside it disagreeing about the same
 * row.
 *
 * Reports the LEAST advanced state present, because that is the work still outstanding here. The one
 * refinement is at the issuance boundary: a mix where some stock HAS gone out is "Partial", never
 * "Not issued", which would deny the units already with the engineer.
 */
export function foldedStatus(statuses: readonly GoodsLineStatus[]): GoodsLineStatus {
  if (statuses.length === 0) return "not_issued";
  let min = statuses[0]!;
  for (const s of statuses) if (RANK[s] < RANK[min]) min = s;
  if (min === "not_issued" && statuses.some((s) => s !== "not_issued")) return "partially_issued";
  return min;
}

/**
 * The item names a folded row is standing in for, as a tooltip.
 *
 * "2 items" alone tells the manager how much was hidden but not WHAT — which is the one thing they
 * would otherwise have to expand the job to check. Capped so a big kit can't produce a tooltip taller
 * than the screen.
 */
export function itemNamesTitle(lines: readonly QueueKitLine[], max = 12): string {
  const shown = lines.slice(0, max).map((l) => l.itemName);
  const rest = lines.length - shown.length;
  return rest > 0 ? `${shown.join("\n")}\n+${rest} more` : shown.join("\n");
}
