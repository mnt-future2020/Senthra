"use client";

import * as React from "react";

import * as engineerService from "@/services/engineer.service";
import { subscribe } from "@/lib/socket";
import { useJobSocket } from "@/hooks/useJobSocket";
import { useGoodsSocket } from "@/hooks/useGoodsSocket";
import type { EngineerOverview } from "@/types/engineer";
import type { Movement } from "@/types/stock-position";

// Data source for the Engineer dashboard: the overview aggregation + the last few stock movements.
// The overview carries every count the cards need (incl. the held customer / misc pools), so a load is
// just two reads. First load shows a skeleton; later loads are silent — existing data stays on screen
// until the fresh payload swaps in. A monotonic guard drops a slow older response, and socket-triggered
// reloads are debounced so a burst of events collapses to one refetch.
const EMPTY_MOVEMENTS = { movements: [] as Movement[], nextCursor: null, hasMore: false };
// The dashboard is the fan-in point of four socket domains (jobs, goods, van-stock, kit), so one action
// can emit several events at once; coalesce them into a single refetch this long after the last event.
const REFRESH_DEBOUNCE_MS = 250;

export interface EngineerOverviewState {
  overview: EngineerOverview | null;
  recent: Movement[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  updatedAt: string | null;
  reload: () => void;
}

export function useEngineerOverview(): EngineerOverviewState {
  const [overview, setOverview] = React.useState<EngineerOverview | null>(null);
  const [recent, setRecent] = React.useState<Movement[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(null);

  // Guards against a late response landing after the component unmounts (the seqRef guard only orders
  // overlapping loads — it can't tell "superseded" from "gone"). Set in the effect, not at init, so a
  // StrictMode unmount/remount correctly flips it back to true on the second mount.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const seqRef = React.useRef(0);
  const load = React.useCallback(async () => {
    const seq = ++seqRef.current;
    // Yield one microtask so we never setState synchronously inside an effect body.
    await Promise.resolve();
    if (seq !== seqRef.current || !mountedRef.current) return;
    setRefreshing(true);
    try {
      const [ov, mv] = await Promise.all([
        engineerService.getOwnOverview(),
        engineerService.getOwnMovements({ limit: 6 }).catch(() => EMPTY_MOVEMENTS),
      ]);
      if (seq !== seqRef.current || !mountedRef.current) return;
      setOverview(ov);
      setRecent(mv.movements);
      setUpdatedAt(new Date().toISOString());
      setError(null);
    } catch (err) {
      if (seq !== seqRef.current || !mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Could not load your dashboard.");
    } finally {
      if (seq === seqRef.current && mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  React.useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // Live-update on the same events the module pages use — a job assigned/changed, a transfer arriving,
  // stock issued/returned, a field-stock review or a kit decision. All arrive on the engineer's own
  // per-user socket room (no extra permission), and re-fire on reconnect to recover missed events.
  // Debounced: because the dashboard aggregates all four streams, one action can fire a burst — this
  // collapses the burst to a single refetch. The first load and manual refresh call `load` directly so
  // they stay instant; the monotonic guard still orders any overlapping in-flight loads.
  const burstTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedLoad = React.useCallback(() => {
    if (burstTimer.current) clearTimeout(burstTimer.current);
    burstTimer.current = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
  }, [load]);
  React.useEffect(
    () => () => {
      if (burstTimer.current) clearTimeout(burstTimer.current);
    },
    [],
  );

  useJobSocket(debouncedLoad);
  useGoodsSocket(debouncedLoad);
  React.useEffect(() => subscribe(["van_stock_request:updated", "kit_request:updated"], debouncedLoad), [debouncedLoad]);

  return { overview, recent, loading, refreshing, error, updatedAt, reload: () => void load() };
}
