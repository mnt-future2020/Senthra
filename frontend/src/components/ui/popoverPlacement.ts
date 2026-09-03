// ── Where a popover panel should sit ───────────────────────────────────────────────────────────
//
// Anchored to a trigger and painted over the page, so the only question that matters is WHAT it
// covers. The Inventory filter panel opened leftward from a trigger in the middle of the toolbar and
// landed squarely on the Item column — the one column you are reading the list by. It obscured the
// exact thing the filters are there to help you find.
//
// So: prefer the side with room, and when neither side has room, clamp rather than let the panel run
// off-screen. Same for the vertical axis — a panel opening downward near the bottom of a short laptop
// screen would put its own controls below the fold.
//
// The vertical half only picked a side; it never clamped, and that is a different promise. A panel
// handed less room than it wants is laid out at its natural height and hangs past the bottom of the
// window — measured on Purchase Orders at 844×390, a phone held landscape, the attention panel ran
// 101px over with three of its six queues inside that strip, and the filter panel 91px over on the
// same page. `position: fixed` puts those rows beyond any scroll, and the panel's own
// `overflow-y-auto` cannot reach them either: what is off-screen is the BOX, not its contents.
//
// So the caller is told how much room its chosen side actually had, as a `maxHeight` to wear. That
// makes the panel scroll inside the space it was given, which is what "let it scroll" always meant.

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Placement {
  /** css `left`, when the panel opens rightward from the trigger */
  left?: number;
  /** css `right`, when it opens leftward */
  right?: number;
  /** css `top`, when it opens downward */
  top?: number;
  /** css `bottom`, when it flips upward */
  bottom?: number;
  /**
   * css `max-height` — the room the chosen side actually had, never more than the panel asked for.
   *
   * Apply it. A panel that renders `style={pos}` gets this for free; one that also carries a
   * `max-h-…` class is stating its cap twice, and the class is the copy that goes stale.
   */
  maxHeight?: number;
}

/** Breathing room kept between the panel and the viewport edge. */
const MARGIN = 8;
/** Distance from the trigger, so the panel reads as attached to it. */
const OFFSET = 6;

/**
 * Has the trigger actually moved?
 *
 * The reason this exists: a `scroll` listener registered with capture fires for scrolling ANYWHERE in
 * the document, including inside a child that is portalled out of the panel's own DOM — a `<Select>`
 * dropdown, for instance. Dismissing on that event meant opening the warehouse list inside the filter
 * panel and scrolling it tore the whole panel down, which looks like a glitch and loses the work.
 *
 * A containment check can't distinguish those, because the portalled popup is not inside the panel.
 * The trigger's position can: page scroll moves it, scrolling inside any popup does not. So the
 * question is never "did something scroll" but "did the thing I am anchored to move".
 *
 * Sub-pixel tolerance, because a rect can jitter by a fraction under zoom or a device pixel ratio
 * that isn't a whole number, and a repositioning loop is its own bug.
 */
export function anchorMoved(a: Rect, b: Rect, tolerance = 1): boolean {
  return Math.abs(a.top - b.top) > tolerance || Math.abs(a.left - b.left) > tolerance;
}

/**
 * What prompted a placement re-check.
 *
 * The distinction matters because these two events carry different information. A scroll says
 * "something in the document moved" and may have nothing to do with this panel. A resize says the
 * VIEWPORT changed, and every number `popoverPlacement` returns is derived from the viewport.
 */
export type PlacementCause = "scroll" | "resize";

