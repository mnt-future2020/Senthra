import { describe, expect, it } from "vitest";

import { anchorMoved, anchorVisible, popoverPlacement, type Rect } from "./popoverPlacement";

// The bug this exists to prevent, as it happened: the Inventory filter panel right-aligned under a
// trigger in the middle of the toolbar, so it opened LEFTWARD and covered the Item column — hiding
// the one column you read the list by, in order to show the controls meant to help you find things
// in it.

const PANEL = { width: 288, height: 320 };
const VIEW = { width: 1024, height: 866 };
const at = (left: number, top: number, w = 90, h = 38): Rect => ({
  left,
  right: left + w,
  top,
  bottom: top + h,
});

describe("popoverPlacement — horizontal", () => {
  // Rightward is the safe direction on a table: it moves away from the leading columns.
  it("opens rightward from the trigger when there is room", () => {
    const p = popoverPlacement(at(300, 200), PANEL, VIEW);
    expect(p.left).toBe(300);
    expect(p.right).toBeUndefined();
  });

  // The Inventory case: trigger near the right end, no room to open rightward.
  it("right-aligns under the trigger when rightward would overflow", () => {
    const p = popoverPlacement(at(800, 200), PANEL, VIEW);
    expect(p.left).toBeUndefined();
    // 1024 − 890 = 134, so the panel spans 602…890 and clears the leading columns.
    expect(p.right).toBe(134);
  });

  it("keeps the panel on screen when neither side fits", () => {
    const narrow = { width: 320, height: 700 };
    const p = popoverPlacement(at(200, 100), PANEL, narrow);
    expect(p.right).toBe(8);
    expect(p.left).toBeUndefined();
  });

  // A trigger at the very left must not push the panel off the left edge.
  it("opens rightward from a trigger hard against the left edge", () => {
    expect(popoverPlacement(at(0, 200), PANEL, VIEW).left).toBe(0);
  });

  it("never returns both a left and a right", () => {
    for (const x of [0, 200, 500, 800, 1000]) {
      const p = popoverPlacement(at(x, 200), PANEL, VIEW);
      expect(p.left === undefined || p.right === undefined).toBe(true);
    }
  });
});

describe("popoverPlacement — vertical", () => {
  it("opens below the trigger when it fits", () => {
    const p = popoverPlacement(at(300, 200), PANEL, VIEW);
    expect(p.top).toBe(244); // 200 + 38 + 6
    expect(p.bottom).toBeUndefined();
  });

  // On a short laptop a panel opening downward near the bottom puts its own controls below the fold.
  it("flips above the trigger when below would run off the bottom", () => {
    const p = popoverPlacement(at(300, 700), PANEL, VIEW);
    expect(p.top).toBeUndefined();
    expect(p.bottom).toBe(172); // 866 − 700 + 6
  });

  // Flipping into a second overflow helps nobody — stay below and let it scroll.
  it("stays below when there is no room above either", () => {
    const short = { width: 1024, height: 400 };
    const p = popoverPlacement(at(300, 100), PANEL, short);
    expect(p.top).toBe(144);
    expect(p.bottom).toBeUndefined();
  });

  it("always returns exactly one vertical anchor", () => {
    for (const y of [0, 100, 400, 700, 850]) {
      const p = popoverPlacement(at(300, y), PANEL, VIEW);
      expect(p.top === undefined || p.bottom === undefined).toBe(true);
      expect(p.top !== undefined || p.bottom !== undefined).toBe(true);
    }
  });
});

// The bug: a capture-phase `scroll` listener fires for scrolling ANYWHERE in the document. Inside the
// filter panel, opening the warehouse <Select> and scrolling its list tore the whole panel down —
// Base UI portals that popup to <body>, so it is not a descendant of the panel and no containment
// check can tell the two apart. The trigger's position can: page scroll moves it, scrolling inside a
// popup does not.
describe("anchorMoved — did the trigger actually move?", () => {
  const r = (left: number, top: number): Rect => ({ left, top, right: left + 90, bottom: top + 38 });

  it("is false when nothing moved — the scroll happened inside a child popup", () => {
    expect(anchorMoved(r(800, 400), r(800, 400))).toBe(false);
  });

  it("is true once the page scrolls the trigger", () => {
    expect(anchorMoved(r(800, 400), r(800, 320))).toBe(true);
    expect(anchorMoved(r(800, 400), r(600, 400))).toBe(true);
  });

  // A rect can jitter by a fraction under browser zoom or a fractional device pixel ratio; treating
  // that as movement would reposition on every frame of a scroll that isn't happening.
  it("ignores sub-pixel jitter", () => {
    expect(anchorMoved(r(800, 400), { left: 800.4, top: 400.3, right: 890.4, bottom: 438.3 })).toBe(false);
  });
});

describe("anchorVisible — is the trigger still on screen?", () => {
  const view = { height: 866 };

  it("is visible in the middle of the viewport", () => {
    expect(anchorVisible({ left: 0, right: 90, top: 400, bottom: 438 }, view)).toBe(true);
  });

  // The case the original close-on-scroll was really aiming at: the panel would be floating beside
  // nothing. Dismissing is right HERE — it was just being applied to every scroll event.
  it("is not visible once scrolled off the top or below the fold", () => {
    expect(anchorVisible({ left: 0, right: 90, top: -60, bottom: -20 }, view)).toBe(false);
    expect(anchorVisible({ left: 0, right: 90, top: 900, bottom: 940 }, view)).toBe(false);
  });

  it("counts a trigger straddling an edge as still visible", () => {
    expect(anchorVisible({ left: 0, right: 90, top: -10, bottom: 28 }, view)).toBe(true);
    expect(anchorVisible({ left: 0, right: 90, top: 850, bottom: 888 }, view)).toBe(true);
  });
});
