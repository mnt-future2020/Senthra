import { v2 as cloudinary } from "cloudinary";

import { env } from "../../config/env.js";
import { badRequest } from "../../utils/http-error.js";

import type {
  AssetRef,
  HeadResult,
  SignUploadSpec,
  SignedUpload,
  StorageProvider,
  StoredAsset,
  UploadEvidence,
  UploadOptions,
} from "./types.js";

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
): Promise<CloudinaryImageAsset> {
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
  return { url: result.secure_url, publicId: result.public_id, resourceType: result.resource_type };
}

/**
 * What `uploadToCloudinary` stored. Same shape as CloudinaryAsset, declared separately only because
 * this helper is always `image` — callers that keep the identity are storing a constant `resourceType`,
 * and that is deliberate: it records what was true at WRITE time rather than leaving a later delete to
 * assume it.
 *
 * Most callers use `.url` and discard the rest, which is correct for them: a DETERMINISTIC public id
 * (branding's `logo`/`favicon`, `signature-${userId}`) is overwritten in place, so there is never an
 * older asset to clean up. The callers that pass a random id are the ones that must keep it.
 */
export interface CloudinaryImageAsset { url: string; publicId: string; resourceType: string; }

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

// ── Direct browser upload ──────────────────────────────────────────────────────────────────────
//
// The browser sends the file straight to Cloudinary, so the bytes never enter this process. What the
// backend keeps is the two decisions that matter: WHO may upload, and WHAT the upload is allowed to
// be. Both live in the signature — every parameter below is signed, so a client that edits any of
// them invalidates it and Cloudinary refuses the upload.
//
// The api_secret signs and never leaves the server.

/** Upload parameters the browser must post to Cloudinary verbatim, plus the signature over them. */
export interface SignedUploadParams {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  publicId: string;
  resourceType: "image" | "raw";
  /**
   * The preset the signature was computed over, when there is one. The browser MUST post it back
   * unchanged — it is a signed field, so omitting or editing it fails the signature check rather than
   * quietly uploading without the account-side format allowlist.
   */
  uploadPreset?: string;
  /** Echoed back so the caller can hand it to finalize; not part of the signature. */
  uploadUrl: string;
}

/**
 * Sign one upload. Every value here is chosen by the CALLER (the upload service), never by the client.
 *
 * `overwrite: false` is load-bearing. With a direct upload the browser holds a valid signature for a
 * short window, and without this it could replay that signature to replace the asset it already
 * uploaded — after finalize had validated the original. The second upload fails instead.
 */
export function signUploadParams(
  args: { folder: string; publicId: string; resourceType: "image" | "raw"; uploadPreset?: string },
  creds: CloudinaryCreds,
): SignedUploadParams {
  const timestamp = Math.floor(Date.now() / 1000);
  // Only these keys are signed, and Cloudinary rebuilds the same string from what the browser posts —
  // so an edited folder or public_id produces a different string and a failed signature check.
  const toSign: Record<string, string | number | boolean> = {
    folder: args.folder,
    public_id: args.publicId,
    overwrite: false,
    timestamp,
    ...(args.uploadPreset ? { upload_preset: args.uploadPreset } : {}),
  };
  const signature = cloudinary.utils.api_sign_request(toSign, creds.apiSecret);
  return {
    cloudName: creds.cloudName,
    apiKey: creds.apiKey,
    timestamp,
    signature,
    folder: args.folder,
    publicId: args.publicId,
    resourceType: args.resourceType,
    ...(args.uploadPreset ? { uploadPreset: args.uploadPreset } : {}),
    uploadUrl: `https://api.cloudinary.com/v1_1/${creds.cloudName}/${args.resourceType}/upload`,
  };
}

/**
 * Is this upload response really from Cloudinary, unedited?
 *
 * Cloudinary signs its own upload response, and the payload is `public_id=<id>&version=<v>` — those
 * TWO FIELDS ONLY. So this proves the named asset exists in our cloud at that version. It proves
 * NOTHING about the `bytes`, `format` or `resource_type` the browser also reported, because those are
 * not covered, and it does not prove the asset is ours to attach — any real asset in the cloud would
 * verify. Ownership is decided by the PendingUpload row; size and content are decided separately.
 */
export function verifyUploadResponse(publicId: string, version: number | string, signature: string, creds: CloudinaryCreds): boolean {
  const expected = cloudinary.utils.api_sign_request({ public_id: publicId, version }, creds.apiSecret);
  // Length-independent comparison is unnecessary here — both sides are hex digests of public values,
  // and a mismatch is a rejected upload, not a leaked secret.
  return expected === signature;
}

