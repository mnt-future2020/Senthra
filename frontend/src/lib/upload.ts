import { api } from "./api";
import type { PrfDocumentType } from "@/types/purchase-request";
import { shrinkImage } from "./image";
import { EXT_MEDIA_TYPE } from "./uploadPolicy";

// ── Direct browser upload ──────────────────────────────────────────────────────────────────────
//
// The file goes from this browser straight to the storage provider and never through our backend.
// What the backend still decides is the part that matters — whether this user may upload here, and
// whether what arrived is what was promised — so the round trip is: ask for an upload envelope, post
// the file where it says, hand back whatever the provider answered.
//
// WHICH provider is deliberately unknowable here. The envelope describes a protocol, not a vendor:
// a method, a URL and an opaque bag of signed fields. Nothing in this file reads those fields or
// branches on where they are going, which is what lets a second backend be added without touching
// the frontend at all.
//
// Whatever a caller checks before calling this — extension, size, `file.type` — is UX ONLY. It exists
// so a wrong file is refused in the picker rather than after a 10 MB upload, and none of it is
// trusted: the signed fields cap the size and the destination at the provider, and the server reads
// a document's actual bytes before it will attach one.

/**
 * Extension → the media type the backend's catalog names.
 *
 * `File.type` comes from the OS, and it lies by omission: a machine with no Office install reports
 * `""` for a `.docx`, and some report `application/octet-stream`. Either one is not in any purpose's
 * allow-list, so the SIGNATURE request is refused — the user picks a valid document and is told the
 * file type isn't accepted. jobAttachment.ts already worked this out for the old base64 path and
 * carries the same table; the direct path went back to sending `file.type` raw, so only JobForm
 * (which guards the empty-string case itself) was covered.
 *
 * Deriving from the extension is not a weakening of the server's gate. That gate reads a
 * client-supplied string either way, so it was never a boundary against a hostile caller — the real
 * check is the magic-byte read finalize does on the stored file. This just stops it refusing files
 * that are genuinely fine.
 */
// Lives in ./uploadPolicy with the accept strings and the extension→fileType map it has to agree
// with. It was a second copy here, and a second copy of a list whose whole purpose is to match the
// backend's is a list that will eventually not.
const MEDIA_TYPE_BY_EXTENSION = EXT_MEDIA_TYPE;

/**
 * What to declare this file as. The extension wins when we recognise it; `file.type` is the fallback
 * for anything else, so an unknown extension still fails on the server rather than silently here.
 */
export function mediaTypeFor(file: File): string {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_TYPE_BY_EXTENSION[ext] ?? file.type;
}

/** Which upload contract this is. Must match a key in the backend's upload catalog. */
export type UploadPurpose =
  | "job_attachment"
  | "prf_attachment"
  | "po_attachment"
  | "grn_attachment"
  | "damage_photo"
  | "vsr_attachment"
  | "vsr_damage_photo"
  | "transfer_attachment"
  // Condition evidence on a hire delivery. `attach` mode, unlike the other evidence photos: its record
  // exists by the time the photo is taken, so the asset keeps an identity that can be released with it.
  | "hire_delivery_photo";

/**
 * What the server says to do with this file — the whole of the browser's knowledge about storage.
 *
 * There is no provider name here, and no provider-specific field: no cloud name, no api key, no
 * preset, no AWS anything. The browser performs the protocol it is handed and cannot tell which
 * backend is on the other end. That is deliberate — a client that could tell would eventually grow
 * an `if (provider === ...)`, and then every future backend means a frontend change.
 */
interface UploadEnvelope {
  method: "POST";
  url: string;
  /**
   * Posted VERBATIM, and before the file.
   *
   * Opaque on purpose: these are the values the server's signature was computed over. Renaming one,
   * re-stringifying it, reordering them or dropping one invalidates the upload — so this side never
   * reads them, it only forwards them.
   */
  fields: Record<string, string>;
  /** The key the upload was authorised for. What finalize needs when the provider returns no body. */
  publicId: string;
  purpose: UploadPurpose;
}

/**
 * What a provider may hand back, all of it optional.
 *
 * Cloudinary answers with JSON and signs it. An S3 presigned POST answers 204 with no body at all.
 * Neither shape is assumed: success is decided by the HTTP status, and whatever the body happens to
 * contain is passed along for the server to check if it wants to.
 */
interface UploadReceipt {
  publicId?: string;
  version?: number | string;
  signature?: string;
}

export interface UploadOptions {
  purpose: UploadPurpose;
  file: File;
  /** The record this attaches to, for purposes that attach rather than stage in a form. */
  targetId?: string;
  label?: string;
  /**
   * Which document group a purchase-request attachment joins — "quote" or "other".
   *
   * Sent only at FINALIZE. The signature has no use for it: what it authorises is an upload of a
   * given size, type and folder, none of which the group changes. Sending it there too would put a
   * value in the signed payload that nothing checks, which reads as a guarantee it isn't.
   *
   * Ignored by every other purpose, and validated as an enum on the server — the two upload areas
   * on screen are not what makes the category true. Typed rather than left as `string` so a typo is
   * a build failure here instead of a 400 the user discovers after the file has already uploaded.
   */
  documentType?: PrfDocumentType;
  /** 0–100. Real progress, which the old base64 round trip could not report. */
  onProgress?: (percent: number) => void;
  /**
   * Cancels the FILE TRANSFER, which is the part worth cancelling — the signature and finalize calls
   * either side of it are short JSON round trips, and `api()` takes no signal. A cancelled upload
   * leaves its pending-upload row behind for the server's reaper, exactly as a closed tab would.
   */
  signal?: AbortSignal;
}

