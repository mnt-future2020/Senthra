import { randomUUID } from "node:crypto";

import {
  fetchFirstBytes,
  signUploadParams,
  signedDeliveryUrl,
  verifyUploadResponse,
  destroyFromCloudinary,
  type CloudinaryCreds,
  type SignedUploadParams,
} from "../../lib/cloudinary.js";
import { env } from "../../config/env.js";
import { withTransaction } from "../../lib/prisma.js";
import { badRequest, conflict, forbidden } from "../../utils/http-error.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { ALL_PERMISSIONS } from "#modules/role/permissions.js";

import * as pendingRepo from "./upload.repository.js";
import {
  CONTENT_PROBE_BYTES,
  CONTENT_SIGNATURES,
  UPLOAD_PURPOSES,
  isUploadPurpose,
  resourceTypeFor,
  type UploadPurposeKey,
} from "./upload.catalog.js";

/**
 * Direct browser upload — the two halves the backend still owns.
 *
 * The file itself no longer passes through this process, so what is left here is the pair of decisions
 * that were always the important ones: WHO may upload (signature) and WHETHER what arrived is what was
 * promised (finalize). Everything in between is Cloudinary's problem, which is the point — the bytes,
 * the bandwidth and the memory go with it.
 */

// How long a finalize may hold a row before the reaper is allowed to consider it abandoned. Two
// orders of magnitude above the ~1–2s of work finalize actually does, so a slow network cannot
// expire a lease mid-flight; short enough that a crashed process frees its row the same minute.
const LEASE_MS = 5 * 60 * 1000;

/** Cloudinary rejects a stale signature. Short, because the browser uploads immediately. */
export const SIGNATURE_TTL_SECONDS = 120;

// The `fileType` the attachment tables store, from the media type the browser declared. Kept here
// rather than in the modules so one upload contract does not drift from another's vocabulary.
const FILE_TYPE_BY_MEDIA: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * The asset's name: the user's own file name, sanitised, with a UUID after it.
 *
 * The UUID is what makes it unique — the name in front is purely so a human can read the delivery URL,
 * and so the screens that show an attachment can put the ORIGINAL name back. `Job.attachments` stores
 * nothing but the URL, so that name is the only record of what the user picked; without it every job
 * attachment displays as a bare `9096674d-….pdf`, which is what happened the first time this ran.
 *
 * Sanitised to `[a-z0-9_-]` for the same reason the old server-side path did: a public id is a PATH,
 * and a `/` in a file name would move the asset out of the folder the signature committed to.
 */
function publicIdBase(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^/.]+$/, "").trim();
  const safe = withoutExt.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return safe ? `${safe}-${randomUUID()}` : randomUUID();
}

function assertPermitted(purpose: UploadPurposeKey, actor?: AuditActor): void {
  const spec = UPLOAD_PURPOSES[purpose];
  const held = new Set(actor?.permissions ?? []);
  if (held.has(ALL_PERMISSIONS)) return;
  const ok = spec.anyPermission
    ? spec.permissions.some((p) => held.has(p))
    : spec.permissions.every((p) => held.has(p));
  if (!ok) throw forbidden("You don't have permission to upload here.");
}

async function requireCreds(): Promise<CloudinaryCreds> {
  const creds = await getCloudinaryCreds();
  if (!creds) throw badRequest("File uploads aren't configured. Add Cloudinary credentials in Settings first.");
  return creds;
}

// ── Signature ──────────────────────────────────────────────────────────────────────────────────

export interface SignatureInput {
  purpose: string;
  fileName: string;
  sizeBytes: number;
  mediaType: string;
}

export interface SignatureResult extends SignedUploadParams {
  /** Echoed so the caller knows what finalize will expect; not a value the client may change. */
  purpose: UploadPurposeKey;
}

/**
 * Authorise one upload and mint the asset's identity.
 *
 * The size and media type the browser reports here are CLAIMS, used only to fail early and to pick the
 * resource type. Neither is trusted: the signed preset caps the real size at Cloudinary, and finalize
 * checks the content. What this call actually decides — the folder, the public id, the resource type —
 * is signed, so the browser cannot alter any of it without the upload being rejected.
 *
 * `preCheck` is the module's own guard (record editable, count and byte caps). Running it here is a
 * courtesy: it fails the user before a 10 MB upload rather than after. Finalize runs the authoritative
 * one, because the record can change while the file is in flight.
 */
