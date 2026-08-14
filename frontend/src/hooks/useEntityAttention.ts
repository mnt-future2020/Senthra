"use client";

import * as React from "react";

import { getEntityAttention, type AttentionDimension, type AttentionEntityRow } from "@/services/attention.service";
import { subscribe } from "@/lib/socket";
import { useAuth } from "@/hooks/useAuth";
import { canSeeAttention } from "@/lib/auth";

// ── "Where is the work?" for one list screen ───────────────────────────────────────────────────
//
// Deliberately NOT part of AttentionProvider. That context is mounted in the dashboard shell and
// fetched on every page load by every signed-in user; these counts are wanted by two list screens and
// one detail page. Folding them into the shared payload would make every navigation in the product
// pay for queries almost none of them use — so this is a local hook that only the screens showing row
// counts mount.
//
// It shares the shell's update mechanism, though: the same `attention:changed` socket event, the same
// debounce, and `fresh` on every refetch so a live update is never served from the server's burst
// cache. A screen showing a count and the sidebar badge above it must not disagree about whether a
// queue just emptied.
//
// Failure is silent by design, exactly as it is for the badges: these are hints layered onto a list
// that is perfectly usable without them, so a failed fetch leaves the previous counts on screen and
// never raises a banner over someone's warehouse table.

const SOCKET_DEBOUNCE_MS = 400;
const ATTENTION_EVENTS = ["attention:changed"] as const;

const EMPTY: Record<string, AttentionEntityRow> = {};

export function useEntityAttention(dimension: AttentionDimension): {
  rows: Record<string, AttentionEntityRow>;
  /** true until the first response lands — a row renders nothing rather than flashing a zero */
  loading: boolean;
} {
  const { principal } = useAuth();
  // Staff only, and the PERMISSION question is answered server-side against the catalog — a
  // client-side list would have to mirror it by hand and would silently blank a role's counts the
  // moment the two drifted. Same rule as AttentionProvider.
  const enabled = canSeeAttention(principal);

  const [rows, setRows] = React.useState<Record<string, AttentionEntityRow>>(EMPTY);
  const [loading, setLoading] = React.useState(true);

  // Responses can land out of order (a socket refetch overtaking the mount fetch); a stale one must
  // never overwrite a newer one. Same guard as AttentionProvider.
  const reqSeq = React.useRef(0);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = React.useCallback(
    async (fresh: boolean) => {
      const seq = ++reqSeq.current;
      // Yield a microtask so an effect-triggered load never sets state synchronously inside the effect
      // body (react-hooks/set-state-in-effect).
      await Promise.resolve();
      if (!alive.current || seq !== reqSeq.current) return;
      try {
        const next = await getEntityAttention(dimension, fresh);
        if (!alive.current || seq !== reqSeq.current) return;
        setRows(next);
      } catch {
        // Swallowed: see the header. Counts already on screen stay; the next socket event recovers.
      } finally {
        if (alive.current && seq === reqSeq.current) setLoading(false);
      }
    },
    [dimension],
  );

  React.useEffect(() => {
    if (!enabled) return;
    void (async () => {
      await load(false);
    })();
  }, [enabled, load]);

  React.useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(ATTENTION_EVENTS, () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(true), SOCKET_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, load]);

  return React.useMemo(
    () => (enabled ? { rows, loading } : { rows: EMPTY, loading: false }),
    [enabled, rows, loading],
  );
}
