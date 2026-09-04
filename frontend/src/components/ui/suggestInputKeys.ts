/**
 * What a keypress means inside <SuggestInput>, and which suggestion the list must keep on screen —
 * both as pure decisions.
 *
 * Extracted for the same reason `multiSelectKeys` was: this app's test suite is Node-only, so
 * behaviour that lives inside a React handler is behaviour nothing can assert. That file already
 * documents the Escape bug this one exists to avoid repeating — a nested dismissible that swallows
 * Escape when it has nothing open leaves the dialog around it impossible to close by keyboard.
 */

export interface SuggestInputKeyState {
  /**
   * Is the popup actually VISIBLE — not merely "the field has focus".
   *
   * The distinction is the whole point. `SuggestInput` opens on focus, so its internal `open` flag
   * is true while the field is being typed into even when the query matches nothing and no list is
   * rendered. Deciding Escape from that flag swallowed a keypress that had nothing to close.
   */
  listVisible: boolean;
  /** Index of the highlighted suggestion, or -1 for none. */
  active: number;
  /** How many suggestions the current query leaves. */
  count: number;
}

export type SuggestInputKeyAction =
  | { type: "none" }
  /** Show the list and highlight `index` — the first press of an arrow key on a closed list. */
  | { type: "open"; index: number }
  | { type: "move"; index: number }
  | { type: "commit"; index: number }
  | { type: "close" };

export interface SuggestInputKeyResult {
  action: SuggestInputKeyAction;
  /** Suppress the browser's own handling (caret movement, form submit). */
  preventDefault: boolean;
  /**
   * Stop the event reaching anything above the component.
   *
   * ONLY Escape, and ONLY while a list is actually on screen. `Modal` listens for Escape on the
   * document, so an unconsumed press closes the dialog and throws away the form — but a press
   * consumed with nothing to dismiss makes that dialog un-closable by keyboard, which is worse.
   */
  stopPropagation: boolean;
}

const NONE: SuggestInputKeyResult = { action: { type: "none" }, preventDefault: false, stopPropagation: false };

export function suggestInputKey(key: string, s: SuggestInputKeyState): SuggestInputKeyResult {
  if (key === "Escape") {
    if (!s.listVisible) return NONE;
    return { action: { type: "close" }, preventDefault: false, stopPropagation: true };
  }

  if (key === "ArrowDown" || key === "ArrowUp") {
    if (s.count === 0) return NONE;
    const down = key === "ArrowDown";
    if (!s.listVisible) {
      return { action: { type: "open", index: down ? 0 : s.count - 1 }, preventDefault: true, stopPropagation: false };
    }
    // Wraps rather than clamping: the list is short and always fully enumerable, so running off one
    // end and reappearing at the other is quicker than a dead key at the boundary.
    const from = s.active < 0 ? (down ? -1 : 0) : s.active;
    const index = (from + (down ? 1 : -1) + s.count) % s.count;
    return { action: { type: "move", index }, preventDefault: true, stopPropagation: false };
  }

  if (key === "Enter") {
    // Nothing highlighted means nothing to commit, and Enter must then fall through — the field is
    // FREE TEXT, so inside a form that press is the submit the user intended.
    if (!s.listVisible || s.active < 0) return NONE;
    return { action: { type: "commit", index: s.active }, preventDefault: true, stopPropagation: false };
  }

  return NONE;
}

/**
 * Which suggestions a query leaves.
 *
 * The exact-match case is not an optimisation. Country defaults to "United Kingdom", so a plain
 * substring filter left the box showing the one row already in it — and changing it to Ireland meant
 * deleting the text first to make the other five reappear. A value that IS a suggestion means the
 * user is CHOOSING, not typing, so the whole list is what they need.
 */
export function suggestMatches(suggestions: readonly string[], value: string): readonly string[] {
  const q = value.trim().toLowerCase();
  if (!q) return suggestions;
  if (suggestions.some((s) => s.toLowerCase() === q)) return suggestions;
  return suggestions.filter((s) => s.toLowerCase().includes(q));
}

/**
 * The list's new `scrollTop` so the highlighted row is on screen — or the current one if it already is.
 *
 * Returned as a number for the caller to assign to the LIST element, deliberately, rather than
 * calling `scrollIntoView` on the row. `scrollIntoView` walks every scrollable ancestor, so inside a
 * dialog it can scroll the dialog body or the page itself to bring a dropdown row into view, which
 * is exactly the lurch this is meant to avoid.
 */
export function listScrollTop(
  current: number,
  itemTop: number,
  itemHeight: number,
  viewHeight: number,
): number {
  if (itemTop < current) return itemTop;
  const itemBottom = itemTop + itemHeight;
  if (itemBottom > current + viewHeight) return itemBottom - viewHeight;
  return current;
}
