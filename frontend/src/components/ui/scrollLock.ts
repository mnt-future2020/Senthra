// ── Holding the page still while an overlay is open ────────────────────────────────────────────
//
// Below `sm` the dashboard is an ordinary scrolling document (see DashboardShell). That is the whole
// point of the mobile layout — but it also handed every overlay a page that scrolls BEHIND it.
//
// Measured in Chrome against the running app at 375x667, with the Warehouses list scrolled to y=250:
// opening the Deactivate confirmation and pressing End moved the page to y=558 while the dialog sat
// there, focus still correctly trapped on Cancel. The mobile sidebar does the same once focus is
// inside it. Neither overlay scrolls: the LIST does, underneath, so you dismiss the dialog and find
// yourself somewhere else in a list you had not touched.
//
// It is not a bug anyone wrote. The overlay backdrop is `fixed inset-0 overflow-y-auto`, so it only
// becomes a scroll container when its own content is taller than the viewport — a short dialog never
// is (measured: backdrop clientHeight 667 === scrollHeight 667), so a wheel, a swipe or End finds
// nothing to scroll there and CHAINS to the nearest ancestor that can. Before the `sm` change that
// was nothing at all, because `#app` was `overflow-hidden` and the document could not scroll.
//
// ── Why this is a module and not four lines in Modal ───────────────────────────────────────────
//
// The lock is a property of the DOCUMENT, which there is only one of, while overlays stack: the
// damaged-stock history opens an ImageLightbox from inside a Modal, and ImageLightbox is written to
// support exactly that. Two overlays each setting and then RESTORING `overflow` would unlock the page
// when the inner one closed, with the outer one still open. So the document's original state is
// captured once, on the first acquire, and put back once, on the last release — which is a counter,
// and a counter is worth testing.
//
// The core is separated from the hook for the reason this codebase already separates railScrollDelta
// and popoverPlacement: the frontend suite runs in Node with no renderer, so a rule that lives inside
// a component is a rule nothing can assert.

/** The bits of `document.documentElement` + `window` this needs — so a test can supply its own. */
export interface ScrollLockTarget {
  /** Inline styles to set. Only `overflow` and `paddingRight` are touched. */
  style: { overflow: string; paddingRight: string };
  /** The element's inner width, excluding a classic scrollbar. */
  clientWidth: number;
  /** The viewport width, INCLUDING a classic scrollbar. */
  windowInnerWidth: number;
}

export interface ScrollLock {
  acquire: () => void;
  release: () => void;
  /** How many overlays currently hold the lock. Exposed for tests and debugging only. */
  readonly depth: number;
}

/**
 * A ref-counted scroll lock over one target element.
 *
 * `overflow: hidden` on the root element is deliberate, and is NOT the `position: fixed` +
 * negative-`top` technique. That technique is what people reach for on iOS, and it costs a scroll
 * JUMP on both ends plus a re-layout of the whole page; `overflow: hidden` keeps the scroll offset
 * exactly where it was, which is the requirement here — the user is meant to come back to the row
 * they opened the dialog from.
 *
 * The padding compensation only fires when a classic scrollbar is actually taking layout width
 * (`windowInnerWidth > clientWidth`). On the desktop workspace that gap is ZERO — measured 0 at
 * 1440x900, because `#app` is `overflow-hidden` and the scrollbar belongs to a pane inside it — so
 * desktop gets no padding, no shift, and in fact no observable change at all: the document there is
 * not scrollable in the first place (measured `scrollHeight - clientHeight` = 0). The lock is a
 * no-op above `sm` by construction rather than by a breakpoint check, which is why there isn't one.
 *
 * Unbalanced calls are survivable in both directions: `release` on an unheld lock does nothing
 * rather than restoring styles it never captured, and the depth never goes negative. An overlay
 * unmounting twice (StrictMode remounts an effect in development) must not leave the page locked.
 */
export function createScrollLock(target: ScrollLockTarget): ScrollLock {
  let depth = 0;
  let restore: (() => void) | null = null;

  return {
    get depth() {
      return depth;
    },
    acquire() {
      if (depth++ > 0) return;
      const previousOverflow = target.style.overflow;
      const previousPaddingRight = target.style.paddingRight;
      // Read the gap BEFORE hiding the scrollbar — afterwards it is always 0 and the compensation
      // would be measured as unnecessary on the very screens that need it.
      const gap = target.windowInnerWidth - target.clientWidth;
      target.style.overflow = "hidden";
      if (gap > 0) target.style.paddingRight = `${gap}px`;
      restore = () => {
        // Put back what was there, INCLUDING the empty string — assigning "" to an inline style
        // removes the declaration, which is exactly right when we found none.
        target.style.overflow = previousOverflow;
        target.style.paddingRight = previousPaddingRight;
      };
    },
    release() {
      if (depth === 0) return;
      if (--depth > 0) return;
      restore?.();
      restore = null;
    },
  };
}

/** The app's single lock over the real document. Created lazily so importing this file is SSR-safe. */
let documentLock: ScrollLock | null = null;

export function getDocumentScrollLock(): ScrollLock {
  if (!documentLock) {
    const el = document.documentElement;
    documentLock = createScrollLock({
      style: el.style as unknown as ScrollLockTarget["style"],
      get clientWidth() {
        return el.clientWidth;
      },
      get windowInnerWidth() {
        return window.innerWidth;
      },
    } as ScrollLockTarget);
  }
  return documentLock;
}
