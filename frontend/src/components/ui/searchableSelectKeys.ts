/**
 * Option-list navigation for <SearchableSelect>, as pure decisions.
 *
 * Extracted for the same reason multiSelectKeys and popoverPlacement were: this app's test suite is
 * Node-only, so behaviour living inside a React handler is behaviour nothing can assert.
 *
 * WHAT IS NOT HERE: which key means what. That is `multiSelectKey`, which a single-select reads the
 * same way a multi-select does — ↑/↓ move, Enter commits the highlighted option, Escape closes and
 * stops there so an enclosing <Modal> does not close with it. Only one mapping differs: a single
 * select has no chips, so it passes `selectedCount: 0` and never receives `removeLast`.
 *
 * WHAT IS here: skipping options nobody can choose. A disabled option still renders — it is greyed,
 * and often the reason it is greyed is the answer the user wanted ("Pick a customer first") — but the
 * highlight must travel past it. Without this, ↓ parks on a row Enter then refuses to act on, and the
 * list reads as broken rather than as guarded.
 */
export interface NavOption {
  disabled?: boolean;
}

/**
 * The nearest selectable index at or after `from`, searching in `dir` (+1 down, -1 up).
 *
 * Returns `from` unchanged when every candidate in that direction is disabled — the highlight holds
 * its ground rather than wrapping around or jumping to the far end, both of which read as a glitch
 * when the user is only leaning on an arrow key.
 */
export function nextEnabledIndex(options: readonly NavOption[], from: number, dir: 1 | -1): number {
  if (options.length === 0) return 0;
  for (let i = from; i >= 0 && i < options.length; i += dir) {
    if (!options[i]?.disabled) return i;
  }
  return from;
}

/**
 * Where the highlight sits when the list (re)opens or the query changes: the selected option when it
 * survived the filter, otherwise the first selectable row.
 *
 * Landing on the current value matters for the gesture this control is opened with most — open, see
 * what is set, arrow one step. Starting at the top of a 40-name list instead would mean the first ↓
 * moves AWAY from the answer.
 */
export function initialIndex(options: readonly NavOption[], selectedIndex: number): number {
  if (selectedIndex >= 0 && selectedIndex < options.length && !options[selectedIndex]?.disabled) {
    return selectedIndex;
  }
  return nextEnabledIndex(options, 0, 1);
}

/**
 * Should this control show a search box?
 *
 * `searchable` is the caller's explicit answer and always wins. Undefined means "decide by length":
 * a list long enough that scanning it is slower than typing gets a box, a short fixed list does not.
 *
 * The threshold exists so that a picker nobody thought about still becomes searchable once the data
 * grows — the 47-warehouse dropdown nobody remembered to flag. It is NOT a substitute for flagging
 * the unbounded ones: a site with two engineers today has two names in that list and would never
 * cross it, while being exactly the control that needs search on the day it holds sixty.
 */
export const SEARCHABLE_THRESHOLD = 10;

export function shouldSearch(optionCount: number, searchable?: boolean): boolean {
  return searchable ?? optionCount >= SEARCHABLE_THRESHOLD;
}
