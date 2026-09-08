import { describe, expect, it } from "vitest";

import {
  MARK_RENDER_PX,
  MAX_SQUARE_RATIO,
  MIN_SOURCE_PX,
  fitsSquareSlot,
  markSrc,
} from "./markSource";

const CLOUDINARY = "https://res.cloudinary.com/demo/image/upload/v1788867523/senthra/logo.png";

describe("markSrc", () => {
  it("caps a Cloudinary source to the slot size instead of shipping it whole", () => {
    // The 512px favicon has no business being downloaded in full for a 36px slot.
    expect(markSrc(CLOUDINARY)).toBe(
      `https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,c_limit,w_${MARK_RENDER_PX},h_${MARK_RENDER_PX}/v1788867523/senthra/logo.png`,
    );
  });

  it("uses c_limit so a small source is never upscaled by the CDN", () => {
    // c_limit is what lets fitsSquareSlot still see a 32px source as 32px. A
    // w_-only transform would hand back the requested width and hide it.
    expect(markSrc(CLOUDINARY)).toContain("c_limit");
    expect(markSrc(CLOUDINARY)).not.toMatch(/\/upload\/[^/]*c_fill/);
  });

  it("passes .ico through untouched", () => {
    // f_auto has no reliable .ico transcode, and browsers render .ico natively.
    // Transforming it would turn a working favicon into a failed request.
    const ico = "https://res.cloudinary.com/demo/image/upload/v1/senthra/favicon.ico";
    expect(markSrc(ico)).toBe(ico);
    expect(markSrc(`${ico}?v=2`)).toBe(`${ico}?v=2`);
  });

  it("leaves a non-Cloudinary URL alone", () => {
    const external = "https://cdn.example.com/brand/logo.png";
    expect(markSrc(external)).toBe(external);
  });

  it("does not double-transform a URL that already carries f_auto", () => {
    const once = markSrc(CLOUDINARY);
    expect(markSrc(once)).toBe(once);
  });
});

describe("fitsSquareSlot", () => {
  it("accepts a square source at or above the resolution floor", () => {
    // The 512px PNG favicon, delivered at the 96px cap.
    expect(fitsSquareSlot(MARK_RENDER_PX, MARK_RENDER_PX)).toBe(true);
    expect(fitsSquareSlot(MIN_SOURCE_PX, MIN_SOURCE_PX)).toBe(true);
  });

  it("rejects the wide wordmark that started all this", () => {
    // 1339x303 capped to width 96 → 96x22.
    expect(fitsSquareSlot(96, 22)).toBe(false);
  });

  it("rejects a tall image on the same grounds as a wide one", () => {
    // Letterboxing is just as bad rotated 90 degrees.
    expect(fitsSquareSlot(22, 96)).toBe(false);
  });

  it("rejects a tiny .ico rather than upscaling it into the slot", () => {
    // 32x32 blown up to 88 physical px on a 2x display is visibly mushy; the
    // letter chip is the better mark.
    expect(fitsSquareSlot(32, 32)).toBe(false);
    expect(fitsSquareSlot(MIN_SOURCE_PX - 1, MIN_SOURCE_PX - 1)).toBe(false);
  });

  it("allows a little off-square before rejecting", () => {
    expect(fitsSquareSlot(96, Math.ceil(96 / MAX_SQUARE_RATIO))).toBe(true);
    expect(fitsSquareSlot(96, Math.floor(96 / MAX_SQUARE_RATIO) - 1)).toBe(false);
  });

  it("treats an unmeasurable image as a non-fit", () => {
    // A decode failure reports 0; that must fall through, not divide by zero.
    expect(fitsSquareSlot(0, 0)).toBe(false);
    expect(fitsSquareSlot(96, 0)).toBe(false);
    expect(Number.isFinite(MAX_SQUARE_RATIO)).toBe(true);
  });

  it("keeps the floor below the delivery cap", () => {
    // If MIN_SOURCE_PX ever exceeded MARK_RENDER_PX, c_limit would cap every
    // candidate below the floor and nothing would ever qualify.
    expect(MIN_SOURCE_PX).toBeLessThan(MARK_RENDER_PX);
  });
});
