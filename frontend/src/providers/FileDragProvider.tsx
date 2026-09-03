"use client";

import * as React from "react";

import { FileDragContext } from "@/hooks/fileDragContext";
import { dragCarriesFiles, strayDragAction } from "@/hooks/useFileDrop";

// ── The app-wide file-drag guard ───────────────────────────────────────────────────────────────
//
// Two jobs, one set of window listeners, because both need exactly the same events and splitting
// them would mean tracking the same drag twice.
//
// ## 1. Nothing dropped on this app may navigate the tab
//
// A drop target protects the pixels it covers. Everywhere else — the form background, a heading, the
// help text 20px below the picker — is still the BROWSER's drop target, and the browser's default
// for a file is to navigate to it. On a half-finished purchase request that is the entire form gone,
// with no undo and no warning.
//
// The gap was measured, not guessed: on the PRF create form the drop strip is 547x38 sitting inside
// a 547x83 group, so more than half of the block the user is aiming at was a miss that destroyed
// their work — and a miss onto the section around it was the same. Growing the targets (done
// separately) shrinks the odds. Only this removes the outcome.
//
// A swallowed drop is SILENT. No toast: the user aimed at a picker and missed, and the file list
// they are looking at plainly did not change. A toast for every misdrop would be noise on the one
// hand, and on the other it would have to say something like "dropped in the wrong place", which is
// a scolding for an action that now costs nothing.
//
// ## 2. Where the targets are, while a drag is in flight
//
// The pickers are deliberately compact — a button and a label, no 120px dashed rectangle eating the
// form. The cost of that is invisibility: before this, nothing on screen said a drop target existed
// until you were already hovering one. Publishing "a file drag is happening" lets every picker
// outline itself for exactly as long as the drag lasts, and go back to being a button afterwards.
//
// ## Why counting, not a boolean
//
// `dragleave` fires every time the pointer crosses into a child element, so a boolean flickers off
// dozens of times while crossing a page. Counting enter/leave pairs is the standard fix; the rest of
// the handlers exist because the browser does not guarantee a closing event at all — see below.

export function FileDragProvider({ children }: { children: React.ReactNode }) {
  // 0 = no drag. Otherwise a per-drag id, so a target can tell THIS drag from the last one — see
  // the note in fileDragContext on why a boolean is not enough.
  const [session, setSession] = React.useState(0);

  React.useEffect(() => {
    // Depth of enter/leave pairs, and the id of the drag they belong to. Both are locals rather than
    // state because they change many times per second and only the transitions through zero should
    // ever render.
    let depth = 0;
    let current = 0;
    let issued = 0;
    const setDepth = (next: number) => {
      depth = Math.max(0, next);
      if (depth > 0 && current === 0) {
        // A new drag begins. Numbering it here — once, on the 0→1 edge — is what makes every
        // target's leftover state from the previous drag identifiable as stale.
        current = ++issued;
        setSession(current);
      } else if (depth === 0 && current !== 0) {
        current = 0;
        setSession(0);
      }
    };

    const onDragEnter = (e: DragEvent) => {
      if (!dragCarriesFiles(e.dataTransfer?.types)) return;
      setDepth(depth + 1);
    };

    // A plain decrement, and deliberately NOT a `relatedTarget === null` special case for "the drag
    // left the window". That check does not survive contact with WebKit, where drag events routinely
    // leave `relatedTarget` null on an ordinary element-to-element move — there it would zero the
    // counter mid-drag and put every armed outline out while the user was still dragging. The
    // enter/leave pairs already reach zero on the way out of the window without help, and `dragend`
    // below is the backstop for the ways a drag can end without any leave at all.
    const onDragLeave = (e: DragEvent) => {
      if (!dragCarriesFiles(e.dataTransfer?.types)) return;
      setDepth(depth - 1);
    };

    // BUBBLE phase, deliberately. A real target has already called preventDefault() by the time the
    // event reaches here, and `defaultPrevented` is how this tells "somebody handled it" from
    // "this is about to become a navigation" without needing a registry of targets.
    const onDragOver = (e: DragEvent) => {
      if (strayDragAction(e.dataTransfer?.types, e.defaultPrevented) !== "swallow") return;
      // Claiming the drag is what makes `drop` fire here instead of the browser acting on it.
      e.preventDefault();
      // "none" — the cursor tells the user this is not a drop target BEFORE they let go, which is
      // the difference between a miss they can correct and a miss they only learn about after.
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };

    const onDrop = (e: DragEvent) => {
      // Reset first and unconditionally: the drag is over however it ended, and a `drop` that a real
      // target handled still has to clear the outline this provider is showing.
      setDepth(0);
      if (strayDragAction(e.dataTransfer?.types, e.defaultPrevented) !== "swallow") return;
      e.preventDefault();
    };

    // `dragend` fires on the source when a drag finishes ANY way — including cancelled with Escape,
    // or released over a window that refused it. Without it the outline can outlive its drag.
    const onDragEnd = () => setDepth(0);

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, []);

  return <FileDragContext.Provider value={session}>{children}</FileDragContext.Provider>;
}
