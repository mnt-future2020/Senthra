import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

// Downscaling for every photo this app uploads. Mirrors the web's `frontend/src/lib/image.ts` —
// same edge, same quality, same "return the original rather than fail" contract — because the two
// clients feed the same endpoints and a photo should not be twenty times larger for having been
// taken on a phone instead of picked in a browser.
//
// ## Why this exists
//
// The pickers only ever set `quality`, which re-encodes at a lower JPEG quality but keeps every
// pixel. A modern phone camera is 12–48 MP, so a "compressed" capture is still 2–5 MB — and both
// upload endpoints relay base64 through our own server, where the ~2 MB ceiling is measured on the
// ENCODED string, which is 4/3 the file. The result was an engineer standing in a van being told
// "Attachment is too large" for taking an ordinary photo, with no way to make it smaller from the
// phone. Resizing is what actually fixes that: the pixels, not the quality dial, are the size.

/**
 * Longest edge, in pixels, that an uploaded photo is reduced to.
 *
 * Matches the web. These images are evidence — a damaged item, a delivery label, a van shelf — and
 * they are looked at on a screen. A 48 MP capture is ~8000px wide, roughly 25× the pixels anyone
 * will ever see and ~40× the bytes.
 */
const MAX_EDGE = 1600;

/** JPEG quality. 0.8 is visually indistinguishable at this size and a fraction of the bytes. */
const COMPRESS = 0.8;

/**
 * Largest image the upload endpoints accept, checked AFTER shrinking.
 *
 * The server caps the base64 STRING at 3 M characters, which is this much actual file. Stated here
 * as the decoded size because that is the number a caller can compare against and the number a user
 * would recognise. Slightly conservative on purpose — a rounding difference should not turn into a
 * server rejection the picker could have explained.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export interface ShrunkImage {
  /** A `data:` URI ready to post to the attachment endpoints, which take base64. */
  dataUri: string;
  /** Decoded byte length, for a size check that measures what will actually be sent. */
  bytes: number;
  /** What the URI actually holds — a caller naming the file must use THIS, not the picked type. */
  mimeType: string;
}

/**
 * Formats that must keep their alpha channel, so they are re-encoded as PNG rather than JPEG.
 *
 * The same rule, and the same reason, as the web's `ALPHA_TYPES`. This helper backs the account
 * screen's ONE picker, which serves both the avatar and the SIGNATURE — and a signature is printed
 * onto the purchase-order PDF. JPEG has no transparency, so re-encoding one replaces "nothing" with
 * WHITE: the signature becomes a solid block sitting over the document, on every PO that user
 * issues, and it is not recoverable from the stored file. The size win here is the downscale, which
 * PNG keeps.
 */
const ALPHA_TYPES = new Set(["image/png", "image/webp"]);

/**
 * Resize a picked photo and hand back the data URI to upload.
 *
 * ## Falls back to the original rather than throwing
 *
 * Every failure — a format the OS decoder refuses, a device too memory-constrained to hold the
 * bitmap, a manipulator that returns no base64 — resolves to the bytes the picker already gave us.
 * Shrinking is an optimisation, and an optimisation that can block an upload is worse than none: an
 * engineer needs the photo to go. The server's ceiling is the backstop for those cases.
 *
 * ## Only downscales
 *
 * An image already inside `MAX_EDGE` is returned untouched. Re-encoding a small image costs quality
 * and can cost bytes, and the saving here is the downscale, not the quality dial.
 *
 * ## EXIF
 *
 * The manipulator decodes and re-encodes, which discards EXIF. That is wanted, not tolerated: a
 * phone photo carries GPS coordinates, and an engineer's evidence photo has no business publishing
 * where they were standing. Orientation survives because it is applied to the pixels on decode.
 *
 * @param uri        the picked asset's local URI
 * @param base64     the picker's own base64, used as the fallback
 * @param width      the picked asset's width, or 0 when the picker did not report one
 * @param height     the picked asset's height, or 0 when the picker did not report one
 * @param mimeType   the picked asset's media type, for the fallback URI
 */
export async function shrinkImage(
  uri: string,
  base64: string,
  width: number,
  height: number,
  mimeType = "image/jpeg",
): Promise<ShrunkImage> {
  const original: ShrunkImage = {
    dataUri: `data:${mimeType};base64,${base64}`,
    bytes: decodedBytes(base64),
    mimeType,
  };

  const longest = Math.max(width, height);
  // No dimensions reported, or already small enough. Not an error — nothing to do.
  if (!longest || longest <= MAX_EDGE) return original;

  try {
    // Constrain the LONGER edge and leave the other unset — the manipulator derives it, so the
    // aspect ratio is preserved without this having to do the arithmetic (and round it wrong).
    const target = width >= height ? { width: MAX_EDGE } : { height: MAX_EDGE };

    // PNG for anything carrying alpha, JPEG otherwise — see ALPHA_TYPES. `compress` is ignored for
    // PNG, which is lossless; the saving there is entirely the downscale.
    const keepAlpha = ALPHA_TYPES.has(mimeType);
    const outMime = keepAlpha ? "image/png" : "image/jpeg";
    const ref = await ImageManipulator.manipulate(uri).resize(target).renderAsync();
    const out = await ref.saveAsync({
      format: keepAlpha ? SaveFormat.PNG : SaveFormat.JPEG,
      compress: COMPRESS,
      base64: true,
    });
    if (!out.base64) return original;

    const shrunk: ShrunkImage = {
      dataUri: `data:${outMime};base64,${out.base64}`,
      bytes: decodedBytes(out.base64),
      mimeType: outMime,
    };
    // A re-encode can come out larger — a small flat-colour PNG is the usual case. Keeping whichever
    // is smaller means this can never make an upload worse.
    return shrunk.bytes < original.bytes ? shrunk : original;
  } catch {
    return original;
  }
}

/** Bytes a base64 string decodes to. `length * 3/4`, minus the padding. */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
