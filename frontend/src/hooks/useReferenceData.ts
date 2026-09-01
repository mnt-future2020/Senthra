"use client";

import * as React from "react";

import { isPermissionError } from "@/lib/api";
import { useDashboard } from "@/hooks/useDashboard";

// Shared loader for form "reference data" — the supplier / warehouse / item / job lists that
// populate a form's pickers. Replaces the copy-pasted `list…().then(setState, () => {})` idiom
// whose silent `() => {}` swallowed every failure, so a missing read permission showed up only
// as a mysteriously empty dropdown with no explanation.
//
// On failure it raises ONE actionable toast per source, distinguishing a permission wall (403)
// from a genuine error:
//   • 403  → "Couldn't load {label} — you don't have permission to view {label}."
//   • else → "Couldn't load {label}. {server message}"
// The mount fetch is still non-fatal (a form with one empty picker stays usable), so the caller
// keeps its own state; this only handles fetching + user-visible failure reporting.

export interface ReferenceSource<T> {
  // Human label for the data, lowercase, used verbatim in the toast (e.g. "suppliers", "the item catalogue").
  label: string;
  // The loader — typically a thin service call returning the list to store.
  load: () => Promise<T>;
  // Receives the loaded value. Not called if the component unmounted first or the load failed.
  onData: (data: T) => void;
  /**
   * Optional. Receives the rejection, IN ADDITION to the toast — for a source whose absence leaves a
   * visible hole the user is owed a durable explanation for.
   *
   * The toast is the alert; it is gone in seconds. A form that quietly drops a whole panel (the PRF
   * and PO supplier section, when the caller may pick a supplier but not read one) needs the reason
   * to still be on screen afterwards, and to read the same as it does when the user picks a supplier
   * by hand rather than arriving on an edit.
   */
  onError?: (err: unknown) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous sources; each is internally typed.
type AnySource = ReferenceSource<any>;

export interface ReferenceDataState {
  // True from the moment the loaders start until EVERY source has settled (resolved or failed).
  // Wire it to a picker's `disabled` + a "Loading …" placeholder so an unfetched dropdown reads
  // as loading rather than as a genuinely empty list. `false` when there are no sources to load.
  isLoading: boolean;
}

/**
 * Load every source once on mount (in parallel), routing failures to a toast. Re-runs if `deps`
 * change (pass e.g. `[open]` to (re)load when a modal opens). The `sources` array itself is read
 * fresh each run but is NOT a dependency — pass real inputs via `deps` to avoid an identity loop.
 *
 * Returns `{ isLoading }` so callers can show a loading state on their pickers. Existing callers
 * that ignore the return value keep working unchanged.
 */
export function useReferenceData(sources: AnySource[], deps: React.DependencyList = []): ReferenceDataState {
  const { pushToast } = useDashboard();
  // Keep the latest sources without making them a hook dependency (they're rebuilt every render).
  // Written in an effect, never during render, so it never trips the ref-during-render rule.
  const sourcesRef = React.useRef(sources);
  React.useEffect(() => {
    sourcesRef.current = sources;
  });

  // Seed from the CURRENT sources so the first paint already reflects "loading" when there's work
  // to do — avoids a one-frame flash of an enabled-but-empty picker before the effect runs.
  const [isLoading, setIsLoading] = React.useState(() => sources.length > 0);

  React.useEffect(() => {
    let active = true;
    const batch = sourcesRef.current;
    if (batch.length === 0) {
      // A re-run (deps changed) may go from "had sources" to "none" — clear any stale loading.
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    let remaining = batch.length;
    const settle = () => {
      // Flip to done only once the LAST loader settles, and only if still mounted on this run.
      if (active && --remaining === 0) setIsLoading(false);
    };
    for (const src of batch) {
      src.load().then(
        (data) => {
          if (active) src.onData(data);
          settle();
        },
        (err: unknown) => {
          if (active) {
            const msg = isPermissionError(err)
              ? `Couldn't load ${src.label} — you don't have permission to view ${src.label}.`
              : `Couldn't load ${src.label}. ${err instanceof Error ? err.message : "Please try again."}`;
            pushToast(msg, "alert");
            src.onError?.(err);
          }
          settle();
        },
      );
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sources via ref; caller controls re-runs via `deps`.
  }, deps);

  return { isLoading };
}
