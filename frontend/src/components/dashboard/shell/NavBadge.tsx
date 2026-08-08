"use client";

import { useNavAttention } from "@/hooks/useAttention";
import type { AttentionTone } from "@/services/attention.service";

// The count on a sidebar row. Reads the shared attention context — no fetch of its own, so N badge-able
// rows still cost ONE request for the page.
//
// It renders NOTHING when the row has no pending work, when the actor can't see any of that row's
// counts, or while the first fetch is in flight (a badge that flashes in on every navigation is worse
// than one that arrives a beat late). That is the whole visibility rule: the server already dropped
// zeros and permission-filtered the payload, so there is no client-side gating to get wrong here.
//
// Tone comes from the row's MOST SEVERE item, rolled up server-side. Red is deliberately rare — it
// means overdue or blocked, never just "busy". If everything is red, nothing is.

/** Tailwind classes per tone. Amber/red mirror the worklist panel's urgency language. */
const TONE_PILL: Record<AttentionTone, string> = {
  critical: "bg-[var(--neg)] text-white",
  attention: "bg-amber-500 text-white",
  info: "bg-[var(--accent)] text-white",
};

/** Collapsed rail: a dot on the icon — same three tones, no number (there's no room for one). */
const TONE_DOT: Record<AttentionTone, string> = {
  critical: "bg-[var(--neg)]",
  attention: "bg-amber-500",
  info: "bg-[var(--accent)]",
};

const TONE_WORD: Record<AttentionTone, string> = {
  critical: "overdue or blocked",
  attention: "awaiting action",
  info: "to review",
};

export function NavBadge({ navHref, collapsed }: { navHref: string; collapsed: boolean }) {
  const rollup = useNavAttention(navHref);
  if (!rollup) return null;

  // Counts are unbounded in principle; cap the rendered text so a 4-digit backlog can't blow out the
  // rail. The aria-label keeps the exact number for screen readers.
  const shown = rollup.count > 99 ? "99+" : String(rollup.count);
  const label = `${rollup.count} ${rollup.count === 1 ? "item" : "items"} ${TONE_WORD[rollup.tone]}`;

  if (collapsed) {
    return (
      <span
        aria-label={label}
        title={label}
        className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-[var(--surface)] ${TONE_DOT[rollup.tone]}`}
      />
    );
  }

  return (
    <span
      aria-label={label}
      title={label}
      className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-extrabold leading-none tabular-nums ${TONE_PILL[rollup.tone]}`}
    >
      {shown}
    </span>
  );
}
