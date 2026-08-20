// Image-upload helpers: the size rule, the data-URI reader, and the downscale every picture goes
// through before it is uploaded.

// Max upload size, enforced client-side.
//
// Checked AFTER `shrinkImage`, never before. A phone photo is routinely 4–15 MB and downscales to a
// few hundred KB, so testing the original would reject exactly the files this is meant to accept —
// which is the bug the engineer's van-stock and transfer pickers had.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB

// Longest edge, in pixels, that any uploaded image is reduced to.
//
// 1600 is chosen for what these pictures are FOR: evidence of damage, a photo of a label, an avatar.
// All of them are looked at on a screen, and none needs more than a large monitor's worth of detail.
// A 48 MP phone capture is ~8000px wide — 25× the pixels anyone will ever see, at ~40× the bytes.
const MAX_EDGE = 1600;

// JPEG quality for photographs. 0.85 is the usual knee: visually indistinguishable from the original
// at this size, roughly a fifth of the bytes of 1.0.
const JPEG_QUALITY = 0.85;

/**
 * Formats that must keep their alpha channel, so they are re-encoded as PNG rather than JPEG.
 *
 * This is not a preference. A signature is printed onto the purchase-order PDF and a logo sits on
 * the app's own chrome — JPEG has no transparency, so converting either one replaces "nothing" with
 * WHITE. The signature becomes a white box on the document; the logo grows a white rectangle. Both
 * look like a rendering fault rather than a compression choice, and neither is recoverable from the
 * stored file. PNG re-encoding still gets the size win, because the win here is the DOWNSCALE.
 */
const ALPHA_TYPES = new Set(["image/png", "image/webp"]);

/**
 * Raster formats that are left exactly as they are.
 *
 * GIF is accepted as evidence and may be ANIMATED. A canvas holds one frame, so re-encoding one
 * silently throws away every frame after the first — the upload succeeds, looks fine in the
 * thumbnail, and has lost the only thing the sender was trying to show. SVG is markup rather than a
 * raster, and rasterising it loses the one property it was chosen for.
 *
 * ICO is a favicon, and a favicon is not a picture — it is a container of small square sizes the
 * browser picks from. Re-encoding one produces a single-size JPEG called `.ico`, which is both
 * larger than the original and no longer the thing the browser asked for. Branding accepts it under
 * two media types, because Windows and everyone else disagree on its name.
 */
const SKIP_TYPES = new Set([
  "image/gif",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

// Read a File as a base64 data URI (for an instant preview + upload to the backend).
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

/** Load a File into an <img>, via an object URL that is always revoked. */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // Not an error the caller should surface — see shrinkImage's contract.
      reject(new Error("decode-failed"));
    };
    img.src = url;
  });
}

/**
 * Downscale an image so it uploads in a few hundred KB instead of several MB.
 *
 * ## Returns the ORIGINAL rather than throwing
 *
 * Every failure path here — a format the browser will not decode (HEIC on some desktops), a canvas
 * the device refuses to allocate, a `toBlob` that yields nothing — resolves to the file it was
 * given. Shrinking is an optimisation, and an optimisation that can block an upload is worse than no
 * optimisation: an engineer standing in a warehouse needs the photo to go, not a lecture about
 * codecs. The server's size ceiling is the backstop for those cases, which is why it was raised to
 * match what a phone actually produces.
 *
 * ## What it does NOT touch
 *
 * Anything that is not an image. Documents (PDF, DOCX) and spreadsheets pass straight through —
 * re-encoding one through a canvas would destroy it. Callers on document pickers should not call
 * this at all; the guard is here as well because a picker that also accepts PNG/JPG (the PO, PRF and
 * job attachment lists do) would otherwise have to make the decision itself, per file.
 *
 * ## Why an image already under the limit is still processed
 *
 * A 1.8 MB, 6000px-wide photo passes the size rule and then costs the viewer a 6000px download on
 * every page that renders it. Size is the constraint we enforce; DIMENSION is the one that actually
 * makes the file expensive afterwards. Small images are skipped by dimension, not by byte count.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  if (SKIP_TYPES.has(file.type)) return file;

  try {
    const img = await loadImage(file);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (!longest) return file;

    const scale = Math.min(1, MAX_EDGE / longest);
    // Already small enough that re-encoding would only cost quality.
    if (scale === 1) return file;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const keepAlpha = ALPHA_TYPES.has(file.type);
    const outType = keepAlpha ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) =>
      // Quality is ignored for PNG, which is lossless — the saving there is entirely the downscale.
      canvas.toBlob(resolve, outType, keepAlpha ? undefined : JPEG_QUALITY),
    );
    if (!blob) return file;

    // A re-encode can come out LARGER — a small PNG screenshot of flat colour is the usual case,
    // where PNG's own compression already beat anything a canvas round-trip will manage. Keeping
    // whichever is smaller means this can never make an upload worse.
    if (blob.size >= file.size) return file;

    return new File([blob], renameFor(file.name, outType), { type: outType, lastModified: Date.now() });
  } catch {
    return file;
  }
}

/** Keep the user's filename but correct the extension when the encoding changed. */
function renameFor(name: string, outType: string): string {
  const ext = outType === "image/png" ? "png" : "jpg";
  const stem = name.replace(/\.[^/.]+$/, "") || "image";
  return `${stem}.${ext}`;
}