/**
 * A delivery URL this server can fetch, whatever the asset's delivery type.
 *
 * `sign_url` makes it work for `authenticated` assets as well as public ones, which is what lets
 * finalize inspect a document's first bytes WITHOUT the document having to be publicly reachable.
 * Authenticated delivery for customer documents is a separate piece of work; signing here means this
 * code does not have to change when that lands.
 */
export function signedDeliveryUrl(publicId: string, resourceType: string, creds: CloudinaryCreds, type = "upload"): string {
  cloudinary.config({ cloud_name: creds.cloudName, api_key: creds.apiKey, api_secret: creds.apiSecret, secure: true });
  return cloudinary.url(publicId, { resource_type: resourceType, type, sign_url: true, secure: true });
}

/**
 * The first bytes of a stored asset, for magic-byte validation.
 *
 * A RANGE request, so a 10 MB document costs about a kilobyte to check. This is a CDN fetch, NOT an
 * Admin API call — the Admin API is rate-limited (500/hour on the free plan, from 2000 on paid) and
 * putting a call to it in every upload would cap the whole system at that number. The Upload API and
 * delivery are not rate-limited.
 *
 * Needed because Cloudinary does not look inside a `raw` asset: it stores the bytes opaquely, so its
 * `allowed_formats` restriction and the `format` it reports both come from the extension in the
 * public_id. For a PDF or DOCX that is a label, not a fact, and this is the only thing that checks it.
 */
export async function fetchFirstBytes(url: string, byteCount: number, timeoutMs = 10_000): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Range: `bytes=0-${byteCount - 1}` }, signal: controller.signal });
    // 206 is the range hit; 200 means the CDN ignored the header and sent the whole file, which is
    // still usable — we only read the head of it.
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`Could not read the uploaded file (HTTP ${res.status}).`);
    }
    return Buffer.from(await res.arrayBuffer()).subarray(0, byteCount);
  } finally {
    clearTimeout(timer);
  }
}

// ── The storage-contract adapter ───────────────────────────────────────────────────────────────
//
// Everything above is the TRANSPORT: the Cloudinary SDK calls and the decisions that go with them,
// unchanged from when they lived in `lib/cloudinary.ts`. Everything below adapts that transport to
// the vendor-neutral `StorageProvider` contract, so the rest of the app can address a stored file
// without naming Cloudinary.
//
// The split matters. The adapter makes NO decisions of its own — it chooses which transport function
// to call and reshapes arguments. The moment it starts deciding things (a resource type, an
// overwrite rule, a folder) it becomes a second Cloudinary client that can drift from the first.

/** How long to wait on a delivery request before giving up. Matches `fetchFirstBytes`. */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Which account-side preset an upload is signed against.
 *
 * Cloudinary-specific, so it is resolved HERE rather than carried on the neutral `SignUploadSpec` —
 * a preset is the one part of a direct upload Cloudinary can refuse at its own edge, and no other
 * provider has the concept. Split by resource type because that is exactly how the two allowlists
 * differ. Blank means sign without one, which is the pre-preset behaviour.
 */
function uploadPresetFor(resourceType: "image" | "raw"): string | undefined {
  const name = resourceType === "image" ? env.CLOUDINARY_UPLOAD_PRESET_IMAGE : env.CLOUDINARY_UPLOAD_PRESET_RAW;
  return name.trim() || undefined;
}

/**
 * The Cloudinary adapter.
 *
 * Credentials are passed IN rather than resolved here, exactly as the transport above does — so this
 * stays a pure transport with no config source of its own, and a caller cannot accidentally get a
 * provider built from credentials it did not intend.
 */