/** What finalize returns: either the module's attachment DTO, or a URL for a form to hold. */
export type UploadResult = { attachment: unknown } | { url: string };

/**
 * Send the file where the envelope says, with the fields the envelope gave.
 *
 * XHR rather than fetch because it is still the only way to observe upload progress, and an engineer
 * sending a photo over a slow link needs to see that something is happening.
 *
 * Three rules, and all three are protocol rather than preference:
 *
 *   1. FIELDS VERBATIM. They are what the signature covers, so this forwards them untouched and in
 *      the order given. It does not add, rename, reorder or re-stringify any of them.
 *   2. FILE LAST. An S3 POST policy requires the file to be the final multipart part; Cloudinary
 *      does not care, so last is correct for both. (This used to append it first.)
 *   3. SUCCESS IS THE STATUS, NOT THE BODY. A presigned POST answers 204 with nothing in it. The
 *      body is parsed opportunistically and its absence is not a failure.
 */
export function postToStorage(
  envelope: UploadEnvelope,
  file: File,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<UploadReceipt> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    // Rule 1 — exactly what the server sent, in its own order.
    for (const [name, value] of Object.entries(envelope.fields)) form.append(name, value);
    // Rule 2 — after every field, always.
    form.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open(envelope.method, envelope.url);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // Rule 3 — a 2xx IS the success. A body is a bonus: Cloudinary sends a signed JSON receipt,
        // S3 sends nothing at all, and neither is required for the upload to have worked.
        resolve(readReceipt(xhr.responseText));
      } else {
        // A provider usually puts a readable reason in the body; surfacing it beats a bare status.
        reject(new Error(errorMessage(xhr.status, xhr.responseText)));
      }
    };
    xhr.onerror = () => reject(new Error("Could not reach the upload service."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

/** Whatever the provider said about the stored object, if it said anything. Never throws. */
function readReceipt(body: string): UploadReceipt {
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body) as { public_id?: string; version?: number; signature?: string };
    return { publicId: parsed.public_id, version: parsed.version, signature: parsed.signature };
  } catch {
    // Not JSON — an S3 XML acknowledgement, or an empty-ish body. The status already said it worked.
    return {};
  }
}

/** The most useful thing that can be said about a failed upload, without assuming a body shape. */
function errorMessage(status: number, body: string): string {
  try {
    // Cloudinary's shape. Anything else falls through to the status, which is always true.
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    /* keep the status-code message */
  }
  return `Upload failed (${status}).`;
}

/**
 * Sign, upload, finalize.
 *
 * If the browser dies between the upload and the finalize, the asset is left with the provider and a
 * pending-upload row against it, and the server's reaper destroys it a day later — through that same
 * provider, which is why the row records which one signed it. That is why there is
 * no cleanup call here: this side cannot be relied on to run one.
 */
export async function uploadDirect(opts: UploadOptions): Promise<UploadResult> {
  // Downscale FIRST, so every value below describes the file that is actually going to be sent.
  //
  // This sits here rather than in each picker because it is the one place every direct upload passes
  // through, and getting it wrong is invisible: a picker that forgot to shrink would still work, just
  // slowly and at 20× the storage, and nobody would notice until the storage bill. `shrinkImage`
  // returns documents untouched, so the document pickers are safe to route through it — a PDF is not
  // an image and never reaches a canvas.
  //
  // The ORDER matters. `sizeBytes` is what the server signs the size cap against, and `mediaTypeFor`
  // reads the extension, which a PNG→JPEG re-encode changes. Shrinking after either one would sign a
  // cap for a file that no longer exists and declare a type the bytes contradict — and finalize now
  // rejects a media type whose resource type disagrees with the signature's.
  const file = await shrinkImage(opts.file);

  const signed = await api<UploadEnvelope>("/uploads/signature", {
    method: "POST",
    body: {
      purpose: opts.purpose,
      fileName: file.name,
      sizeBytes: file.size,
      // Same derivation at BOTH ends, and that is now load-bearing: finalize rejects a media type
      // whose resource type disagrees with the one the signature was minted for.
      mediaType: mediaTypeFor(file),
      ...(opts.targetId ? { targetId: opts.targetId } : {}),
      // Sent at signature time too, so a rejected label (the reserved issued-PO archive name) fails
      // the user in the picker rather than after the file has already been uploaded.
      ...(opts.label ? { label: opts.label } : {}),
    },
  });

  const receipt = await postToStorage(signed, file, opts.onProgress, opts.signal);

  return api<UploadResult>("/uploads/finalize", {
    method: "POST",
    body: {
      purpose: opts.purpose,
      // The provider's own echo when it gave one — Cloudinary may normalise the id it stored, and
      // that normalised value is the one the ledger has to be matched on. Otherwise the key the
      // server already minted and put in the envelope, which is what a 204 leaves us with.
      publicId: receipt.publicId ?? signed.publicId,
      // Forwarded only when the provider issued them. Its adapter decides whether they are required.
      ...(receipt.version !== undefined ? { version: receipt.version } : {}),
      ...(receipt.signature ? { signature: receipt.signature } : {}),
      fileName: file.name,
      // Same derivation at BOTH ends, and that is now load-bearing: finalize rejects a media type
      // whose resource type disagrees with the one the signature was minted for.
      mediaType: mediaTypeFor(file),
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.documentType ? { documentType: opts.documentType } : {}),
      ...(opts.targetId ? { targetId: opts.targetId } : {}),
    },
  });
}

/** Convenience for the pickers that only need the stored URL back. */
export async function uploadDirectForUrl(opts: UploadOptions): Promise<string> {
  const result = await uploadDirect(opts);
  if ("url" in result) return result.url;
  throw new Error("That upload was attached rather than returned.");
}
