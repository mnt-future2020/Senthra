import { isChipActive } from "./attentionChip";
import type { AttentionItem, AttentionTone } from "@/services/attention.service";

// The two arithmetic rules behind the folded attention trigger, kept as pure functions for the same
// reason attentionChip.ts is: both fail silently in the browser. A miscounted trigger overstates the
// backlog, and a missed active item hides an applied filter behind a closed panel — which is the one
// thing folding a filter away is not allowed to do.

/** critical > attention > info — the order the server sorts by, restated for the tone comparison. */
const SEVERITY: Record<AttentionTone, number> = { info: 0, attention: 1, critical: 2 };

/**
 * What the trigger says: one number and one colour for a whole set of queues.
 *
 * COUNT skips subset children. "Critical stock" is the urgent slice of "Items to reorder", not five
 * more items of work, so adding both would claim a backlog that does not exist — the same rule the
 * server's `byNav` rollup and the sidebar badge already apply, restated here because a `keys` set can
 * span two nav rows and so has no server rollup to read.
 *
 * TONE does NOT skip them. The two answer different questions: a subset adds no work but is still
 * urgent work, and "5 of the 6 reorders are critical" must not paint a calm amber trigger.
 *
 * Null when there is nothing pending, so a clear desk renders no control at all.
 */
export function attentionRollup(items: readonly AttentionItem[]): { count: number; tone: AttentionTone } | null {
  if (items.length === 0) return null;
  const count = items.reduce((sum, i) => (i.subsetOf ? sum : sum + i.count), 0);
  const tone = items.reduce<AttentionTone>((worst, i) => (SEVERITY[i.tone] > SEVERITY[worst] ? i.tone : worst), "info");
  return { count, tone };
}

/**
 * What the trigger reads. Hiding a filter behind a control is only safe if you can still see that it
 * is on — and, as the first attempt proved, seeing THAT one is on is not the same as seeing WHICH.
 *
 * Unfiltered it names the control and shows the backlog total. Filtered to one queue it becomes that
 * queue — its name and ITS count, never the total. That pairing is the whole point: a queue's name
 * beside the 52-item backlog reads as "52 ready to close", a claim the user can check against the
 * list footer and find false.
 *
 * Two queues applied at once names neither, because naming one would claim the list is narrowed by
 * that one alone. Rare — it needs two catalog entries resolving to filters that can both hold — but
 * a control that lies in the rare case is a control you cannot trust in the common one.
 */
export function triggerState(
  total: number,
  applied: readonly AttentionItem[],
): { label: string; count: number; filtered: boolean } {
  if (applied.length === 0) return { label: "Needs attention", count: total, filtered: false };
  if (applied.length === 1) return { label: applied[0].label, count: applied[0].count, filtered: true };
  return { label: `${applied.length} filters`, count: total, filtered: true };
}

/**
 * The queues the screen is CURRENTLY filtered to. Feeds `triggerState` above, the tick on the panel
 * row, and the Clear action.
 *
 * Returns a list rather than the first hit: two queues can in principle resolve to the same filter,
 * and showing one while silently applying both would misreport the screen.
 */
export function activeItems(
  items: readonly AttentionItem[],
  pathname: string,
  params: { get: (key: string) => string | null },
): AttentionItem[] {
  return items.filter((i) => isChipActive(i.href, pathname, params));
}
