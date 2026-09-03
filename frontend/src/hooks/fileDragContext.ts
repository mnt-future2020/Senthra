"use client";

import * as React from "react";

// The "a file is being dragged over this window" signal, in its own module.
//
// It lives apart from both the provider that publishes it and the hook that consumes it purely to
// keep the import graph a DAG: `useFileDrop` reads it, `FileDragProvider` writes it, and the
// provider also imports the pure drag rules from `useFileDrop`. Putting the context in either of
// those files makes that a cycle.
//
// ## Why a session NUMBER and not a boolean
//
// A boolean says "a drag is happening". It cannot say "a DIFFERENT drag is happening", and that
// distinction is the whole of a bug this shipped with:
//
//   1. drag a file over the Quote group — it shows the solid "over" outline;
//   2. press Escape. No `dragleave` and no `drop` reach that element, so its own state still says
//      "the file is over me". The boolean going false merely HID that;
//   3. start a second drag and hover the OTHER group. The boolean is true again, the stale state is
//      unmasked, and BOTH groups show the solid outline — on a form whose two areas mean different
//      things and where the outline is the only thing saying which one will receive the file.
//
// Numbering the drags fixes it by construction rather than by cleanup. Every target records which
// session its state belongs to; state from session N is ignored in session N+1, so no element can
// carry a stale "the file is over me" across drags, however abnormally the last one ended.

/** The current drag session: 0 when no file drag is in flight, otherwise a per-drag id. */
export const FileDragContext = React.createContext(0);

/**
 * The current file-drag session id, or 0 when none.
 *
 * Defaults to 0 with no provider, which is the honest answer rather than a crash: a surface
 * rendered outside the dashboard shell (a test, a standalone page) simply never shows the armed
 * affordance, and its drop target still works exactly as before.
 */
export function useFileDragSession(): number {
  return React.useContext(FileDragContext);
}