/**
 * Which account-side preset this upload is signed against.
 *
 * Split by resource type because that is exactly how the two allowlists differ — an image may be a
 * png/jpg/gif/webp, a raw file may be a pdf/docx — and `resourceTypeFor` has already derived it from
 * the declared media type. The names live in config, never here, so a rename or a per-environment
 * account is a variable change.
 *
 * Signed, so the browser cannot swap it for a looser preset: Cloudinary rebuilds the signature from
 * the `upload_preset` it receives, and any other value fails the check. Blank means sign without one.
 */
function uploadPresetFor(resourceType: "image" | "raw"): string | undefined {
  const name = resourceType === "image" ? env.CLOUDINARY_UPLOAD_PRESET_IMAGE : env.CLOUDINARY_UPLOAD_PRESET_RAW;
  return name.trim() || undefined;
}

export async function createSignature(
  input: SignatureInput,
  actor: AuditActor | undefined,
  preCheck?: () => Promise<void>,
): Promise<SignatureResult> {
  if (!isUploadPurpose(input.purpose)) throw badRequest("Unknown upload type.");
  const purpose = input.purpose;
  const spec = UPLOAD_PURPOSES[purpose];

  assertPermitted(purpose, actor);
  if (!actor?.id) throw forbidden("Sign in to upload.");

  const mediaType = input.mediaType.toLowerCase();
  if (!spec.mediaTypes.includes(mediaType)) {
    throw badRequest("That file type isn't accepted here.");
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) throw badRequest("Upload a valid file.");
  if (input.sizeBytes > spec.maxBytes) {
    throw badRequest(`File must be ${Math.floor(spec.maxBytes / (1024 * 1024))} MB or smaller.`);
  }

  await preCheck?.();

  const creds = await requireCreds();
  const resourceType = resourceTypeFor(mediaType);
  // Server-minted. The browser never proposes a public id, which is what stops it finalizing an asset
  // it did not upload — see the PendingUpload comment in schema.prisma.
  //
  // A raw asset is served at exactly its public id, so the extension has to be part of it or the
  // delivery URL ends in a bare UUID and the browser downloads an extensionless blob. Same rule the
  // old server-side path used.
  const ext = resourceType === "raw" ? FILE_TYPE_BY_MEDIA[mediaType] : null;
  const publicId = ext ? `${publicIdBase(input.fileName)}.${ext}` : publicIdBase(input.fileName);

  const signed = signUploadParams(
    { folder: spec.folder, publicId, resourceType, uploadPreset: uploadPresetFor(resourceType) },
    creds,
  );

  await pendingRepo.create({ publicId: `${spec.folder}/${publicId}`, resourceType, purpose, actorId: actor.id });

  return { ...signed, purpose };
}

// ── Finalize ───────────────────────────────────────────────────────────────────────────────────

export interface FinalizeInput {
  /** The FULL public id Cloudinary returned, folder included. */
  publicId: string;
  version: number | string;
  signature: string;
  purpose: string;
  fileName: string;
  mediaType: string;
}

export interface VerifiedAsset {
  url: string;
  publicId: string;
  resourceType: string;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  /**
   * The lease this verification holds on the ledger row. `commitAttachment` presents it to prove the
   * row is still the one that was validated — carrying it is what lets the write re-assert the lease
   * without competing with itself.
   */
  lease: Date;
}

/**
 * Turn a completed browser upload into an asset this app is willing to reference.
 *
 * Order matters and is not incidental:
 *
 *   1. the caller's own authorization runs FIRST, in the controller, before anything is looked up —
 *      so no response can describe a record the caller may not see;
 *   2. the PendingUpload row proves the asset is ours to attach. Cloudinary's response signature
 *      proves the asset is REAL and in our cloud, which is a different and weaker statement: every
 *      asset in the account would satisfy it, including another customer's;
 *   3. the lease is taken before any work, so the reaper cannot destroy the asset underneath us;
 *   4. a `raw` upload has its first bytes read, because that is the only check on its contents.
 *
 * Returns the verified identity. What happens to it — an attachment row, or a URL handed back to a
 * form — belongs to the module, not here.
 */
