import { api } from "./api";

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
  | "kit_request_attachment"
  | "transfer_attachment";

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
  const signed = await api<SignatureResponse>("/uploads/signature", {
    method: "POST",
    body: {
      purpose: opts.purpose,
      fileName: opts.file.name,
      sizeBytes: opts.file.size,
      // Same derivation at BOTH ends, and that is now load-bearing: finalize rejects a media type
      // whose resource type disagrees with the one the signature was minted for.
      mediaType: mediaTypeFor(opts.file),
      ...(opts.targetId ? { targetId: opts.targetId } : {}),
      // Sent at signature time too, so a rejected label (the reserved issued-PO archive name) fails
      // the user in the picker rather than after the file has already gone to Cloudinary.
      ...(opts.label ? { label: opts.label } : {}),
    },
  });

  const uploaded = await postToCloudinary(signed, opts.file, opts.onProgress, opts.signal);

  return api<UploadResult>("/uploads/finalize", {
    method: "POST",
    body: {
      purpose: opts.purpose,
      publicId: uploaded.public_id,
      version: uploaded.version,
      signature: uploaded.signature,
      fileName: opts.file.name,
      // Same derivation at BOTH ends, and that is now load-bearing: finalize rejects a media type
      // whose resource type disagrees with the one the signature was minted for.
      mediaType: mediaTypeFor(opts.file),
      ...(opts.label ? { label: opts.label } : {}),
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
