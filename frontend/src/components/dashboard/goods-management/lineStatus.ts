import type { GoodsLineStatus, QueueKitLine } from "@/types/goodsManagement";

// Per-LINE lifecycle status for the Goods Management queue.
//
// The job's goodsStatus gates the return phase: stock that's been issued is just OUT WITH THE ENGINEER
// ("Issued") while they do the work — it only becomes "Awaiting return" once the engineer completes the
// job and declares what they used (the backend flips goodsStatus to "awaiting_return" then, or when a
// return is posted). Within the return phase the per-line state derives from the engineer's REAL
// holding (toReturn) plus actual returns/used.
//
//   Not issued → Partial → Issued → [job completed] → Awaiting return (still held) → Returned / Used.
//
// Extracted from GoodsManagementTab so the rule can be pinned by tests — the cancelled case below was
// wrong for as long as it lived inline, with nothing to catch it.

/** Only the fields the rule reads, so a test needn't build a whole QueueKitLine. */
export type StatusKitLine = Pick<QueueKitLine, "lineType" | "plannedQty" | "issuedQty" | "usedQty">;

export function lineStatus(
  line: StatusKitLine,
  goodsStatus: string,
  returned: number,
  toReturn: number,
  jobCancelled = false,
): GoodsLineStatus {
  const { lineType, plannedQty, issuedQty, usedQty } = line;
  if (issuedQty <= 0) return "not_issued";
  // "Partial" means "some of this line has gone out, the rest is still to come". On a CANCELLED job
  // the rest is never coming — issuing is refused outright and the pending handovers are withdrawn on
  // cancel — so the shortfall against `plannedQty` is not an outstanding-work signal at all, and
  // reading it as one put "Partial" next to stock whose only remaining move is BACK to the warehouse.
  // Skipping the branch lets the return-phase rules below describe the line, which is the truth: the
  // engineer is holding units that have to come home.
  if (!jobCancelled && issuedQty < plannedQty) return "partially_issued";
  if (lineType === "misc") return "issued"; // misc is free-text — only issuance applies
  // Not in the return phase yet → the engineer is still using the stock; show plain "Issued".
  if (goodsStatus !== "awaiting_return") return "issued";
  if (toReturn > 0) return "awaiting_return"; // job completed but engineer still holds some
  if (returned > 0) return "returned";
  if (usedQty > 0) return "used";
  return "issued";
}
