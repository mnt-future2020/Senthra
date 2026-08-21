"use client";

import { useAttention, useAttentionCount } from "@/hooks/useAttention";
import type { AttentionEntityRow, AttentionTone } from "@/services/attention.service";
import { countPillCls } from "@/components/ui/styles";

// Pending-work counts rendered ON the thing that holds the work — a module tab, a warehouse row, a
// customer row. This is the surface that carries every queue with no screen of its own: those counts
// have no href precisely because the work is done inside ONE record, so the number belongs on that
// record's row or tab, where clicking it means something.
//
// Quieter than the sidebar badge on purpose: a tab strip and a table are already dense, and this is a
// hint about where to look, not an alarm.

const TONE: Record<AttentionTone, string> = {
  critical: "bg-[var(--neg)]/12 text-[var(--neg)]",
  attention: "bg-amber-500/12 text-amber-600",
  info: "bg-[var(--accent)]/12 text-[var(--accent)]",
};

/**
 * The pill itself. Renders nothing at zero — a count of 0 is not news, and a row of grey zeroes down
 * a table is pure noise. Counts are unbounded in principle, so the TEXT is capped while the
 * aria-label keeps the exact number.
 */
export function CountPill({
  count,
  tone,
  label,
  describe,
  className = "",
}: {
  count: number;
  tone: AttentionTone;
  /** what the number means; rendered as "<count> <label>" for screen readers and the hover title */
  label?: string;
  /** the whole description, when the caller has already composed one (see EntityCountPill) */
  describe?: string;
  className?: string;
}) {
  if (count <= 0) return null;
  const text = describe ?? `${count} ${label ?? "needing attention"}`;
  return (
    <span
      aria-label={text}
      title={text}
      className={`${countPillCls} ${TONE[tone]} ${className}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * A count on a module tab, read from the shared attention context — so the tab, the sidebar badge and
 * the dashboard strip are the same number by construction; there is no way for a tab to show "3" while
 * the sidebar shows "4".
 *
 * Renders nothing when the queue is empty, when the actor can't see that key, or while the first fetch
 * is in flight (a badge that flashes in on every navigation is worse than one that arrives a beat
 * late). Unknown keys render nothing too, so a tab can adopt a count before the key exists.
 */
export function TabCount({ attentionKey }: { attentionKey: string }) {
  const hit = useAttentionCount(attentionKey);
  if (!hit) return null;
  return <CountPill count={hit.count} tone={hit.tone} label={hit.label.toLowerCase()} className="ml-1.5" />;
}

/**
 * One warehouse's / customer's total, with the BREAKDOWN in its hover and screen-reader text —
 * "3 field stock requests · 1 van return to scan in" rather than a bare "4".
 *
 * This is what a number needs to earn a column: the sidebar badge's whole problem was being a count
 * with no nouns, and a per-row count repeats that mistake if all it says is how many. Wording comes
 * from the catalog payload the shell already fetched, so a queue is named identically here, on the
 * dashboard strip and in the sidebar tooltip — there is no second copy of these strings to drift.
 */
export function EntityCountPill({ row, at }: { row: AttentionEntityRow | undefined; at?: string }) {
  const { attention } = useAttention();
  if (!row || row.count <= 0) return null;
  const parts = Object.entries(row.keys)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${n} ${attention.items.find((i) => i.key === key)?.label.toLowerCase() ?? key}`);
  // The two payloads arrive independently, so the breakdown can be empty for a beat while the count is
  // already true. Fall back to the plain total rather than rendering a pill with no explanation.
  const text = parts.length ? parts.join(" · ") : `${row.count} awaiting action`;
  return <CountPill count={row.count} tone={row.tone} describe={at ? `${text} — ${at}` : text} />;
}
