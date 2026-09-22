// ── Image derivatives, for a provider that cannot transform at delivery ────────────────────────
//
// Cloudinary rewrites an image on the way OUT: ask for `f_png,fl_png32,h_400,c_limit` and it returns
// a rasterised, height-capped, 32-bit copy of whatever was stored. An object store returns the bytes
// it was given and nothing else. So the same result has to be produced on the way IN — once, at
// upload time — and stored alongside the original.
//
// WHY AT UPLOAD TIME, not on demand: the source bytes are already in hand. Every asset that feeds a
// PDF or an email arrives here as a base64 data URI through a server-relay endpoint (branding logo,
// PO logo, user signature), so generating now costs nothing extra, while generating later would mean
// downloading the object back out of storage on every render.
//
// THE TWO INTENTS EXIST FOR DIFFERENT REASONS, and neither is an optimisation:
//
//   pdf   — pdfkit embeds only PNG and JPEG, and it draws a LOW-BIT-DEPTH PALETTE PNG as a scrambled
//           strip of blocks. A flat two-colour company logo is exactly that shape. `fl_png32` is what
//           forces Cloudinary to hand back 32-bit RGBA instead; `ensureAlpha()` is what forces it
//           here. Getting this wrong puts a block of garbage on a supplier-facing purchase order.
//   email — Gmail and Outlook do not render an SVG `<img>`. A vector wordmark uploaded as branding
//           would show as bare alt text in most inboxes unless it is rasterised first.


import type { StorageProvider } from "./types.js";

/** Which rendering an asset is wanted for. */
export type DerivativeIntent = "pdf" | "email";

/**
 * The sharp equivalent of each Cloudinary transform string, kept side by side so the two cannot
 * drift into producing visibly different images.
 *
 *   f_png       → `.png()`
 *   fl_png32    → `.ensureAlpha()` + `palette: false` — 8 bits per channel, RGBA, colour type 6
 *   h_400/h_80  → `.resize({ height })`
 *   c_limit     → `fit: "inside"` + `withoutEnlargement: true` — scales DOWN to fit, never up
 *
 * The heights differ and must stay apart: 400 is sized for print, 80 is retina for a 34px logo in a
 * mail client. See `pdfSafeImageUrl` and `emailLogoSrc`, which carry the same numbers.
 */
export const DERIVATIVE_SPECS: Record<DerivativeIntent, { maxHeight: number; suffix: string }> = {
  pdf: { maxHeight: 400, suffix: "__pdf.png" },
  email: { maxHeight: 80, suffix: "__email.png" },
};

/** `data:image/png;base64,…` → the bytes. Null when it is not a base64 data URI. */
function bytesOf(dataUri: string): Buffer | null {
  const comma = dataUri.indexOf(",");
  if (!dataUri.startsWith("data:") || comma < 0) return null;
  return Buffer.from(dataUri.slice(comma + 1), "base64");
}

/**
 * Rasterise one image to a pdfkit-safe, height-capped PNG.
 *
 * `ensureAlpha()` is the load-bearing call and is NOT cosmetic: without it an opaque source encodes
 * as colour type 2 (RGB) or, worse, stays indexed — and a 1-bit palette PNG is precisely the input
 * pdfkit renders as scrambled blocks. Forcing a fourth channel guarantees colour type 6, which is
 * the one shape pdfkit always draws correctly. `palette: false` stops sharp helpfully re-quantising
 * a flat logo back down to a palette on the way out.
 *
 * `withoutEnlargement` mirrors `c_limit`: a 60px-tall signature stays 60px rather than being blown
 * up to 400 and going soft.
 *
 * Throws on an undecodable source rather than returning a silent null — the caller needs to know a
 * derivative is missing, because falling back to the original would put the unrenderable image back
 * in the document this exists to fix.
 */
export async function renderDerivative(source: string, intent: DerivativeIntent): Promise<Buffer> {
  const bytes = bytesOf(source);
  if (!bytes) throw new Error("derivative source is not a base64 data URI");
  // Loaded HERE, not at the top of the file, and that is a deployment constraint rather than a
  // style choice. `sharp` is a native binary: when its prebuilt artifact does not match the host's
  // platform, architecture or libc, importing it THROWS. This module is reached from
  // settings.service and user.service, both of which load during boot — so a top-level import made
  // every install's backend refuse to start on a bad binary, including the Cloudinary-only installs
  // that will never render a derivative in their lives. Importing it inside the one function that
  // actually transforms an image confines that failure to the request that needs it.
  const { default: sharp } = await import("sharp");
  return sharp(bytes)
    .resize({ height: DERIVATIVE_SPECS[intent].maxHeight, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .png({ palette: false, compressionLevel: 9 })
    .toBuffer();
}

/** The key a derivative is stored under: the original's, with the intent's suffix. */
export function derivativeKey(publicId: string, intent: DerivativeIntent): string {
  return `${publicId}${DERIVATIVE_SPECS[intent].suffix}`;
}

/**
 * Render and store every requested derivative for one source image.
 *
 * ALL OR NOTHING. If any intent fails after another has already been stored, the ones already
 * written are removed before the error is allowed out — a half-generated set would leave the PDF
 * correct and the email wrong, or the reverse, with nothing recording which.
 *
 * `immutable: false` throughout, and that is not an oversight: a derivative key is derived from the
 * SOURCE key, so a deterministic source (`logo`, `signature-<userId>`) produces a deterministic
 * derivative that is overwritten in place on every re-upload. A long cache there would keep serving
 * the old logo from the edge after it had been replaced.
 */
export async function generateDerivatives(
  source: string,
  publicId: string,
  folder: string,
  intents: DerivativeIntent[],
  storage: StorageProvider,
): Promise<Partial<Record<DerivativeIntent, string>>> {
  const written: { key: string; resourceType: string }[] = [];
  const urls: Partial<Record<DerivativeIntent, string>> = {};

  try {
    for (const intent of intents) {
      const png = await renderDerivative(source, intent);
      const asset = await storage.upload(
        `data:image/png;base64,${png.toString("base64")}`,
        derivativeKey(publicId, intent),
        { folder, kind: "image", immutable: false },
      );
      written.push({ key: asset.publicId, resourceType: asset.resourceType });
      urls[intent] = asset.url;
    }
  } catch (e) {
    // Remove whatever this call already stored, through the SAME provider instance that stored it —
    // never a freshly resolved one, which could by then be a different backend entirely.
    for (const w of written) {
      await storage
        .destroy({ provider: storage.id, publicId: w.key, resourceType: w.resourceType })
        .catch((err: unknown) =>
          console.error(`[derivatives] could not clean up ${w.key}:`, err instanceof Error ? err.message : err),
        );
    }
    throw e;
  }

  return urls;
}
