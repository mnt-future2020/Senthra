// Document Platform — shared helpers (address joining, image fetching, filenames).

import { DOCUMENT_LABELS } from "./document.constants.js";
import type { DocumentType } from "./document.types.js";

// Trim + drop empty parts, returning the non-empty address lines.
export function joinAddressLines(parts: (string | null | undefined)[]): string[] {
  return parts.map((p) => p?.trim()).filter((p): p is string => Boolean(p && p.length));
}

// Force a pdfkit-safe raster (PNG) + bounded height for a Cloudinary asset — pdfkit embeds only
// PNG/JPEG, so a webp/avif/svg logo or signature would otherwise fail to draw. No-op otherwise.
export function pdfSafeImageUrl(url: string): string {
  if (url.includes("res.cloudinary.com/") && url.includes("/upload/") && !url.includes("/upload/f_")) {
    return url.replace("/upload/", "/upload/f_png,h_400,c_limit/");
  }
  return url;
}

// Fetch a remote image (Cloudinary logo/signature) into a Buffer for pdfkit. Returns null on ANY
// failure (network, non-OK, non-image) so document generation degrades gracefully — never throws.
// Bounded by a 5s timeout and a size cap so a slow/huge asset can't stall every PDF render or
// blow up memory (every send/download fetches the logo).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export async function fetchImageBuffer(url: string | null | undefined): Promise<Buffer | null> {
  const u = url?.trim();
  if (!u) return null;
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !type.startsWith("image/")) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

// THE single filename source for every generated document — used by the download response
// (Content-Disposition) and the email attachment, so a document is named identically everywhere.
export function getDocumentFileName(type: DocumentType, code: string, ext = "pdf"): string {
  const cleaned = (code || DOCUMENT_LABELS[type] || "document")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  const stem = cleaned || "document"; // never produce a bare ".pdf"
  return `${stem}.${ext}`;
}
