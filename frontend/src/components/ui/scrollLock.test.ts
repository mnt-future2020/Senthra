import { describe, expect, it } from "vitest";

import { createScrollLock, type ScrollLockTarget } from "./scrollLock";

// ── The page must not scroll behind an overlay, and must scroll again after the LAST one closes ──
//
// The bug this pins was measured in the running app, not reasoned about: at 375x667 with the
// Warehouses list scrolled to y=250, opening the Deactivate confirmation and pressing End moved the
// page underneath to y=558 — dialog still open, focus still trapped on Cancel. The mobile sidebar
// did the same from y=300. Both are `fixed inset-0 overflow-y-auto` backdrops that only scroll when
// their own content is tall enough; a short dialog is not, so the gesture chains to the document,
// which below `sm` is now a scrolling document by design.
//
// This suite runs in Node with no renderer (see the note in UsersView.suspend.test.ts), so it tests
// the lock's DECISIONS against a fake target rather than a real page. That is the half that can
// silently break: the counter. Overlays stack in this app — ImageLightbox is written to open on top
// of a Modal — and a lock that restored on the first close would unlock the page with the modal
// still up, which is the original bug wearing a different hat.

function fakeTarget(over: Partial<ScrollLockTarget> = {}): ScrollLockTarget {
  return {
    style: { overflow: "", paddingRight: "" },
    clientWidth: 375,
    windowInnerWidth: 375, // no classic scrollbar — a phone, and the desktop workspace too
    ...over,
  };
}

describe("createScrollLock", () => {
  it("locks the document on the first acquire", () => {
    const t = fakeTarget();
    const lock = createScrollLock(t);
    lock.acquire();
    expect(t.style.overflow).toBe("hidden");
    expect(lock.depth).toBe(1);
  });

  it("restores on release", () => {
    const t = fakeTarget();
    const lock = createScrollLock(t);
    lock.acquire();
    lock.release();
    expect(t.style.overflow).toBe("");
    expect(lock.depth).toBe(0);
  });

  it("puts back a pre-existing inline overflow rather than clearing it", () => {
    // Nothing in the app sets one today, but a lock that assumes "" is a lock that silently
    // deletes whatever the next person adds.
    const t = fakeTarget({ style: { overflow: "clip", paddingRight: "7px" } });
    const lock = createScrollLock(t);
    lock.acquire();
    lock.release();
    expect(t.style.overflow).toBe("clip");
    expect(t.style.paddingRight).toBe("7px");
  });

  describe("stacked overlays", () => {
    it("stays locked while an inner overlay opens and closes", () => {
      // The real case: a photo opened from inside a Modal (see ImageLightbox).
      const t = fakeTarget();
      const lock = createScrollLock(t);
      lock.acquire(); // Modal
      lock.acquire(); // ImageLightbox on top
      expect(lock.depth).toBe(2);
      lock.release(); // photo closed — the modal is STILL open
      expect(t.style.overflow).toBe("hidden");
      expect(lock.depth).toBe(1);
      lock.release(); // modal closed
      expect(t.style.overflow).toBe("");
    });

    it("captures the original state ONCE, from the outermost overlay", () => {
      const t = fakeTarget({ style: { overflow: "auto", paddingRight: "" } });
      const lock = createScrollLock(t);
      lock.acquire();
      lock.acquire();
      lock.release();
      lock.release();
      // Not "hidden" — the inner acquire must not have re-captured the already-locked state as if
      // it were the original.
      expect(t.style.overflow).toBe("auto");
    });
  });

  describe("unbalanced calls", () => {
    it("ignores a release nobody acquired", () => {
      const t = fakeTarget({ style: { overflow: "auto", paddingRight: "" } });
      const lock = createScrollLock(t);
      lock.release();
      expect(lock.depth).toBe(0);
      expect(t.style.overflow).toBe("auto");
    });

    it("cannot be driven below zero into a stuck lock", () => {
      // An overlay unmounting twice (StrictMode remounts effects in development) must not leave the
      // depth negative — the next acquire would then never reach 1 and the page would never lock.
      const t = fakeTarget();
      const lock = createScrollLock(t);
      lock.release();
      lock.release();
      expect(lock.depth).toBe(0);
      lock.acquire();
      expect(t.style.overflow).toBe("hidden");
    });
  });

  describe("scrollbar compensation", () => {
    it("pads by the scrollbar width when a classic scrollbar is taking layout space", () => {
      const t = fakeTarget({ clientWidth: 1425, windowInnerWidth: 1440 });
      const lock = createScrollLock(t);
      lock.acquire();
      expect(t.style.paddingRight).toBe("15px");
    });

    it("adds NO padding when there is no scrollbar gap", () => {
      // Both the phone and the desktop workspace: measured gap 0 at 1440x900, because `#app` is
      // `overflow-hidden` and the scrollbar belongs to a pane inside it. Padding here would be a
      // visible 0px-justified shift on every desktop modal in the app.
      const t = fakeTarget({ clientWidth: 1440, windowInnerWidth: 1440 });
      const lock = createScrollLock(t);
      lock.acquire();
      expect(t.style.paddingRight).toBe("");
    });

    it("measures the gap BEFORE hiding the scrollbar", () => {
      // If the gap were read after `overflow: hidden`, it would always be 0 and the compensation
      // would never fire on the one platform that needs it.
      let reads = 0;
      const style = { overflow: "", paddingRight: "" };
      const t: ScrollLockTarget = {
        style,
        get clientWidth() {
          reads++;
          // Simulate the browser: once overflow is hidden, the scrollbar is gone and client width
          // grows to the full viewport.
          return style.overflow === "hidden" ? 1440 : 1425;
        },
        windowInnerWidth: 1440,
      };
      createScrollLock(t).acquire();
      expect(reads).toBeGreaterThan(0);
      expect(style.paddingRight).toBe("15px");
    });
  });
});