export async function verifyFinalize(input: FinalizeInput, actor: AuditActor | undefined): Promise<VerifiedAsset> {
  if (!isUploadPurpose(input.purpose)) throw badRequest("Unknown upload type.");
  const purpose = input.purpose;
  const spec = UPLOAD_PURPOSES[purpose];
  assertPermitted(purpose, actor);
  if (!actor?.id) throw forbidden("Sign in to upload.");

  const pending = await pendingRepo.findByPublicId(input.publicId);
  // No row means: never authorised by us, already finalized, or already reaped. All three are the same
  // answer to the caller, and distinguishing them would turn this into an oracle for probing public ids.
  if (!pending) throw conflict("That upload is no longer available. Please attach the file again.");
  if (pending.actorId !== actor.id) throw conflict("That upload is no longer available. Please attach the file again.");
  if (pending.purpose !== purpose) throw badRequest("That upload was authorised for something else.");

  // Take the lease before doing any work, so a reaper running concurrently cannot destroy the asset
  // between validation and attachment. The expiry it returns travels on the VerifiedAsset — the write
  // needs it to re-assert this same lease rather than contend for a new one.
  const lease = await pendingRepo.claim(input.publicId, LEASE_MS);
  if (!lease) throw conflict("That upload is already being processed. Try again in a moment.");

  const creds = await requireCreds();
  if (!verifyUploadResponse(input.publicId, input.version, input.signature, creds)) {
    throw badRequest("That upload could not be verified.");
  }

  const mediaType = input.mediaType.toLowerCase();
  if (!spec.mediaTypes.includes(mediaType)) throw badRequest("That file type isn't accepted here.");

  // The type declared HERE must agree with the one the signature was minted for. Both checks are
  // needed, and neither implies the other: the allowlist above says "a PRF may carry a PNG", this
  // says "and this particular asset was signed as one".
  //
  // Without it the two halves of the content check come apart. `mediaType` is re-declared at
  // finalize and only ever compared against the purpose, so: sign as `application/pdf` (which is a
  // `raw` upload, stored opaquely and checked by nobody), post arbitrary bytes, then finalize
  // declaring `image/png`. The purpose allows PNG, so the line above passes; the magic-byte pass
  // below runs — the row still says `raw` — but has no signature entry for an image and returns
  // silently. The file is attached with nothing having looked inside it.
  //
  // Tying the declaration back to the resource type that was actually signed closes it at the
  // source: a `raw` row can now only be finalized as PDF or DOCX, and those are exactly the two
  // types CONTENT_SIGNATURES covers.
  if (resourceTypeFor(mediaType) !== pending.resourceType) {
    throw badRequest("That upload was authorised for a different file type.");
  }

  const url = signedDeliveryUrl(input.publicId, pending.resourceType, creds);

  // Cloudinary decodes an `image` on the way in and refuses what it cannot read, so its own acceptance
  // IS the content check for photos. It stores a `raw` asset opaquely, so a PDF or DOCX has been
  // checked by nobody until here.
  if (pending.resourceType === "raw") {
    await assertContentMatches(url, mediaType);
  }

  const size = await measure(url);
  if (size > spec.maxBytes) {
    // Refuse AND remove it: the file is already in storage, and leaving an oversize asset behind
    // because the row is about to be deleted would be the leak this whole design exists to avoid.
    await discard(input.publicId, pending.resourceType, creds);
    throw badRequest(`File must be ${Math.floor(spec.maxBytes / (1024 * 1024))} MB or smaller.`);
  }

  return {
    url,
    publicId: input.publicId,
    resourceType: pending.resourceType,
    fileName: input.fileName.trim().slice(0, 200) || "attachment",
    fileType: FILE_TYPE_BY_MEDIA[mediaType] ?? "png",
    fileSizeBytes: size,
    lease,
  };
}

