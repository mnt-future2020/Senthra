import { describe, expect, it } from "vitest";

import { backingSize, isBlank, normalisePoint, type Stroke } from "./signaturePad";

// The pad's bitmap was pinned at 480×160 while the element rendered `w-full`. On a wide desktop the
// browser scaled that up ~3×, and pointer positions went into the drawing context in CSS pixels with
// no conversion — so the ink landed ~3× further right and lower than the cursor, off the board.
// Normalising to a fraction of the RENDERED box removes the mismatch by never mixing the two spaces.
describe("normalisePoint — ink lands under the cursor at any pad size", () => {
  const rect = { left: 100, top: 50, width: 800, height: 200 };

  it("puts the middle of the box at the middle of the pad", () => {
    expect(normalisePoint(500, 150, rect)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("puts the corners at the corners", () => {
    expect(normalisePoint(100, 50, rect)).toEqual({ x: 0, y: 0 });
    expect(normalisePoint(900, 250, rect)).toEqual({ x: 1, y: 1 });
  });

  // The bug in one assertion: the same cursor position must mean the same place on the signature
  // whether the pad is rendered at 480px or 1520px wide.
  it("is independent of how wide the pad is drawn", () => {
    const narrow = normalisePoint(340, 130, { left: 100, top: 50, width: 480, height: 160 });
    const wide = normalisePoint(860, 303.5, { left: 100, top: 50, width: 1520, height: 507 });
    expect(narrow.x).toBeCloseTo(wide.x, 2);
    expect(narrow.y).toBeCloseTo(wide.y, 2);
  });

  // A pointer stays captured mid-stroke so a fast signature doesn't break into pieces when it leaves
  // the canvas — but the ink must stop at the edge, not fly off and reappear after a resize.
  it("clamps a pointer that has left the pad", () => {
    expect(normalisePoint(-500, -500, rect)).toEqual({ x: 0, y: 0 });
    expect(normalisePoint(5000, 5000, rect)).toEqual({ x: 1, y: 1 });
  });

  it("survives a pad that has not been laid out yet", () => {
    expect(normalisePoint(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe("backingSize — crisp without being wasteful", () => {
  it("matches the box on an ordinary display", () => {
    expect(backingSize(800, 200, 1)).toEqual({ width: 800, height: 200 });
  });

  it("follows the device pixel ratio so the signature isn't soft", () => {
    expect(backingSize(800, 200, 2)).toEqual({ width: 1600, height: 400 });
  });

  // The canvas becomes a PNG that gets uploaded, so the buffer has a real cost.
  it("caps the ratio rather than allocating a buffer nobody can see", () => {
    expect(backingSize(800, 200, 4)).toEqual({ width: 2400, height: 600 });
  });

  it("never produces a zero-sized bitmap", () => {
    expect(backingSize(0, 0, 1)).toEqual({ width: 1, height: 1 });
  });

  // A bitmap a fraction narrower than its box is resampled every draw and the strokes go soft.
  it("rounds up rather than down", () => {
    expect(backingSize(100.2, 50.1, 1)).toEqual({ width: 101, height: 51 });
  });
});

// Save was enabled on an untouched pad, so "signing" could upload a blank PNG — a receipt nobody
// signed, and indistinguishable in the record from one they did.
describe("isBlank — you can't acknowledge without actually signing", () => {
  it("is blank before anything is drawn", () => {
    expect(isBlank([])).toBe(true);
    expect(isBlank([[]])).toBe(true);
  });

  it("counts a single deliberate mark", () => {
    expect(isBlank([[{ x: 0.5, y: 0.5 }]])).toBe(false);
  });

  it("counts a real stroke", () => {
    const stroke: Stroke = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.4 }];
    expect(isBlank([stroke])).toBe(false);
  });
});