/**
 * Should the panel be re-placed?
 *
 * Split from `anchorMoved` because binding one handler to both `scroll` and `resize` quietly applied
 * a scroll rule to a resize. The bug: dock DevTools to the bottom of the window, or let a mobile URL
 * bar collapse, and the viewport loses height while a trigger near the top of the page does not move
 * by a pixel. `anchorMoved` answers "no" — correctly, for the question it asks — the recompute is
 * skipped, and the panel keeps a `maxHeight` measured against the taller window it was opened in. It
 * then hangs past the bottom of the shorter one, which is the exact overflow `maxHeight` exists to
 * prevent.
 *
 * So a resize ALWAYS re-places: the viewport is the input, and it just changed. A scroll keeps the
 * anchor test, because that test is the only thing distinguishing page scroll (the trigger moves,
 * follow it) from scrolling inside a portalled `<Select>` popup (it doesn't, leave the panel alone) —
 * and reacting to the latter used to tear the panel down mid-interaction.
 *
 * `previous` is null before the first rect has been recorded; a scroll then has nothing to compare
 * against and reports no movement, which is the same answer the caller's own fallback gave.
 */
export function shouldReposition(
  cause: PlacementCause,
  previous: Rect | null,
  current: Rect,
): boolean {
  return cause === "resize" || anchorMoved(previous ?? current, current);
}

/**
 * Is the trigger still on screen?
 *
 * Once it has scrolled out of view the panel is floating beside nothing, which is the case the
 * original close-on-scroll was really aiming at — just applied far too broadly.
 */
export function anchorVisible(rect: Rect, viewport: { height: number }): boolean {
  return rect.bottom > 0 && rect.top < viewport.height;
}

/**
 * @param anchor   the trigger's bounding rect, in viewport coordinates
 * @param panel    the panel's size — the height is the cap it WANTS, not a measurement
 * @param viewport the window's inner size
 *
 * Horizontal: open RIGHTWARD from the trigger's left edge when the panel fits — that direction moves
 * away from the leading columns of a table, which is where the reading happens. Fall back to
 * right-aligning it under the trigger, and clamp if even that would overflow.
 *
 * Vertical: below the trigger when the panel fits there, otherwise the side with more room — a flip
 * that swaps one overflow for another helps nobody. Then `maxHeight` states what that side had, so a
 * panel that fits nowhere scrolls inside the viewport instead of hanging past the bottom of it.
 */
export function popoverPlacement(
  anchor: Rect,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement {
  const place: Placement = {};

  if (anchor.left + panel.width + MARGIN <= viewport.width) {
    place.left = anchor.left;
  } else if (anchor.right - panel.width >= MARGIN) {
    // Right-aligned to the trigger: expressed as a `right` offset so the panel stays pinned to the
    // trigger's right edge rather than drifting if it is later measured differently.
    place.right = Math.max(MARGIN, viewport.width - anchor.right);
  } else {
    // Wider than the space on either side — pin it to the right edge and let it cover what it must.
    place.right = MARGIN;
  }

  // Room on each side once the gap to the trigger and the viewport margin are paid for — so the two
  // are directly comparable, and whichever wins is also the number the panel may grow to.
  const roomBelow = viewport.height - anchor.bottom - OFFSET - MARGIN;
  const roomAbove = anchor.top - OFFSET - MARGIN;

  // Below when the panel fits there, because downward is where a menu is expected to go. Otherwise
  // simply the roomier side: the old test was "is the trigger higher up than the panel is tall?",
  // which answered yes for a trigger sitting just above that line and then chose `below` even when
  // above had more to offer — a panel squeezed into 268px with 366px going spare over its head.
  const openDownward = roomBelow >= panel.height || roomBelow >= roomAbove;
  const room = openDownward ? roomBelow : roomAbove;
  if (openDownward) {
    place.top = anchor.bottom + OFFSET;
  } else {
    place.bottom = viewport.height - anchor.top + OFFSET;
  }
  // Never taller than the panel wants, never taller than the space it was given. The floor at zero is
  // for a trigger straddling an edge, where the losing side's room is negative; the roomier side wins
  // that comparison, so it is a guard against emitting nonsense, not a placement anyone lands on.
  place.maxHeight = Math.max(0, Math.min(panel.height, room));

  return place;
}
