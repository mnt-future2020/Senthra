// ── The storage contract ───────────────────────────────────────────────────────────────────────
//
// One interface, two adapters (Cloudinary today, DigitalOcean Spaces next). It exists so the rest of
// the app can store, address and delete a file without naming a vendor — and, more importantly, so
// an asset can be addressed on the provider that ACTUALLY holds it rather than the one that happens
// to be selected now.
//
// DELIBERATELY NOT a generic filesystem abstraction. Every method below is here because a real call
// site needs it; nothing is added for symmetry. See
// docs/superpowers/plans/2026-09-21-storage-provider-abstraction.md.
//
// This file declares types only. It imports nothing, so both adapters and every consumer can depend
// on it without pulling in an SDK.

/** The providers this app can store files on. */
export type StorageProviderId = "cloudinary" | "spaces";

/**
 * Addresses ONE stored object.
 *
 * `provider` is nullable, and null MEANS "cloudinary". That is not a convenience — it is the whole
 * backward-compatibility story: every row written before multi-provider support has no provider
 * recorded, and reading null as Cloudinary makes all of them correct with no backfill and no
 * migration. Never "fix" a null by writing a value into old rows.
 *
 * `resourceType` is provider-scoped and OPAQUE to callers. Cloudinary uses it to pick a delivery
 * path ("image" | "raw") and needs it to address a destroy at all; Spaces has one flat namespace and
 * will store the constant "object". Nothing outside an adapter may interpret it.
 */
export interface AssetRef {
  provider: StorageProviderId | null;
  publicId: string;
  resourceType: string;
}

/** What an upload stored, as the provider itself reported it. */
export interface StoredAsset {
  url: string;
  publicId: string;
  resourceType: string;
  provider: StorageProviderId;
}

/**
 * How to store one file.
 *
 * `kind` maps ONE-TO-ONE onto the two upload transports this app already has, and the distinction is
 * load-bearing rather than cosmetic:
 *
 *   "image" — forced `resource_type: "image"`, `overwrite: true`, `invalidate: true`. Used by every
 *             call site that stores a picture: branding logo/favicon/po-logo, the user avatar and
 *             signature, the customer logo, engineer-transfer and van-stock photos.
 *   "file"  — resource type DERIVED from the data URI's MIME, no overwrite, and a raw asset's
 *             extension baked into its public id. Used by the archived issued-PO PDF, and by
 *             anything else that may not be an image.
 *
 * Collapsing the two would change behaviour: "file" on a PNG loses `invalidate`, and "image" on a
 * PDF lands it on Cloudinary's `/image/upload/` path, which most accounts block for PDFs.
 */
export interface UploadOptions {
  folder: string;
  kind: "image" | "file";
  /**
   * Whether this key is written once and never rewritten.
   *
   * false — the key is DETERMINISTIC and overwritten in place (`logo`, `favicon`, `po-logo`,
   *         `signature-<userId>`). A replacement lands on the same object.
   * true  — the key carries a UUID, so the object it names can never change.
   *
   * Cloudinary ignores this: it invalidates its own CDN copy on overwrite. It exists for providers
   * that must choose a Cache-Control header at WRITE time, where a long TTL on a deterministic key
   * would serve a replaced logo from the edge indefinitely.
   */
  immutable: boolean;
}

/**
 * What the browser must POST for a direct upload, in provider-neutral form.
 *
 * `fields` is posted VERBATIM and the file goes LAST. Both matter: the field names differ per
 * provider (Cloudinary signs `public_id`/`folder`/`timestamp`; an S3 POST policy signs `key`/
 * `policy`/`x-amz-*`), and an S3 POST requires the file to be the final multipart part.
 */
export interface SignedUpload {
  method: "POST";
  url: string;
  fields: Record<string, string>;
  /** The FULL key the server minted, folder included. Recorded on the PendingUpload row. */
  publicId: string;
  resourceType: string;
  provider: StorageProviderId;
}

/** Everything a signature commits to. Every value is chosen by the server, never by the client. */
export interface SignUploadSpec {
  folder: string;
  publicId: string;
  resourceType: string;
  mediaType: string;
  maxBytes: number;
}

