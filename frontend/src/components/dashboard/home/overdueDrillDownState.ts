import type { OverdueGroup, OverdueGroupsResult } from "@/types/goodsManagement";

// ── The three lifecycle decisions behind the Overdue Holdings drill-down ───────────────────────
//
// Kept as pure functions, for the same reason attentionChip.ts keeps its two URL rules that way:
// each of them failed SILENTLY in the browser — no error, no crash, just a panel showing numbers
// that contradicted the card that opened it — and none of them can be tested through the component,
// which has no DOM harness in this suite.
//
// What went wrong, and what each function now pins:
//
//   1. CLOSE cleared the engineer filter and nothing else. The previous request's RESULT stayed, so
//      reopening after narrowing to an engineer holding 2 showed "All engineers" above a subtitle
//      reading "2 jobs" — under a card reading 7. A failed request's `error` outlived the close the
//      same way, so a banner from a request that had since been fixed greeted the next open.
//   2. The RENDER branch keyed its loading state off `loading`, which is not the same thing as
//      "there is nothing to show": a close clears the data while an in-flight request is still
//      settling, and in that window the panel rendered a list header with no list under it.
//   3. A response from a PREVIOUS open must not land in the current one. The guard is a sequence
//      number bumped by every open AND every close, so a slow reply can never repopulate state that
//      was deliberately cleared.

export interface DrillDownState {
  /** The engineer the breakdown is narrowed to, or null for the whole backlog. */
  engineerId: string | null;
  /** The roster the picker offers — only ever set from an UNFILTERED load. */
  engineers: OverdueGroup[];
  data: OverdueGroupsResult | null;
  error: string | null;
}

/**
 * The state a CLOSE must leave behind: nothing from the session that just ended.
 *
 * Not "reset the filter" — reset everything the filter produced. Anything kept here reappears on the
 * next open beside a control that no longer matches it, which is the precise contradiction this
 * panel exists to remove from the dashboard.
 */
export function closedDrillDownState(): DrillDownState {
  return { engineerId: null, engineers: [], data: null, error: null };
}

/** What the panel body should render. */
export type DrillDownView = "error" | "loading" | "empty" | "list";

/**
 * Keyed on the ABSENCE of data, never on a `loading` flag.
 *
 * The two are not the same state. A close clears `data` and may leave `loading` false (the settling
 * request no longer owns the flag), and any window where both are false rendered the list's column
 * headers over nothing. Asking "is there anything to show?" has no such window.
 *
 * `error` wins over everything: a failed load has no data to fall back on, and showing an empty
 * state for a request that never completed would report "nothing is overdue" when nothing is known.
 */
export function drillDownView(s: Pick<DrillDownState, "data" | "error">): DrillDownView {
  if (s.error) return "error";
  if (!s.data) return "loading";
  return s.data.byWarehouse.length === 0 ? "empty" : "list";
}

/**
 * May a settling response write to state?
 *
 * Only when it is still the newest request. Every open takes a fresh sequence number and every close
 * burns one, so both a superseded filter change and a reply that arrives after the panel was shut
 * are dropped rather than overwriting what the current session has.
 */
export function acceptsResponse(responseSeq: number, currentSeq: number): boolean {
  return responseSeq === currentSeq;
}