/** The first bytes really are the format the caller declared. Raw uploads only — see the catalog. */
async function assertContentMatches(url: string, mediaType: string): Promise<void> {
  const spec = CONTENT_SIGNATURES.find((s) => s.mediaType === mediaType);
  // FAIL CLOSED. Every media type that reaches here as `raw` has an entry (verifyFinalize now
  // rejects a declaration whose resource type disagrees with the signed one, which leaves only PDF
  // and DOCX), so a miss means the catalog and this table have drifted apart — a new raw type added
  // without its magic bytes. Returning silently in that case is what made the bypass above possible
  // in the first place: it turns "I don't know how to check this" into "this passed".
  if (!spec) throw badRequest("That file type isn't accepted here.");

  let head: Buffer;
  try {
    head = await fetchFirstBytes(url, CONTENT_PROBE_BYTES);
  } catch (e) {
    // Could not read it back. Refuse rather than assume: an unreadable upload is not one to attach.
    throw badRequest(`Could not verify the uploaded file (${e instanceof Error ? e.message : "read failed"}).`);
  }

  const needle = Buffer.from(spec.bytes);
  const ok = spec.searchWindow
    ? head.subarray(0, spec.searchWindow).includes(needle)
    : head.subarray(0, needle.length).equals(needle);
  if (!ok) throw badRequest("That file isn't a valid PDF, DOCX, PNG or JPG.");
}

/**
 * The stored size, read from the asset rather than from what the browser claimed.
 *
 * The status is checked BEFORE the header is believed. A non-2xx response still carries a
 * `content-length` — of its own error body — so an unreadable asset used to measure as however many
 * bytes the CDN's "not found" page happens to be, and that tiny number then sailed through the size
 * cap this function exists to feed. The one reading that must never be accepted is a plausible-
 * looking size for a file we could not actually read.
 *
 * Timeout and abort for the same reason `fetchFirstBytes` has them: this runs inside a user's
 * request, and a delivery host that accepts the connection and then stalls would otherwise hold the
 * finalize open indefinitely.
 */
async function measure(url: string, timeoutMs = 10_000): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(url, { method: "HEAD", signal: controller.signal })
    .catch((e: unknown) => {
      // A refused, aborted or hung HEAD is not a size — refuse rather than fall through to a header
      // that isn't there.
      throw badRequest(`Could not verify the uploaded file (${e instanceof Error ? e.message : "read failed"}).`);
    })
    .finally(() => clearTimeout(timer));

  if (!res.ok) throw badRequest(`Could not verify the uploaded file (HTTP ${res.status}).`);
  const len = Number(res.headers.get("content-length"));
  if (!Number.isFinite(len) || len <= 0) throw badRequest("Could not verify the uploaded file.");
  return len;
}

async function discard(publicId: string, resourceType: string, creds: CloudinaryCreds): Promise<void> {
  await destroyFromCloudinary(publicId, resourceType, creds).catch((e: unknown) =>
    console.error(`[upload] could not discard ${resourceType}/${publicId}:`, e instanceof Error ? e.message : e),
  );
  await pendingRepo.remove(publicId);
}

/**
 * Commit an accepted upload: the module's write and the ledger row's removal, together.
 *
 * ONE TRANSACTION, and the lease is re-asserted inside it. Without that pairing there are two ways to
 * lose: a crash between the write and the removal leaves a row the reaper would later honour by
 * destroying a LIVE asset; and a lease that expired mid-flight would let the reaper act while this
 * write was still in progress. Renewing inside the transaction makes "still holds the lease" and
 * "wrote the attachment" the same commit.
 *
 * It RENEWS the verification's lease rather than claiming a fresh one. Claiming asks "is the lease
 * free?", and the answer here is always no — this caller is holding it — so every attach-mode upload
 * conflicted with itself and no PRF, PO or GRN document could be attached at all. The unit tests did
 * not catch it because they stubbed the claim to succeed, which is the one thing the real row cannot
 * do twice; the fake in the test file now enforces the real conditional-update semantics instead.
 */
export async function commitAttachment<T>(
  asset: Pick<VerifiedAsset, "publicId" | "lease">,
  write: (tx: Parameters<Parameters<typeof withTransaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  const publicId = asset.publicId;
  return withTransaction(async (tx) => {
    if (!(await pendingRepo.renew(publicId, asset.lease, LEASE_MS, tx))) {
      throw conflict("That upload is no longer available. Please attach the file again.");
    }
    const result = await write(tx);
    await pendingRepo.remove(publicId, tx);
    return result;
  });
}

/** Release the ledger row for an upload whose URL is handed back to a form (`return-url` purposes). */
export async function releasePending(publicId: string): Promise<void> {
  await pendingRepo.remove(publicId);
}
