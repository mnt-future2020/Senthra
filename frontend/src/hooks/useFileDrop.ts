"use client";

import * as React from "react";

import { useFileDragSession } from "./fileDragContext";

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
  /**
   * A file is being dragged somewhere over the window and this target would take it.
   *
   * The answer to "the drop area is hard to find": the picker is a plain button at rest, and
   * outlines itself for exactly as long as a drag is in flight. Costs no height in either state.
   */
  armed: boolean;
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
 * Is this element's recorded "the file is over me" still about the drag now in flight?
 *
 * `overSession` is the session id the element stored when a file last entered it. Comparing rather
 * than trusting a boolean is what makes leftover state harmless: an element abandoned mid-drag keeps
 * `overSession = 4` forever, and in session 5 that simply is not a match.
 *
 * The bug this closes: hover the Quote group, press Escape (no `dragleave`, no `drop` reaches it),
 * then start a new drag and hover the OTHER group — both groups showed the solid "over" outline, on
 * a form where that outline is the only thing saying which of the two will receive the file.
 */
export function isOverInSession(overSession: number, currentSession: number): boolean {
  return currentSession > 0 && overSession === currentSession;
}

/** What the app-wide guard does with a drag that reached the window. See `strayDragAction`. */
export type StrayDragAction = "swallow" | "ignore";

/**
 * What to do with a file drag that has bubbled all the way to the window.
 *
 * THE point of the app-wide guard. A drop target only protects the pixels it covers; everywhere else
 * on the page — the form background, a section heading, the help text 20px under the picker — is
 * still the BROWSER's drop target, and its default action for a file is to navigate the tab to it.
 * On a half-filled purchase request that is the whole form, gone, with no undo.
 *
 * Measured on the PRF create form: the drop strip is 547x38 inside a 547x83 group, so more than half
 * of the very block a user is aiming at was a miss that destroyed their work. Growing the target
 * (which we also did) narrows the gap; it cannot close it, because the rest of the page is still
 * there. This closes it.
 *
 * `alreadyClaimed` is `event.defaultPrevented` read in the BUBBLE phase: a real target that took the
 * drag has already cancelled it by the time the window sees it, and must not be second-guessed.
 *
 * A non-file drag is NEVER swallowed. Dragging a URL into the job form's attachment-link input is a
 * legitimate browser action that the page must not steal — the same rule, and the same reason, as
 * `dragTransition` declining to claim one.
 */
