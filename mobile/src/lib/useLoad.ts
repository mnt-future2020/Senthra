import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";

/**
 * Load data for a screen: fetches on first focus, silently refetches on every
 * re-focus (so returning from an action screen shows fresh data), and refetches
 * whenever the query function's identity changes (filters / search / page) —
 * callers must memoize `fn` with useCallback keyed on their query params.
 *
 * `loading` covers only the first fetch; `fetching` flags query-change refetches
 * so screens can keep the stale list visible with a subtle indicator instead of
 * blanking. Out-of-order responses are dropped so a slow earlier query can never
 * overwrite a newer result.
 */
export function useLoad<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fnRef = useRef(fn);
  // Declared before the focus effect so the ref is current by the time it loads.
  useEffect(() => {
    fnRef.current = fn;
  });
  const seqRef = useRef(0);

  const load = useCallback(async (showFetching = false) => {
    const seq = ++seqRef.current;
    if (showFetching) setFetching(true);
    try {
      setError(null);
      const result = await fnRef.current();
      if (seq !== seqRef.current) return;
      setData(result);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
        setFetching(false);
      }
    }
  }, []);

  // Tracks which fn the shown data belongs to, so a re-focus (same fn) stays a
  // silent refresh while a param change (new fn) surfaces the fetching state.
  const loadedFnRef = useRef<(() => Promise<T>) | null>(null);

  useFocusEffect(
    useCallback(() => {
      const queryChanged = loadedFnRef.current !== null && loadedFnRef.current !== fn;
      loadedFnRef.current = fn;
      fnRef.current = fn;
      void load(queryChanged);
    }, [fn, load]),
  );

  const reload = useCallback(async () => {
    await load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return { data, setData, loading, fetching, refreshing, error, reload, refresh };
}
