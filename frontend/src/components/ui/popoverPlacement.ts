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
 * @param panel    the panel's size
 * @param viewport the window's inner size
 *
 * Horizontal: open RIGHTWARD from the trigger's left edge when the panel fits — that direction moves
 * away from the leading columns of a table, which is where the reading happens. Fall back to
 * right-aligning it under the trigger, and clamp if even that would overflow.
 *
 * Vertical: below the trigger, flipping above it only when below genuinely doesn't fit AND above
 * does — a flip that swaps one overflow for another helps nobody.
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

  const spaceBelow = viewport.height - anchor.bottom;
  if (spaceBelow >= panel.height + OFFSET + MARGIN || anchor.top < panel.height + OFFSET + MARGIN) {
    place.top = anchor.bottom + OFFSET;
  } else {
    place.bottom = viewport.height - anchor.top + OFFSET;
  }

  return place;
}
