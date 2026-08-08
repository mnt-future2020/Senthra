"use client";

import * as React from "react";

import { AttentionContext, type AttentionContextValue } from "@/providers/AttentionProvider";
import type { AttentionItem, AttentionNavRollup } from "@/services/attention.service";

/**
 * The whole attention payload. Returns a safe empty value OUTSIDE the provider rather than throwing
 * (unlike useDashboard): badge consumers are ambient chrome that must render fine on any screen —
 * including ones outside the dashboard shell — and a missing badge is correct there, not a crash.
 */
export function useAttention(): AttentionContextValue {
  const ctx = React.useContext(AttentionContext);
  return ctx ?? EMPTY_CTX;
}

/**
 * The rollup for ONE sidebar row, or null when that row has nothing to show. `null` is the
 * render-nothing signal — a badge never displays a zero, and never displays while the first fetch is
 * still in flight (which would flash on every navigation).
 */
export function useNavAttention(navHref: string | undefined): AttentionNavRollup | null {
  const { attention, loading } = useAttention();
  if (!navHref || loading) return null;
  const row = attention.byNav[navHref];
  return row && row.count > 0 ? row : null;
}

/**
 * The ONE catalog item behind a module header / tab count, or null when there is nothing to show.
 * Returns the whole item (label and href included) so a surface never has to restate a queue's name —
 * the registry owns the wording. Keys come from the backend registry: an unknown key simply renders
 * nothing, so a tab can adopt a count before the key exists without a coordinated deploy.
 */
export function useAttentionCount(key: string): AttentionItem | null {
  const { attention, loading } = useAttention();
  if (loading) return null;
  return attention.items.find((i) => i.key === key) ?? null;
}

const EMPTY_CTX: AttentionContextValue = {
  attention: { items: [], byNav: {}, total: 0, errors: [], calculatedAt: "" },
  loading: false,
  refresh: () => {},
};