export function strayDragAction(
  types: readonly string[] | undefined,
  alreadyClaimed: boolean,
): StrayDragAction {
  if (!dragCarriesFiles(types)) return "ignore";
  return alreadyClaimed ? "ignore" : "swallow";
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
  // WHICH drag the file was last seen over this element in, not merely whether it was. 0 = none.
  const [overSession, setOverSession] = React.useState(0);

  // The drag now in flight, published by FileDragProvider. 0 without a provider, so a surface
  // rendered outside the dashboard shell keeps working and simply never arms.
  const session = useFileDragSession();
  const fileDragActive = session > 0;

  // A drag over a CHILD fires dragleave on the parent — the pointer really has left it. Tracking the
  // enter/leave pairs rather than a boolean is what stops the ring flickering off every time the
  // cursor crosses the button inside the target, which is most of the way across it.
  const depth = React.useRef(0);
  // Which session `depth` was counted in. A drag that ended without telling this element leaves a
  // depth behind; recognising it as belonging to a finished drag is cheaper and more reliable than
  // trying to catch every way a drag can end.
  const depthSession = React.useRef(0);

  // Every handler is the same three lines: ask `dragTransition`, obey it. No handler decides
  // anything on its own, which is what keeps the four of them in step.
  const apply = (phase: DragPhase, e: React.DragEvent): DragOutcome => {
    // Anything counted in an EARLIER drag is discarded, because the browser does not promise a
    // closing event: a drag cancelled with Escape, or released over another window, fires neither
    // `dragleave` nor `drop` on the element it was last over, and its depth would otherwise stay at
    // 1 for the rest of the page's life.
    if (depthSession.current !== session) {
      depthSession.current = session;
      depth.current = 0;
    }
    const out = dragTransition(phase, depth.current, e.dataTransfer?.types, disabled);
    if (!out.claim) return out;
    e.preventDefault();
    depth.current = out.depth;
    // Stamped with the session, so the next drag can tell this apart from its own.
    setOverSession(out.over ? session : 0);
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
  // DERIVED from the session comparison rather than stored as a boolean, so a value left behind by
  // an abandoned drag can never be mistaken for this one — see `isOverInSession`.
  const dragging = isOverInSession(overSession, session) && !disabled;

  return {
    dragging,
    // Never armed while disabled: outlining a target that would refuse the file is an invitation to
    // a drop that does nothing. And never armed while the file is already over THIS target — the
    // ring has taken over by then, and showing both reads as two competing borders.
    armed: fileDragActive && !disabled && !dragging,
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}

/**
 * How a drop target looks, in its three states.
 *
 *   idle    nothing. At rest a picker is a button with a label, exactly as before.
 *   armed   a file is being dragged somewhere in the window and THIS target would take it — a dashed
 *           accent outline. The discoverability half: what made drag/drop feel unusable was not only
 *           that the target was small, it was that nothing said where the targets were until you
 *           were already over one.
 *   over    the file is over this target specifically — a thicker SOLID outline, so with two groups
 *           side by side it is unambiguous which one is about to receive the file.
 *
 * ## It emits `outline-*` and nothing else, deliberately
 *
 * This string is concatenated onto elements that already have their own classes — the PO and PRF
 * attachment cards bring `bg-[var(--surface)]` and `rounded-2xl` of their own. Anything here that
 * touched the same CSS property fought them, and the winner was decided by the order Tailwind emits
 * rules in, not by the order of the strings. It shipped with exactly that bug: `bg-[var(--surface-2)]/50`
 * against the card's `bg-[var(--surface)]`, and `rounded-xl` against its `rounded-2xl`.
 *
 * The tint lost anyway on its own merits — `--surface-2` at 50% over white is a 2.5% grey, which is
 * invisible on a monitor. So both states are carried by the OUTLINE alone: nothing else on these
 * elements uses `outline`, the host keeps its own background, and the outline follows whatever
 * border radius the host already has instead of imposing a second one.
 *
 * `outline` reserves no space, so no state reflows the page.
 *
 * ## The offset is NEGATIVE, and that is not a style choice
 *
 * A positive `outline-offset` draws the outline OUTSIDE the element's box — where an ancestor with
 * `overflow: auto` will clip it. Every one of these targets has one: the tab panel the PO and PRF
 * attachment cards sit in is `min-h-0 flex-1 overflow-auto` and is FLUSH with the card on three
 * sides (measured: card and parent share top/left/right to the pixel). So `outline-offset-4` was
 * clipped away on top, left and right, and the only edge that survived was the bottom — which is
 * exactly what it looked like: one violet line under the card and nothing else.
 *
 * A negative offset draws the outline INSIDE the border box. It cannot be clipped by anything, on
 * any surface, at any viewport, and it cannot overlap a neighbour either. It costs the separation
 * from the card's own 1px border, which is a fair trade for being visible at all — and sitting just
 * inside that border reads as one deliberate double line rather than a smudge.
 */
export const dropRing = (dragging: boolean, armed = false) => {
  const base = "transition-[outline-color,outline-width] duration-150";
  // Solid and thicker — "this one", not merely "one of these".
  if (dragging) return `${base} outline-[3px] outline-solid outline-offset-[-3px] outline-[var(--accent)]`;
  // Dashed and lighter — "you may drop here", said by every eligible target at once.
  if (armed) return `${base} outline-2 outline-dashed outline-offset-[-2px] outline-[var(--accent)]/60`;
  return base;
};
