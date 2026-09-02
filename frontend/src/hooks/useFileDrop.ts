"use client";

import * as React from "react";

// ── Drag a file onto the control that already uploads it ───────────────────────────────────────
//
// HEADLESS, and that is the whole design. It renders nothing and owns no layout: a surface spreads
// `dropProps` onto the element it ALREADY has around its upload button, and gets a drop target of
// exactly that size and shape. Nothing on the page moves, and the form does not get taller.
//
// The alternative — a bordered "drag files here" panel — is what a drop zone usually looks like and
// is wrong for every surface here. The PRF create form shows two of these side by side inside a form
// that is already six sections long; the PO and GRN ones sit above a list of files that is the
// actual content of the tab. A 120px dashed rectangle per picker buys a second way to do something
// the button beside it already does, and charges the vertical space of the thing people came to read.
//
// Drag/drop is SUPPLEMENTAL. The button, its label and its keyboard path are untouched by this hook,
// which is the accessibility requirement and also just the correct division: dropping a file is a
// convenience for someone who has one in a folder already, not the way the feature works.

export interface FileDropProps {
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

export interface FileDropResult {
  /** True while a dragged file is over this target. Drives the ring — never the layout. */
  dragging: boolean;
  dropProps: FileDropProps;
}

/**
 * Only a FILE drag lights the target — dragging selected text, a link or an element is not an upload.
 *
 * Exported so it can be tested without a DOM: it is the one decision in this hook that is a rule
 * rather than plumbing, and getting it wrong shows up as a drop target that lights up when someone
 * drags a word across the form.
 */
export function dragCarriesFiles(types: readonly string[] | undefined): boolean {
  return Array.from(types ?? []).includes("Files");
}

/** What the handlers do about one drag event. See `decideDrag`. */
export interface DragDecision {
  /**
   * Call `preventDefault()`.
   *
   * This is NOT "accept the file" — it means "this element is the drop target". The browser only
   * fires `drop` on an element that cancelled `dragover`; an element that does not cancel is not a
   * target, so the event falls through to the browser's own default, which for a file is to NAVIGATE
   * the tab to it. On a half-filled PRF or job form that throws the user's work away.
   */
  claim: boolean;
  /** The cursor. `none` reads as "you may not drop here", which is exactly true when disabled. */
  effect: "copy" | "none";
  /** Hand the files to the surface's pick handler. */
  accept: boolean;
}

/**
 * Whether to claim a drag, and whether to act on it. THE two decisions, kept apart.
 *
 * Conflating them was the bug this function exists to prevent. `onDragOver` used to read
 * `if (disabled || !carriesFiles(e)) return;` before its `preventDefault()`, so a disabled target
 * silently stopped being a drop target — and the browser navigated away from the form instead. The
 * `onDrop` handler was written to guard exactly that case and could never run, because `drop` is not
 * dispatched to an element that did not cancel `dragover`.
 *
 * So: a file drag is ALWAYS claimed, disabled or not — that is what keeps the browser out of it —
 * and `accept` alone decides whether anything happens. A drag carrying something other than files
 * (selected text, a link) is not claimed at all, because dropping a link on a page is the browser's
 * business and cancelling it would break ordinary browsing.
 */
export function decideDrag(types: readonly string[] | undefined, disabled: boolean): DragDecision {
  if (!dragCarriesFiles(types)) return { claim: false, effect: "none", accept: false };
  return { claim: true, effect: disabled ? "none" : "copy", accept: !disabled };
}

/** The four drag events this hook answers. */
export type DragPhase = "enter" | "over" | "leave" | "drop";

/** What ONE drag event does to the target. Pure, so the whole state machine is testable in Node. */
export interface DragOutcome {
  /** Call `preventDefault()`. True only for a drag we claimed — see `DragDecision.claim`. */
  claim: boolean;
  /** The nesting depth after this event. */
  depth: number;
  /** Whether a claimed file drag is over the target after this event. Drives the ring. */
  over: boolean;
  /** Hand `dataTransfer.files` to the surface. Only on a claimed AND accepted `drop`. */
  deliver: boolean;
  /** The cursor to advertise on `over`. */
  effect: "copy" | "none";
}

/**
 * The ONE state decision, for every phase and every enabled/disabled combination.
 *
 * Two invariants it exists to hold, both of which were previously spread across four handlers and
 * both of which were broken:
 *
 *  1. `claim` gates `preventDefault()` on EVERY phase, `drop` included. `onDrop` used to cancel
 *     unconditionally, which made the wrapper swallow drags it had explicitly declined to claim:
 *     the Job form's drop region contains the attachment LINK inputs, so dropping a URL onto one
 *     fired `drop` on the input, bubbled to the wrapper, and was cancelled there — the text was
 *     never inserted and the field just sat there. Cancelling in the bubble phase kills the input's
 *     default just as dead as cancelling on the input itself would.
 *
 *  2. `enter` and `leave` are SYMMETRIC — both keyed on `claim`, which for a file drag is true
 *     whether or not the target is disabled. They were not: `enter` only counted when `accept`, and
 *     `leave` returned early while `disabled`. So a target that disabled mid-drag (the upload
 *     starting, the count cap being reached) never unwound its depth, and the ring came back and
 *     stuck the moment it re-enabled.
 *
 * An UNCLAIMED drag leaves `depth` alone rather than resetting it. Depth belongs to the file drag
 * that incremented it, and a text drag has no business unwinding one.
 */
export function dragTransition(
  phase: DragPhase,
  depth: number,
  types: readonly string[] | undefined,
  disabled: boolean,
): DragOutcome {
  const { claim, effect, accept } = decideDrag(types, disabled);
  if (!claim) return { claim: false, depth, over: depth > 0, deliver: false, effect: "none" };

  switch (phase) {
    case "enter":
      return { claim: true, depth: depth + 1, over: true, deliver: false, effect };
    case "over":
      return { claim: true, depth, over: depth > 0, deliver: false, effect };
    case "leave": {
      // Floored at zero: a `dragleave` with no matching `dragenter` (the drag began over a child
      // that mounted mid-drag) must not push the count negative and desynchronise every later pair.
      const next = Math.max(0, depth - 1);
      return { claim: true, depth: next, over: next > 0, deliver: false, effect };
    }
    case "drop":
      // The drag is over however deep it was — one drop ends it. `deliver` is what `disabled`
      // actually costs: the drag was claimed purely to keep the browser out of it, and nothing runs.
      return { claim: true, depth: 0, over: false, deliver: accept, effect };
  }
}

/**
 * @param onFiles   the surface's EXISTING pick handler. Same function the file input calls, so a
 *                  dropped file and a chosen one cannot validate differently — there is only one
 *                  path to differ from.
 * @param disabled  when the surface's own button is disabled (upload in flight, record locked, cap
 *                  reached). A disabled target reports no drag state and swallows the drop, rather
 *                  than accepting a file the click path would have refused.
 */
export function useFileDrop(onFiles: (files: File[]) => void, disabled = false): FileDropResult {
  const [dragging, setDragging] = React.useState(false);

  // A drag over a CHILD fires dragleave on the parent — the pointer really has left it. Tracking the
  // enter/leave pairs rather than a boolean is what stops the ring flickering off every time the
  // cursor crosses the button inside the target, which is most of the way across it.
  const depth = React.useRef(0);

  // Every handler is the same three lines: ask `dragTransition`, obey it. No handler decides
  // anything on its own, which is what keeps the four of them in step.
  const apply = (phase: DragPhase, e: React.DragEvent): DragOutcome => {
    const out = dragTransition(phase, depth.current, e.dataTransfer?.types, disabled);
    if (!out.claim) return out;
    e.preventDefault();
    depth.current = out.depth;
    setDragging(out.over);
    return out;
  };

  const onDragEnter = (e: React.DragEvent) => void apply("enter", e);

  const onDragOver = (e: React.DragEvent) => {
    const out = apply("over", e);
    // "copy" when we will take it, "none" when we will not — so a disabled target says so under the
    // cursor rather than looking droppable and silently swallowing the file.
    if (out.claim && e.dataTransfer) e.dataTransfer.dropEffect = out.effect;
  };

  const onDragLeave = (e: React.DragEvent) => void apply("leave", e);

  const onDrop = (e: React.DragEvent) => {
    const out = apply("drop", e);
    if (!out.deliver) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) onFiles(files);
  };

  // DERIVED, not stored. A target that becomes disabled mid-drag — the upload starts, the count cap
  // is reached — must stop showing the ring immediately, and it does so here rather than in an
  // effect that syncs one piece of React state to another. (That effect was the obvious way to write
  // it and is the one this lint rule exists to prevent: it costs a second render and can leave the
  // ring on for a frame.)
  //
  // The stored `dragging` is deliberately the RAW fact — "a claimed file drag is over this element"
  // — kept whether or not the target is currently taking files, because that is what `dragTransition`
  // can account for symmetrically. Masking it here is what turns that fact into the affordance: the
  // ring goes out the instant the target disables, comes back if it re-enables with the file still
  // hovering, and is unwound honestly by the matching `dragleave` either way.
  return { dragging: dragging && !disabled, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}

/**
 * The ring classes for a drop target, so five surfaces cannot draw five different affordances.
 *
 * A RING, not a border: `ring` draws outside the box and changes nothing about the element's size,
 * so the target does not shift by 2px the moment a file is dragged over it. `rounded-xl` matches the
 * cards and buttons it wraps.
 */
export const dropRing = (dragging: boolean) =>
  dragging
    ? "rounded-xl ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--surface)] transition-shadow"
    : "rounded-xl transition-shadow";