/**
 * Evidence the browser reported after uploading.
 *
 * Cloudinary signs its upload response and this carries that signature. S3 answers a POST with 204
 * and no body, so a Spaces adapter receives nothing here and proves the object exists by reading it
 * back instead. Both fields are therefore optional at the type level — but an adapter that CAN
 * verify must still refuse when they are missing, or the optionality becomes a bypass.
 */
export interface UploadEvidence {
  version?: number | string;
  signature?: string;
}

/** What a stored object reports about itself. */
export interface HeadResult {
  sizeBytes: number;
  contentType: string | null;
}

/**
 * One storage backend.
 *
 * `destroy` is part of the contract, but reaching it is still governed by the one-entrance guard in
 * `modules/attachment/attachment.boundary.test.ts`: a domain service may not call it directly, only
 * `releaseAsset` (which counts references first) and the two ledger-backed upload paths may.
 * Widening that allowlist is a decision about the deletion guarantee, never a convenience.
 */
export interface StorageProvider {
  readonly id: StorageProviderId;
  /**
   * Does this provider DECODE an image as it arrives, and refuse what it cannot read?
   *
   * The one genuine capability difference between the two backends, and the reason it has to be
   * asked rather than assumed. Cloudinary decodes on ingest, so its acceptance IS the content check
   * for a photo. An object store keeps whatever bytes it is handed, so the same upload arrives
   * unexamined and the application has to look for itself.
   *
   * Read by finalize to decide whether a magic-byte pass is needed. It exists to avoid a SECOND,
   * pointless read against a provider that already did the work — not to make validation optional.
   */
  readonly validatesImagesOnIngest: boolean;
  /**
   * Can this provider RESIZE and RE-ENCODE an image at delivery time, from a URL?
   *
   * The second genuine capability difference. Cloudinary does — `f_png,fl_png32,h_400,c_limit` in a
   * delivery URL returns a rasterised, height-capped, 32-bit copy of whatever was stored, generated
   * on demand and cached by it. An object store returns the bytes it was given, so the same result
   * has to be produced once at upload time and stored as a separate object.
   *
   * Read by the upload paths that feed a PDF or an email, to decide whether a derivative needs
   * generating. Asking the capability rather than the provider's name is what keeps the next backend
   * correct without revisiting these call sites.
   */
  readonly transformsOnDelivery: boolean;
  upload(source: string, publicId: string, opts: UploadOptions): Promise<StoredAsset>;
  destroy(ref: AssetRef): Promise<void>;
  signUpload(spec: SignUploadSpec): SignedUpload | Promise<SignedUpload>;
  confirmUpload(ref: AssetRef, evidence: UploadEvidence): Promise<void>;

  /**
   * Move a VALIDATED upload out of reach of the ticket that created it, and say where it now lives.
   *
   * The problem this exists for: a browser upload is authorised by a signed permit the client holds,
   * and that permit stays valid for its whole lifetime — not until it has been used once. So between
   * finalize approving the bytes and the permit expiring, the client can post AGAIN to the same
   * destination and replace what was just approved. The URL does not change, the database row does
   * not change, and every check that just passed is now describing bytes that no longer exist.
   *
   * Cloudinary closes this itself: its signature carries `overwrite: false`, so the second attempt
   * is refused. An S3 POST policy has no equivalent condition — there is no "only if absent" — so
   * the adapter has to arrange it structurally instead: let the permit authorise a STAGING key, and
   * move the object to its real key once the bytes are approved. A replay then lands on a staging
   * object that nothing references and that the reaper will collect.
   *
   * Called ONCE, by finalize, after every content and size check has passed. Returns the ref the
   * attachment row should record — which is the SAME ref for a provider that needs no staging, so
   * this is an identity function on Cloudinary and changes nothing there.
   */
  promoteUpload(ref: AssetRef): Promise<AssetRef>;
  head(ref: AssetRef): Promise<HeadResult>;
  readRange(ref: AssetRef, byteCount: number): Promise<Buffer>;
  deliveryUrl(ref: AssetRef): string;
}
