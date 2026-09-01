import { api } from "./api";
import type { PrfDocumentType } from "@/types/purchase-request";
import { shrinkImage } from "./image";

// ── Direct browser upload ──────────────────────────────────────────────────────────────────────
//
// The file goes from this browser to Cloudinary and never through our backend. What the backend still
// decides is the part that matters — whether this user may upload here, and whether what arrived is
// what was promised — so the round trip is: ask for a signature, post the file, hand back what
// Cloudinary said.
//
// Whatever a caller checks before calling this — extension, size, `file.type` — is UX ONLY. It exists
// so a wrong file is refused in the picker rather than after a 10 MB upload, and none of it is
// trusted: the signature caps the size and the folder at Cloudinary, and the server reads a
// document's actual bytes before it will attach one.

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
const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

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

interface SignatureResponse {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  publicId: string;
  resourceType: "image" | "raw";
  uploadPreset?: string;
  uploadUrl: string;
  purpose: UploadPurpose;
}

interface CloudinaryUploadResponse {
  public_id: string;
  version: number;
  signature: string;
  secure_url: string;
  bytes: number;
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
 * Post the file straight to Cloudinary.
 *
 * XHR rather than fetch because it is still the only way to observe upload progress, and an engineer
 * sending a photo over a slow link needs to see that something is happening.
 */
function postToCloudinary(
  signed: SignatureResponse,
  file: File,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<CloudinaryUploadResponse> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("api_key", signed.apiKey);
    form.append("timestamp", String(signed.timestamp));
    form.append("signature", signed.signature);
    // Exactly the values the server signed. Changing any of them invalidates the signature, which is
    // what stops a client choosing its own folder or public id.
    form.append("folder", signed.folder);
    form.append("public_id", signed.publicId);
    form.append("overwrite", "false");
    // The server's preset, when it sent one. It is signed like the rest, so this cannot be dropped to
    // escape the account's format allowlist — leaving it out just fails the signature.
    if (signed.uploadPreset) form.append("upload_preset", signed.uploadPreset);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", signed.uploadUrl);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as CloudinaryUploadResponse);
        } catch {
          reject(new Error("The upload service returned something unexpected."));
        }
      } else {
        // Cloudinary puts a readable reason here; surfacing it beats a bare status code.
        let message = `Upload failed (${xhr.status}).`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: { message?: string } };
          if (body.error?.message) message = body.error.message;
        } catch {
          /* keep the status-code message */
        }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error("Could not reach the upload service."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

/**
 * Sign, upload, finalize.
 *
 * If the browser dies between the upload and the finalize, the asset is left in Cloudinary with a
 * pending-upload row against it, and the server's reaper destroys it a day later. That is why there is
 * no cleanup call here: this side cannot be relied on to run one.
 */
export async function uploadDirect(opts: UploadOptions): Promise<UploadResult> {
  // Downscale FIRST, so every value below describes the file that is actually going to be sent.
  //
  // This sits here rather than in each picker because it is the one place every direct upload passes
  // through, and getting it wrong is invisible: a picker that forgot to shrink would still work, just
  // slowly and at 20× the storage, and nobody would notice until the Cloudinary bill. `shrinkImage`
  // returns documents untouched, so the document pickers are safe to route through it — a PDF is not
  // an image and never reaches a canvas.
  //
  // The ORDER matters. `sizeBytes` is what the server signs the size cap against, and `mediaTypeFor`
  // reads the extension, which a PNG→JPEG re-encode changes. Shrinking after either one would sign a
  // cap for a file that no longer exists and declare a type the bytes contradict — and finalize now
  // rejects a media type whose resource type disagrees with the signature's.
  const file = await shrinkImage(opts.file);

  const signed = await api<SignatureResponse>("/uploads/signature", {
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
      // the user in the picker rather than after the file has already gone to Cloudinary.
      ...(opts.label ? { label: opts.label } : {}),
    },
  });

  const uploaded = await postToCloudinary(signed, file, opts.onProgress, opts.signal);

  return api<UploadResult>("/uploads/finalize", {
    method: "POST",
    body: {
      purpose: opts.purpose,
      publicId: uploaded.public_id,
      version: uploaded.version,
      signature: uploaded.signature,
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
