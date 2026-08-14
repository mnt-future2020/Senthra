import type { GrnStatus } from "@/types/goods-in";

// ── What the "accepted" figure on a goods receipt actually means ───────────────────────────────
//
// A GRN's `acceptedQuantity` is captured while the receipt is being raised: it is the good (undamaged)
// portion of what turned up. It is NOT stock — completing the receipt is the ONLY action that writes
// inventory (goods-in.service's completeGoodsReceipt), so on a draft it is an intention and on a
// cancelled receipt it is an intention that was abandoned.
//
// The screen said "Accepted into stock 1" regardless. On a cancelled receipt that sat inches from
// "Stock impact: None (cancelled)" — the same page asserting both that a unit entered stock and that
// nothing did. It reads as "the stock went in and then someone cancelled it anyway", which is the one
// thing that cannot happen here: a completed receipt can never be cancelled (the transition table has
// no edge for it), so no accepted unit is ever un-accepted.
//
// So the wording has to follow the status. The NUMBER is always honest and always shown — it is the
// verb that was lying.

export interface AcceptedWording {
  /** Column header over the per-line accepted quantity. */
  column: string;
  /** Label for the receipt-level total, e.g. "Accepted into stock". */
  total: string;
  /** Longer explanation for a tooltip — says whether stock moved, in plain words. */
  hint: string;
}

// All three read as "<verb phrase> into stock <number>", so the totals row scans as one sentence per
// figure and the number always lands in the same place. The reason a cancelled receipt posted nothing
// belongs in the hint, not in the label: a clause in the middle ("Not accepted — receipt cancelled 1")
// pushes the number past a full stop's worth of text and stops reading as a figure at all.
const WORDING: Record<GrnStatus, AcceptedWording> = {
  // Nothing has posted yet, and the Quality card already says "N unit(s) on completion" — so the
  // future tense here agrees with it instead of contradicting it.
  draft: {
    column: "To accept",
    total: "To accept into stock",
    hint: "Good units this receipt will add to stock when it is completed. Nothing has been posted yet.",
  },
  completed: {
    column: "Accepted",
    total: "Accepted into stock",
    hint: "Good units added to warehouse stock by this receipt. Damaged units are recorded but never enter stock.",
  },
  // Negated, not past-conditional: "Was to accept" is three words of grammar in a row of one-word
  // headers, and it describes an intention rather than the outcome. What the reader needs is that
  // these units did NOT reach stock.
  cancelled: {
    column: "Not accepted",
    total: "Not accepted into stock",
    hint: "This receipt was cancelled before completion, so none of these units entered stock.",
  },
};

export function acceptedWording(status: GrnStatus): AcceptedWording {
  // An unknown status is treated as unfinished rather than as posted: claiming stock moved when it
  // may not have is the failure mode worth avoiding, and `draft` is the only state a GRN starts in.
  return WORDING[status] ?? WORDING.draft;
}

/**
 * The one-line summary on a list row — "2 lines · 3 accepted".
 *
 * Same problem, smaller: on a draft or cancelled row that phrasing claimed stock that had not moved.
 * A zero total is dropped entirely, since "0 accepted" beside a line count is noise.
 */
export function lineSummary(lineCount: number, totalAccepted: number, status: GrnStatus): string {
  const lines = `${lineCount} line${lineCount === 1 ? "" : "s"}`;
  if (totalAccepted <= 0) return lines;
  const verb = status === "completed" ? "accepted" : status === "cancelled" ? "not accepted" : "to accept";
  return `${lines} · ${totalAccepted} ${verb}`;
}
