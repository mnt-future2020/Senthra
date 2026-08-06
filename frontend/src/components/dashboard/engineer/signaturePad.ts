// Geometry for the acknowledge-receipt signature pad.
//
// A <canvas> has TWO sizes: the bitmap it draws into (the width/height attributes) and the box CSS
// gives it on screen. The pad's bitmap was fixed at 480×160 while the element was `w-full`, so on a
// 1520px-wide desktop the browser stretched it ~3.2×. Pointer positions were handed to the context in
// CSS pixels with no conversion, so every stroke landed ~3.2× further right and lower than the cursor
// — off the visible board entirely at the right-hand edge. It "worked" on a phone only because a
// ~390px viewport is close enough to 480 for the error to look like wobble.
//
// The fix is to stop mixing the two spaces at all: pointer input is normalised to a 0–1 fraction of
// the rendered box, and strokes are stored that way. Nothing in the stored drawing depends on the
// pad's pixel size, so a resize (or a device-pixel-ratio change when a window moves to another
// monitor) just re-renders the same signature at the new size instead of distorting or losing it.

/** A point as a fraction of the pad's rendered box — 0,0 top-left, 1,1 bottom-right. */
export interface PadPoint {
  x: number;
  y: number;
}

export type Stroke = PadPoint[];

export interface PadRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Pointer position → fraction of the pad.
 *
 * Clamped to 0–1: a pointer captured mid-stroke keeps reporting once it leaves the canvas (that
 * capture is what stops a fast signature from breaking into pieces), and an unclamped value would
 * draw outside the bitmap and reappear as a stray mark after the next resize re-render.
 */
export function normalisePoint(clientX: number, clientY: number, rect: PadRect): PadPoint {
  const clamp = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
  return {
    x: clamp(rect.width > 0 ? (clientX - rect.left) / rect.width : 0),
    y: clamp(rect.height > 0 ? (clientY - rect.top) / rect.height : 0),
  };
}

/**
 * Bitmap size for a CSS box, so a signature is as crisp as the screen allows.
 *
 * `dpr` is capped at 3: beyond that the extra pixels are invisible but the allocation isn't — a
 * full-width pad on a 4× display would be a multi-megabyte buffer, and this canvas is converted to a
 * PNG and uploaded. Rounded UP, because a bitmap a fraction narrower than its box is resampled on
 * every draw and the strokes come out soft.
 */
export function backingSize(cssWidth: number, cssHeight: number, dpr = 1): { width: number; height: number } {
  const scale = Math.min(Math.max(dpr, 1), 3);
  return { width: Math.ceil(Math.max(cssWidth, 1) * scale), height: Math.ceil(Math.max(cssHeight, 1) * scale) };
}

/**
 * Has anything actually been drawn?
 *
 * Save was enabled on an untouched pad, so "signing" was one click away from uploading a blank PNG —
 * a receipt nobody signed, indistinguishable in the record from one they did. A single tap counts:
 * it is a deliberate mark, and judging a signature's quality is not this component's business.
 */
export function isBlank(strokes: readonly Stroke[]): boolean {
  return !strokes.some((s) => s.length > 0);
}
