// ── Tabbing out of a panel that is not where it looks ─────────────────────────────────────────
//
// A portalled panel is the last thing in the document, whatever it is painted next to. That is fine
// for the eye and wrong for the Tab key: the panel of a field halfway up a form sits after every
// other control in the tab order, so tabbing past its last row walked out of the page entirely
// instead of carrying on to the next field. Inside a dialog it was worse — `Modal`'s focus trap sees
// focus land outside its panel and yanks it back to the dialog's first control.
//
// Neither is the panel's own doing; it is the price of portalling, and it has to be paid back
// explicitly. The rule the ARIA combobox pattern gives is the one people expect anyway: Tab closes
// the popup and moves on to whatever follows the FIELD — not whatever follows the panel.
//
// `SuggestInput` reaches the same end by a different road: its rows are `tabIndex={-1}` and the list
// closes when focus leaves the input, so the panel never joins the tab order at all. That works
// because its input is the trigger and stays in place. These panels hold their own search box, so
// focus is genuinely inside the portalled node and the way out has to be computed.

/** Everything the browser would stop on for a Tab press. Mirrors the set `Modal` traps over. */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab should land when it leaves an anchored panel.
 *
 * @param ordered  the document's focusable elements, in document order
 * @param anchor   the trigger the panel belongs to — the tab order continues from HERE, which is the
 *                 whole point: the panel's own position in the document is meaningless
 * @param panel    the panel, so its contents can be ignored
 * @param back     true for Shift+Tab
 *
 * Forward lands on the first focusable after the trigger; backward lands on the trigger itself,
 * which is where Shift+Tab out of an inline panel always went.
 *
 * Returns null when there is nothing after the trigger — the caller focuses the trigger instead, so
 * focus is never simply dropped.
 */
export function tabOutTarget(
  ordered: Element[],
  anchor: Element,
  panel: Element,
  back: boolean,
): Element | null {
  if (back) return anchor;
  // The panel's own rows are not part of the answer: they are where we are tabbing OUT of.
  const outside = ordered.filter((el) => !panel.contains(el));
  const i = outside.indexOf(anchor);
  if (i < 0) return null;
  return outside[i + 1] ?? null;
}

/**
 * Is this the Tab press that leaves the panel?
 *
 * Tab inside the panel still walks its own rows — several of these lists have no arrow-key
 * navigation, so Tab is the only way a keyboard reaches their options. Only the press that would
 * step off the END of the panel (or off the front of it, going back) is the one to intercept.
 */
export function leavesPanel(panelFocusables: Element[], active: Element | null, back: boolean): boolean {
  if (panelFocusables.length === 0) return true;
  const edge = back ? panelFocusables[0] : panelFocusables[panelFocusables.length - 1];
  return active === edge;
}
