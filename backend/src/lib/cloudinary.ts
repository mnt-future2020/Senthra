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

// Upload an arbitrary file (data URI) — used for purchase-request / purchase-order / goods-in
// attachments and the archived issued-PO PDF. Each attachment is a distinct asset (unique
// publicId, no overwrite); returns its secure URL. The resource type is chosen from the file's
// MIME so PDFs/DOCX are stored (and delivered) as `raw`, not misclassified as images.
export async function uploadFileToCloudinary(
  source: string,
  publicId: string,
  creds: CloudinaryCreds,
  folder = "senthra/purchase-orders",
): Promise<string> {
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
  return result.secure_url;
}
