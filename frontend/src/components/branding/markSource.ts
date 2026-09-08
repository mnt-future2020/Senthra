import { optimizeCloudinaryUrl } from "@/lib/utils";

// An image further from square than this can't survive the slot: at the sizes
// BrandMark renders (36–44 CSS px) a 4:1 lockup letterboxes down to an ~8px
// strip of unreadable text in a mostly-empty plate. Measured both ways, so a
// tall image is rejected on the same grounds as a wide one.
export const MAX_SQUARE_RATIO = 1.5;

// The largest BrandMark slot is 44 CSS px (SetPasswordScreen's h-11/w-11), so
// 96 covers it on a 2x display with room to spare. Cloudinary is asked for at
// most this, never more — the 512px favicon has no business being sent whole.
export const MARK_RENDER_PX = 96;

// Below this the source is being upscaled into the slot rather than fitted to
// it: a conventional 32x32 .ico blown up to 88 physical px is visibly mushy.
// Such a source is rejected in favour of the next candidate, so the brand gets
// a crisp letter rather than a smeared icon. Must stay under MARK_RENDER_PX,
// which is the largest size a Cloudinary candidate can come back at.
export const MIN_SOURCE_PX = 64;

// The URL to actually request for the square slot.
//
// `c_limit` scales DOWN to fit the box and never up, which does double duty: it
// stops a 512px asset being shipped whole, and it leaves a too-small source at
// its own size so `fitsSquareSlot` can still see how small it really is. A
// `w_`-only transform would report the requested width regardless.
//
// .ico is passed through untouched. Cloudinary's f_auto has no reliable
// transcode for it, and browsers render .ico in an <img> natively, so
// transforming it risks turning a working favicon into a failed request.
export function markSrc(url: string): string {
  if (/\.ico(\?|#|$)/i.test(url)) return url;

  const optimized = optimizeCloudinaryUrl(url);
  // optimizeCloudinaryUrl returns non-Cloudinary URLs (and already-transformed
  // ones) unchanged; there is no transform slot to extend in that case.
  const marker = "/upload/f_auto,q_auto/";
  if (!optimized.includes(marker)) return optimized;

  return optimized.replace(
    marker,
    `/upload/f_auto,q_auto,c_limit,w_${MARK_RENDER_PX},h_${MARK_RENDER_PX}/`,
  );
}

// Whether a loaded image is shaped and sized to be the square brand mark.
// Takes the DELIVERED dimensions (post-transform), which is what the slot
// actually has to work with.
export function fitsSquareSlot(naturalWidth: number, naturalHeight: number): boolean {
  if (naturalWidth <= 0 || naturalHeight <= 0) return false;

  const longest = Math.max(naturalWidth, naturalHeight);
  const shortest = Math.min(naturalWidth, naturalHeight);

  if (longest / shortest > MAX_SQUARE_RATIO) return false;
  return shortest >= MIN_SOURCE_PX;
}
