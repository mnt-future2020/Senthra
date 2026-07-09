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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous sources; each is internally typed.
type AnySource = ReferenceSource<any>;

/**
 * Load every source once on mount (in parallel), routing failures to a toast. Re-runs if `deps`
 * change (pass e.g. `[open]` to (re)load when a modal opens). The `sources` array itself is read
 * fresh each run but is NOT a dependency — pass real inputs via `deps` to avoid an identity loop.
 */
export function useReferenceData(sources: AnySource[], deps: React.DependencyList = []): void {
  const { pushToast } = useDashboard();
  // Keep the latest sources without making them a hook dependency (they're rebuilt every render).
  // Written in an effect, never during render, so it never trips the ref-during-render rule.
  const sourcesRef = React.useRef(sources);
  React.useEffect(() => {
    sourcesRef.current = sources;
  });

  React.useEffect(() => {
    let active = true;
    for (const src of sourcesRef.current) {
      src.load().then(
        (data) => {
          if (active) src.onData(data);
        },
        (err: unknown) => {
          if (!active) return; // unmounted mid-flight — never toast a discarded load
          const msg = isPermissionError(err)
            ? `Couldn't load ${src.label} — you don't have permission to view ${src.label}.`
            : `Couldn't load ${src.label}. ${err instanceof Error ? err.message : "Please try again."}`;
          pushToast(msg, "alert");
        },
      );
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sources via ref; caller controls re-runs via `deps`.
  }, deps);
}
