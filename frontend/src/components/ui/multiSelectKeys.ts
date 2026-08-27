/**
 * What a keypress means inside <MultiSelect>, as a pure decision.
 *
 * Extracted from the component for the same reason popoverPlacement and noticeTone were: this app's
 * test suite is Node-only, so behaviour that lives inside a React handler is behaviour nothing can
 * assert. The keyboard contract is exactly the kind that regresses silently.
 */
export interface MultiSelectKeyState {
  open: boolean;
  /** Index of the highlighted option, already clamped to the filtered range. */
  active: number;
  /** How many options the current query leaves. */
  count: number;
  /** The search box contents. */
  query: string;
  /** How many chips are currently selected. */
  selectedCount: number;
}

export type MultiSelectKeyAction =
  | { type: "none" }
  | { type: "open" }
  | { type: "move"; index: number }
  | { type: "toggle" }
  | { type: "close" }
  | { type: "removeLast" };

export interface MultiSelectKeyResult {
  action: MultiSelectKeyAction;
  /** Suppress the browser's own handling (caret movement, form submit). */
  preventDefault: boolean;
  /**
   * Stop the event reaching anything above the component.
   *
   * ONLY for Escape while the menu is open, and it is the whole fix for a real bug: <Modal> listens
   * for Escape on `document`, so closing the menu and closing the dialog both fired from one press —
   * the dropdown shut and the half-filled form was thrown away with it. Escape has to be consumed by
   * the innermost layer that can act on it, which is what a nested dismissible owes its parent.
   *
   * Deliberately NOT set when the menu is closed: Escape must then reach the dialog, or a MultiSelect
   * anywhere inside it would make the dialog impossible to dismiss with the keyboard.
   */
  stopPropagation: boolean;
}

const NONE: MultiSelectKeyResult = { action: { type: "none" }, preventDefault: false, stopPropagation: false };

export function multiSelectKey(key: string, s: MultiSelectKeyState): MultiSelectKeyResult {
  if (key === "ArrowDown") {
    // Opens the menu rather than moving within a closed one — the first press is "show me".
    const action: MultiSelectKeyAction = s.open ? { type: "move", index: Math.min(s.active + 1, s.count - 1) } : { type: "open" };
    return { action, preventDefault: true, stopPropagation: false };
  }
  if (key === "ArrowUp") {
    return { action: s.open ? { type: "move", index: Math.max(s.active - 1, 0) } : { type: "open" }, preventDefault: true, stopPropagation: false };
  }
  if (key === "Enter") {
    // Nothing highlighted means nothing to toggle, and Enter must then fall through — inside a form
    // that is the submit the user intended.
    if (!s.open || s.count === 0) return NONE;
    return { action: { type: "toggle" }, preventDefault: true, stopPropagation: false };
  }
  if (key === "Escape") {
    if (!s.open) return NONE;
    return { action: { type: "close" }, preventDefault: true, stopPropagation: true };
  }
  // Backspace on an empty query removes the last chip — the standard token-field gesture. With a
  // query present it must edit the text instead.
  if (key === "Backspace" && s.query === "" && s.selectedCount > 0) {
    return { action: { type: "removeLast" }, preventDefault: false, stopPropagation: false };
  }
  return NONE;
}
