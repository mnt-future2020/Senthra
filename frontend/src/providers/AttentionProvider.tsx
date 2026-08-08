"use client";

import * as React from "react";

import { getAttention, type AttentionSummary } from "@/services/attention.service";
import { subscribe } from "@/lib/socket";
import { useAuth } from "@/hooks/useAuth";
import { canSeeAttention } from "@/lib/auth";

// ── The ONE attention fetch for the whole dashboard ────────────────────────────────────────────
//
// Mounted once in the dashboard shell. The sidebar badges, the dashboard attention strip and every
// module tab count read this context — so a page load makes exactly ONE /attention request no matter
// how many badge-able rows are on screen (the alternative, a fetch per nav item, is ~20 requests).
//
// Transport is the shared socket, not polling: the backend fires `attention:changed` from the same
// wrappers that already emit each module's own event, so acting anywhere in the product refreshes
// everyone's badges. Bursts are debounced into one refetch; refetches pass `fresh` to skip the
// server's 10s burst cache.
//
// The one thing sockets cannot signal is the PASSAGE OF TIME — "overdue" and "due today" are
// computed against the company timezone's day boundary, so a screen left open across midnight would
// keep yesterday's numbers. Hence a slow safety refresh (below), which is a backstop, not the
// transport: it is one request per five minutes for the entire app, and it stops while the tab is
// hidden.

/** Backstop for time-derived counts (overdue rolling over at midnight). Not the update mechanism. */
const SAFETY_REFRESH_MS = 5 * 60_000;
/** A workflow transition fires several emits; collapse the burst into one refetch. */
const SOCKET_DEBOUNCE_MS = 400;
const ATTENTION_EVENTS = ["attention:changed"] as const;

const EMPTY: AttentionSummary = { items: [], byNav: {}, total: 0, errors: [], calculatedAt: "" };

export type AttentionContextValue = {
  attention: AttentionSummary;
  /** true until the first response lands — badges render nothing rather than flashing a zero */
  loading: boolean;
  /** force a refetch (bypasses the server cache); used after a mutation on the current screen */
  refresh: () => void;
};

export const AttentionContext = React.createContext<AttentionContextValue | null>(null);

export function AttentionProvider({ children }: { children: React.ReactNode }) {
  const { principal } = useAuth();
  // Staff only. The PERMISSION question is answered server-side against the attention catalog, not
  // here — see canSeeAttention. A client-side permission list would have to mirror the catalog by
  // hand and silently blank a role's badges the moment the two drifted.
  const enabled = canSeeAttention(principal);

  const [attention, setAttention] = React.useState<AttentionSummary>(EMPTY);
  const [loading, setLoading] = React.useState(true);

  // Race guard: responses can land out of order (a socket refetch overtaking the mount fetch), and a
  // stale one must never overwrite a newer one. Same pattern as OverviewView.
  const reqSeq = React.useRef(0);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = React.useCallback(
    async (fresh: boolean) => {
      const seq = ++reqSeq.current;
      // Yield one microtask so an effect-triggered load never sets state synchronously inside the
      // effect body (react-hooks/set-state-in-effect). Same shape as OverviewView's loader.
      await Promise.resolve();
      if (!alive.current || seq !== reqSeq.current) return;
      try {
        const next = await getAttention(fresh);
        if (!alive.current || seq !== reqSeq.current) return;
        setAttention(next);
      } catch {
        // Swallowed on purpose. Badges are ambient chrome, not a screen: a failed attention fetch
        // must never raise an error banner or clear counts that are already correct on screen. The
        // next socket event, safety tick or tab focus recovers it. (Per-source failures don't even
        // reach here — the server degrades those to an absent key plus an `errors` entry.)
      } finally {
        if (alive.current && seq === reqSeq.current) setLoading(false);
      }
    },
    [],
  );

  // Mount fetch (cached — this is the burst the server cache exists for). The disabled case needs no
  // effect at all: it's derived below, so a principal with no attention surface makes no request and
  // never sits in a loading state.
  React.useEffect(() => {
    if (!enabled) return;
    // Async IIFE — the fetch settles state in continuations, never synchronously in the effect body.
    void (async () => {
      await load(false);
    })();
  }, [enabled, load]);

  // Live updates. `subscribe` also re-fires on RECONNECT, so events missed while offline are caught
  // up without any extra handling here.
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

  // Time-passage backstop + catch-up when the tab comes back. Both are paused while hidden, so a
  // backgrounded tab makes no requests at all.
  React.useEffect(() => {
    if (!enabled) return;
    const tick = () => { if (!document.hidden) void load(true); };
    const timer = setInterval(tick, SAFETY_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, load]);

  const refresh = React.useCallback(() => { void load(true); }, [load]);

  const value = React.useMemo<AttentionContextValue>(
    () => (enabled ? { attention, loading, refresh } : { attention: EMPTY, loading: false, refresh }),
    [enabled, attention, loading, refresh],
  );

  return <AttentionContext.Provider value={value}>{children}</AttentionContext.Provider>;
}
