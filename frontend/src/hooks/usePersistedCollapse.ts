"use client";

import * as React from "react";

// Remembered "is this block collapsed?" state, persisted per key in localStorage.
//
// Extracted from DetailHeader so the Inventory Hub's summary cards use the SAME implementation
// rather than a second copy — two hand-written copies of a storage rule is exactly how the
// `?copies=` validator drifted from the typed one elsewhere in this codebase.
//
// Key it per BLOCK KIND, not per record ("detailHeader:customer-detail", "inventoryHub:summary"),
// so the choice carries across sibling pages of the same kind.

function readStored(storageKey: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(`${storageKey}:collapsed`) === "1";
  } catch {
    return false; // localStorage blocked (private mode / policy) — just stay expanded, non-fatal
  }
}

export function usePersistedCollapse(storageKey: string): [boolean, () => void] {
  // Lazy initialiser reads the persisted preference once, on the client, at mount — no effect (which
  // the "no setState in effect" lint rule forbids) and no hydration mismatch: the callers are client
  // components that render after their data loads, so there is no server-rendered markup to diverge
  // from. `typeof window` keeps the initialiser safe if ever evaluated during SSR (→ expanded).
  const [collapsed, setCollapsed] = React.useState(() => readStored(storageKey));
  const toggle = React.useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(`${storageKey}:collapsed`, next ? "1" : "0");
      } catch {
        /* best-effort persistence */
      }
      return next;
    });
  }, [storageKey]);
  return [collapsed, toggle];
}