export function createCloudinaryProvider(creds: CloudinaryCreds): StorageProvider {
  const urlFor = (r: AssetRef) => signedDeliveryUrl(r.publicId, r.resourceType, creds);

  return {
    id: "cloudinary",

    /**
     * TRUE, and it is not a formality: Cloudinary decodes an `image` upload and rejects anything it
     * cannot read, which is why no magic-byte pass has ever run for photos on this provider. Reading
     * the bytes back here would cost a request per upload to re-establish something already proven.
     */
    validatesImagesOnIngest: true,

    /**
     * TRUE. Transformations are URL parameters, computed on demand and cached by Cloudinary — which
     * is why no derivative is ever stored for a Cloudinary asset and `logoPdfUrl` stays null for one.
     */
    transformsOnDelivery: true,

    /**
     * Store a file from a data URI.
     *
     * The two branches are the two transports above, and which one runs is decided by `kind` rather
     * than inferred — see UploadOptions for why collapsing them changes behaviour. `immutable` is
     * NOT consulted: Cloudinary invalidates its own CDN copy when it overwrites, so a cache policy
     * chosen at write time has nothing to decide here.
     */
    async upload(source: string, publicId: string, opts: UploadOptions): Promise<StoredAsset> {
      const asset =
        opts.kind === "image"
          ? await uploadToCloudinary(source, publicId, creds, opts.folder)
          : await uploadFileToCloudinary(source, publicId, creds, opts.folder);
      return { ...asset, provider: "cloudinary" };
    },

    /**
     * Delete one stored asset. BEST-EFFORT CLEANUP — see the transport's own contract above, which
     * this does not widen: an already-missing asset is still a success, and a caller must still have
     * committed the database change that removed the last reference before calling it.
     */
    destroy(r: AssetRef): Promise<void> {
      return destroyFromCloudinary(r.publicId, r.resourceType, creds);
    },

    /** Authorise one direct browser upload, reshaped into the neutral envelope. */
    signUpload(spec: SignUploadSpec): SignedUpload {
      // The resource type is Cloudinary's own vocabulary and the transport signs against it, so it
      // is narrowed here rather than widened there.
      const resourceType = spec.resourceType === "raw" ? "raw" : "image";
      const uploadPreset = uploadPresetFor(resourceType);
      const signed = signUploadParams(
        { folder: spec.folder, publicId: spec.publicId, resourceType, ...(uploadPreset ? { uploadPreset } : {}) },
        creds,
      );

      // EXACTLY the fields the browser posts today, with the same names and the same values — see
      // frontend/src/lib/upload.ts. Cloudinary rebuilds its signature from what it receives, so a
      // renamed or dropped field is a failed upload, not a cosmetic difference.
      const fields: Record<string, string> = {
        api_key: signed.apiKey,
        timestamp: String(signed.timestamp),
        signature: signed.signature,
        folder: signed.folder,
        public_id: signed.publicId,
        overwrite: "false",
      };
      if (signed.uploadPreset) fields.upload_preset = signed.uploadPreset;

      return {
        method: "POST",
        url: signed.uploadUrl,
        fields,
        // The full key, folder included — the form the PendingUpload ledger is keyed by.
        publicId: `${signed.folder}/${signed.publicId}`,
        resourceType,
        provider: "cloudinary",
      };
    },

    /**
     * Is this really the asset we authorised, unedited?
     *
     * Cloudinary signs its upload response, so the check is real here and MUST refuse when the
     * evidence is absent. `UploadEvidence` makes both fields optional because a provider with no
     * signed response has nothing to put in them — if that optionality were allowed to mean "skip
     * the check" for Cloudinary too, it would be a bypass rather than a shared type.
     */
    /**
     * Identity. Cloudinary signs `overwrite: false`, so the permit it issues can be used exactly
     * once — the asset is already beyond the reach of a replay the moment it is stored, and there
     * is no staging key to move it out of.
     */
    promoteUpload(ref: AssetRef): Promise<AssetRef> {
      return Promise.resolve(ref);
    },

    async confirmUpload(r: AssetRef, evidence: UploadEvidence): Promise<void> {
      if (evidence.version === undefined || !evidence.signature) {
        throw badRequest("That upload could not be verified.");
      }
      if (!verifyUploadResponse(r.publicId, evidence.version, evidence.signature, creds)) {
        throw badRequest("That upload could not be verified.");
      }
    },

    /**
     * The stored size, read from the asset rather than from what the browser claimed.
     *
     * The status is checked BEFORE the header is believed. A non-2xx response still carries a
     * `content-length` — of its own error body — so an unreadable asset would otherwise measure as
     * however many bytes the CDN's "not found" page happens to be, and that tiny number would sail
     * through the size cap this exists to feed.
     */
    async head(r: AssetRef): Promise<HeadResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
      const res = await fetch(urlFor(r), { method: "HEAD", signal: controller.signal })
        .catch((e: unknown) => {
          // A refused, aborted or hung HEAD is not a size — refuse rather than fall through to a
          // header that isn't there.
          throw badRequest(`Could not verify the uploaded file (${e instanceof Error ? e.message : "read failed"}).`);
        })
        .finally(() => clearTimeout(timer));

      if (!res.ok) throw badRequest(`Could not verify the uploaded file (HTTP ${res.status}).`);
      const len = Number(res.headers.get("content-length"));
      if (!Number.isFinite(len) || len <= 0) throw badRequest("Could not verify the uploaded file.");
      return { sizeBytes: len, contentType: res.headers.get("content-type") };
    },

    /** The first bytes of a stored asset, for magic-byte validation. A cheap ranged CDN read. */
    readRange(r: AssetRef, byteCount: number): Promise<Buffer> {
      return fetchFirstBytes(urlFor(r), byteCount);
    },

    /** A delivery URL this server can fetch, whatever the asset's delivery type. */
    deliveryUrl(r: AssetRef): string {
      return urlFor(r);
    },
  };
}
