import { v2 as cloudinary } from "cloudinary";

export interface CloudinaryCreds {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

// Upload an image (data URI or URL) to Cloudinary and return its secure URL.
// Credentials are passed in (resolved from DB settings or env by the caller),
// so this stays a pure transport with no config source of its own.
// `publicId` is stable per asset (e.g. "logo" / "favicon") so re-uploads
// overwrite; `folder` groups assets (branding vs user avatars).
export async function uploadToCloudinary(
  source: string,
  publicId: string,
  creds: CloudinaryCreds,
  folder = "senthra/branding",
): Promise<string> {
  cloudinary.config({
    cloud_name: creds.cloudName,
    api_key: creds.apiKey,
    api_secret: creds.apiSecret,
    secure: true,
  });
  const result = await cloudinary.uploader.upload(source, {
    folder,
    public_id: publicId,
    overwrite: true,
    invalidate: true,
    resource_type: "image",
  });
  return result.secure_url;
}

// Pick the Cloudinary resource_type from a data-URI's MIME. Images (PNG/JPG/…) go up as `image`;
// EVERYTHING else — PDF, DOCX and any future document type — goes up as `raw`.
//
// Why NOT `resource_type: "auto"`: Cloudinary's auto-detection classifies a PDF as an `image`
// (it can rasterise PDF pages), so the asset lands on the `/image/upload/` delivery path — which
// most accounts BLOCK for PDF/ZIP by default (the "allow delivery of PDF and ZIP files" security
// setting is off), returning HTTP 401 when the file is opened. Uploading documents as `raw`
// stores them as opaque files on the `/raw/upload/` path, which is delivered normally. Images are
// unaffected either way, so routing only images to `image` keeps their transformations available.
function resourceTypeForDataUri(source: string): "image" | "raw" {
  // data:image/png;base64,....  → "image/png"
  const mime = /^data:([^;,]+)/i.exec(source)?.[1]?.toLowerCase() ?? "";
  return mime.startsWith("image/") ? "image" : "raw";
}

// File extension for a `raw` upload's public_id. Cloudinary serves a raw asset at exactly its
// public_id, so WITHOUT the extension the delivery URL ends in the bare UUID and the browser
// gets no `.pdf`/`.docx` hint (it downloads as an extensionless blob). Appending the real
// extension makes the URL end in `.pdf` and open inline. Images don't need this — Cloudinary
// derives their format itself and appends it to the URL.
const MIME_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
function rawExtensionForDataUri(source: string): string | null {
  const mime = /^data:([^;,]+)/i.exec(source)?.[1]?.toLowerCase() ?? "";
  return MIME_EXTENSION[mime] ?? null;
}

/**
 * The identity of one stored asset, as Cloudinary itself reports it.
 *
 * BOTH fields together address the asset — `publicId` alone does not. The same id can exist as an
 * `image` and as a `raw` asset simultaneously, and `uploader.destroy` takes `resource_type` as a
 * separate argument; pass the wrong one and Cloudinary answers "not found" for a file that is
 * still there. Everything downstream (persistence, reference counting, deletion) treats the pair
 * as the identity.
 *
 * `publicId` is taken from the upload RESULT rather than the id we asked for, because the two are
 * not always the same string: a raw upload has its extension baked in, and Cloudinary is free to
 * normalise. Recording what it actually stored is what makes a later delete addressable.
 */
export interface CloudinaryAsset {
  url: string;
  publicId: string;
  resourceType: string;
}

// Upload an arbitrary file (data URI) — used for purchase-request / purchase-order / goods-in
// attachments and the archived issued-PO PDF. Each attachment is a distinct asset (unique
// publicId, no overwrite). The resource type is chosen from the file's MIME so PDFs/DOCX are
// stored (and delivered) as `raw`, not misclassified as images.
//
// Returns the full identity, not just the URL. It used to return the URL alone, which meant every
// caller stored a file it could never afterwards name — so nothing was ever deleted from
// Cloudinary anywhere in this app. The wider return type is deliberate: it breaks every caller at
// compile time, which is how each one gets visited instead of quietly dropping the identity again.
export async function uploadFileToCloudinary(
  source: string,
  publicId: string,
  creds: CloudinaryCreds,
  folder = "senthra/purchase-orders",
): Promise<CloudinaryAsset> {
  cloudinary.config({
    cloud_name: creds.cloudName,
    api_key: creds.apiKey,
    api_secret: creds.apiSecret,
    secure: true,
  });
  const resourceType = resourceTypeForDataUri(source);
  // For raw documents, bake the extension into the public_id so the delivery URL ends in `.pdf`
  // (Cloudinary serves a raw asset verbatim at its public_id). Images get their extension from
  // Cloudinary's own format detection, so their public_id stays extensionless.
  const ext = resourceType === "raw" ? rawExtensionForDataUri(source) : null;
  const result = await cloudinary.uploader.upload(source, {
    folder,
    public_id: ext ? `${publicId}.${ext}` : publicId,
    resource_type: resourceType,
  });
  return { url: result.secure_url, publicId: result.public_id, resourceType: result.resource_type };
}

/**
 * Delete one stored asset. BEST-EFFORT CLEANUP, never part of a business operation.
 *
 * Callers must have already committed the database change that removed the last reference — see
 * the ordering rule in attachment.repository.ts. This function is the last step, and its failure
 * is not the caller's failure: the worst outcome here is a file nobody references, which is
 * exactly the state the whole app was in before this existed.
 *
 * An already-missing asset is a SUCCESS. Cloudinary answers `{ result: "not found" }` for an id it
 * has no record of, which is indistinguishable from "a previous attempt already deleted it" — and
 * both mean the intended end state holds. Treating it as an error would make a retry look broken.
 */
export async function destroyFromCloudinary(
  publicId: string,
  resourceType: string,
  creds: CloudinaryCreds,
): Promise<void> {
  cloudinary.config({
    cloud_name: creds.cloudName,
    api_key: creds.apiKey,
    api_secret: creds.apiSecret,
    secure: true,
  });
  // `invalidate` clears the CDN copy too — without it the file keeps being served from the edge
  // after the origin is gone, which for a customer document is the part that actually matters.
  const result = await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    invalidate: true,
  });
  if (result.result !== "ok" && result.result !== "not found") {
    throw new Error(`Cloudinary destroy returned "${result.result}"`);
  }
}
