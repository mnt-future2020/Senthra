import { api } from "@/lib/api";

// Typed wrapper over the global attention endpoint — the ONE call behind every badge in the product
// (sidebar rows, the dashboard attention strip, module tab counts). A hand-maintained mirror of the
// backend's attention.service.ts shapes; keep them structurally identical.
//
// Two guarantees the UI relies on and must not re-implement:
//   • Only keys this actor may SEE and whose count is > 0 come back — a badge never renders a zero,
//     and there is no client-side permission filtering to get wrong.
//   • `byNav`/`total` are rolled up server-side, so the sidebar badge, the strip chip and the tab
//     count are literally the same number, not three additions of the same list.

export type AttentionTone = "info" | "attention" | "critical";

export interface AttentionItem {
  key: string;
  label: string;
  count: number;
  tone: AttentionTone;
  /** sidebar row this rolls up to (an href from the nav table) */
  nav: string;
  /**
   * Where clicking it lands — deep-linked and pre-filtered.
   *
   * OPTIONAL, and absent means "this count has no screen", not "the backend forgot". Several queues
   * are aggregates across many warehouses or customers and are worked on one entity's own page, so
   * there is no list that holds the counted rows. Render those as a NUMBER: the previous build gave
   * them the bare module list, which navigated somewhere that showed none of them.
   *
   * The one exception the server resolves for us: an actor scoped to a single warehouse gets a real
   * `/dashboard/warehouses/<code>?tab=…` link for the warehouse-floor queues, because for them the
   * aggregate and that warehouse are the same rows.
   */
  href?: string;
  /**
   * Set when this item's rows are ALREADY inside another item's count — "Critical stock" is the
   * urgent slice of "Items to reorder", not extra work beside it.
   *
   * Anything that sums items must skip these, or it reports more work than exists. The sidebar badge
   * already does (the server rolls up the same way); AttentionBar's own header total is the other
   * place this matters.
   */
  subsetOf?: string;
}

/** One warehouse's / one customer's share of the work — a row count on a list screen. */
export interface AttentionEntityRow {
  count: number;
  tone: AttentionTone;
  /** key → count, so a surface can show ONE queue (e.g. a warehouse tab) rather than the row total */
  keys: Record<string, number>;
}

export interface AttentionNavRollup {
  count: number;
  /** most severe tone among the row's items — what colour the badge takes */
  tone: AttentionTone;
}

export interface AttentionSummary {
  items: AttentionItem[];
  /** rollup keyed by sidebar href, e.g. `{"/dashboard/jobs": {count: 3, tone: "critical"}}` */
  byNav: Record<string, AttentionNavRollup>;
  total: number;
  /** sources that were permitted but failed server-side; their keys are ABSENT, not zero */
  errors: string[];
  calculatedAt: string;
}

/**
 * Fetch the actor's attention summary.
 *
 * `fresh` bypasses the backend's 10s burst cache. Pass it for socket-driven refetches — the cache
 * exists to collapse the sidebar+dashboard+tab mount burst into one computation, and a live update
 * must never be delayed by it.
 */
export async function getAttention(fresh = false): Promise<AttentionSummary> {
  const { attention } = await api<{ attention: AttentionSummary }>(`/attention${fresh ? "?fresh=1" : ""}`);
  return attention;
}

/** The entity a per-row count hangs off. Must match the backend's AttentionDimension. */
export type AttentionDimension = "warehouse" | "customer";

/**
 * The same work split per warehouse / per customer, keyed by entity id.
 *
 * A SEPARATE request from getAttention on purpose: the shell fetches attention on every page load for
 * every user, while these counts are wanted by two list screens and the warehouse detail tabs. An
 * entity with nothing outstanding is absent from the map — callers must read missing as zero.
 *
 * These do NOT decompose the sidebar badge. Work that spans two warehouses (a job kitted from both, a
 * split restock) is real work at each and is counted at each, so the rows can total more than the
 * badge. Never present them side by side as if they should reconcile.
 */
export async function getEntityAttention(
  dimension: AttentionDimension,
  fresh = false,
): Promise<Record<string, AttentionEntityRow>> {
  const { entities } = await api<{ entities: Record<string, AttentionEntityRow> }>(
    `/attention/entities/${dimension}${fresh ? "?fresh=1" : ""}`,
  );
  return entities;
}
