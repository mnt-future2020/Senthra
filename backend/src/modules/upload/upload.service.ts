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
  CSV_HEADER_GUARDS,
  isTextByte,
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
  "text/csv": "csv",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * An IMAGE asset's name: the user's own file name, sanitised, with a UUID after it.
 *
 * The UUID is what makes it unique — the name in front is purely so a human can read the delivery URL,
 * and so the screens that show an attachment can put the ORIGINAL name back. `Job.attachments` stores
 * nothing but the URL, so that name is the only record of what the user picked; without it every job
 * attachment displays as a bare `9096674d-….pdf`, which is what happened the first time this ran.
 *
 * Sanitised to `[a-z0-9_-]` for the same reason the old server-side path did: a public id is a PATH,
 * and a `/` in a file name would move the asset out of the folder the signature committed to.
 *
 * DELIBERATELY not the document shape below. An image is previewed inline and never saved under this
 * name, so the leaf-name problem that shape solves does not exist here — and its delivery URL carries
 * no extension, because Cloudinary derives an image's format itself. Changing it would put every
 * avatar, logo and evidence photo at risk to buy nothing.
 */
function imagePublicId(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^/.]+$/, "").trim();
  const safe = withoutExt.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return safe ? `${safe}-${randomUUID()}` : randomUUID();
}

/**
 * A RAW document's name: `<uuid>/<the user's own file name>`.
 *
 * Cloudinary sends NO `Content-Disposition` header, so a browser saving a document names it after the
 * LAST PATH SEGMENT of the delivery URL — which for a raw asset is its public id verbatim. With the
 * uuid in the name, `Finance_Report_2026-08-26.xlsx` reached the user's Downloads folder as
 * `finance_report_2026-08-26-d817abf6-4988-….xlsx`.
 *
 * So the uuid becomes a FOLDER. It still carries the whole of the uniqueness — two people uploading
 * the same name land in different directories — while the segment the user actually reads is theirs.
 *
 * Chosen over Cloudinary's `fl_attachment:<name>` flag, which would name the download correctly and
 * also force `Content-Disposition: attachment` on everything: PDFs would stop opening in the browser's
 * viewer. This costs no behaviour change at all.
 */
function documentPublicId(fileName: string, extension: string): string {
  return `${randomUUID()}/${safeLeafName(fileName)}.${extension}`;
}

/**
 * The user's file name, reduced to something safe to be the last segment of a signed delivery URL.
 *
 * THE INVARIANT: the result can never introduce a path separator or climb out of the uuid folder.
 * A public id is a path, and the signature commits to whatever this returns — a name that smuggled in
 * a `/` would move the asset to a directory of the uploader's choosing, and one that climbed with `..`
 * would leave the uuid folder that is the only thing making the id unique.
 *
 * Everything outside `[A-Za-z0-9._-]` folds to a hyphen rather than being dropped, so the words of a
 * name stay apart: `PO-0064 (2)` reads as `PO-0064-2`, not `PO00642`. That fold is deliberately wider
 * than "the dangerous characters" — a comma is Cloudinary's own transformation separator, and a
 * non-Latin name would have to survive URL-encoding on a path the signature was computed over. The
 * old sanitiser dropped these too (it allowed even less), so nothing that used to work stops working.
 *
 * Case and interior dots are the two things it now KEEPS. Both were casualties of an id nobody was
 * meant to read: `Quarterly_Report` came back as `quarterly_report`, and `invoice.final.v2` lost the
 * versioning half the world puts in a document name.
 */
function safeLeafName(fileName: string): string {
  const leaf = fileName
    .replace(/\.[^/.]+$/, "") // the real extension is re-appended by the caller, from the media type
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    // `..` cannot survive in any form — not as a segment, not buried inside one.
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60)
    // The slice can cut through a separator and leave the name ending on one.
    .replace(/[-.]+$/, "");
  // Nothing survived — a name of only spaces, or written in a script we fold away. The uuid folder
  // already holds the uniqueness, so the leaf only has to be legible.
  return leaf || "file";
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
  //
  // The two shapes differ, and the difference is the point — see `documentPublicId` / `imagePublicId`.
  // The `ext` fallback is not reachable through a validated media type (every raw type has an entry
  // above), but a raw asset with no extension is the one outcome worth never producing by accident.
  const ext = resourceType === "raw" ? FILE_TYPE_BY_MEDIA[mediaType] : null;
  const publicId = ext ? documentPublicId(input.fileName, ext) : imagePublicId(input.fileName);

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
  // source: a `raw` row can only be finalized as one of the raw document types — PDF, DOCX, XLSX,
  // XLS or CSV — and CONTENT_SIGNATURES covers every one of them, so there is no raw media type
  // that reaches the pass below without an entry waiting for it. (A catalog test enforces that
  // coverage, which is what keeps this sentence true as the policy widens: CSV is checked by
  // exclusion rather than by a magic number, but it is checked.)
  if (resourceTypeFor(mediaType) !== pending.resourceType) {
    throw badRequest("That upload was authorised for a different file type.");
  }

  const url = signedDeliveryUrl(input.publicId, pending.resourceType, creds);

  // Cloudinary decodes an `image` on the way in and refuses what it cannot read, so its own acceptance
  // IS the content check for photos. It stores a `raw` asset opaquely, so a document — PDF, DOCX,
  // XLSX, XLS or CSV — has been checked by nobody until here.
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

  // A format with no signature of its own (CSV) is checked by exclusion instead — see
  // ContentSignature. The two branches are alternatives, not a fallback: a `text` entry has no
  // `bytes` to test, and a `bytes` entry is never subjected to the binary sweep.
  if (spec.text) {
    assertLooksLikeText(head);
    return;
  }

  const needle = Buffer.from(spec.bytes);
  const ok = spec.searchWindow
    ? head.subarray(0, spec.searchWindow).includes(needle)
    : head.subarray(0, needle.length).equals(needle);
  if (!ok) throw badRequest("That file isn't a valid PDF, DOCX, XLSX, XLS, PNG or JPG.");
}

/**
 * Refuse a probe that is demonstrably not text. The CSV half of the content check.
 *
 * Two layers, and the ORDER of the message matters more than the order of the tests: whichever fires,
 * the user is told their file is not a CSV — never which binary format it looked like. Naming the
 * format would turn an attachment field into a free file-identification oracle, and the user who hit
 * this honestly (they picked the wrong file) is not helped by knowing it was a ZIP.
 *
 * An EMPTY probe passes. It cannot be reached — `measure` refuses a zero-length asset before this
 * runs — and treating "no bytes" as "binary" would be the wrong reading if that ever changed: an
 * empty file is a legitimately empty CSV, not an executable.
 */
function assertLooksLikeText(head: Buffer): void {
  // LAYER 1, and the one that does the real work: every byte in the probe must be one a text file can
  // contain. That is the whole C0 control range minus tab/LF/CR, plus DEL — bytes no encoding this app
  // can receive puts in a data file, and bytes every binary format is dense with. A NUL alone used to
  // be the test; widening it to the control range costs nothing (a CSV has none of them either) and
  // catches a binary whose first 1024 bytes happen to be NUL-free.
  //
  // Deliberately NOT a rule about structure: bytes >= 0x80 are text, because a UTF-8 or Latin-1 CSV
  // is full of them, and a BOM is three of them.
  for (const b of head) {
    if (!isTextByte(b)) throw badRequest("That file isn't a valid CSV.");
  }

  // LAYER 2: the net for a binary that reads as text this far in. Only headers distinctive enough
  // that a real CSV could not open with them — see CSV_HEADER_GUARDS for why `MZ` is not one of them
  // and why excluding it takes nothing away.
  for (const { bytes } of CSV_HEADER_GUARDS) {
    const needle = Buffer.from(bytes);
    if (head.subarray(0, needle.length).equals(needle)) throw badRequest("That file isn't a valid CSV.");
  }
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

/**
 * Record a finalized asset's URL + metadata on its ledger row, keeping the row PENDING.
 *
 * The `deferred-attach` counterpart to releasePending: the browser gets the URL, and the row stays
 * reapable until a save commits it. See FinalizeMode.
 */
export async function stampPendingAsset(asset: VerifiedAsset): Promise<void> {
  await pendingRepo.stampAsset(asset.publicId, {
    url: asset.url,
    fileName: asset.fileName,
    fileType: asset.fileType,
    fileSizeBytes: asset.fileSizeBytes,
  });
}

/**
 * Claim a deferred upload by the URL a form is holding, so a save can turn it into a real row.
 *
 * Returns null when there is no pending row for that URL — which is the normal case for a URL the
 * user pasted by hand, and for one already committed by an earlier save. Callers treat both the
 * same way: keep the URL, own no asset. Never invent an identity for a URL we did not mint.
 */
export async function claimDeferredUpload(url: string): Promise<{
  publicId: string;
  resourceType: string;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  lease: Date;
} | null> {
  const row = await pendingRepo.findByUrl(url);
  if (!row?.url || !row.fileName || !row.fileType || row.fileSizeBytes == null) return null;
  const lease = await pendingRepo.claim(row.publicId, LEASE_MS);
  // Someone else holds it — a double-submit, or the reaper mid-pass. The save keeps the URL and
  // simply does not own the asset, which is the safe half of the race.
  if (!lease) return null;
  return {
    publicId: row.publicId,
    resourceType: row.resourceType,
    fileName: row.fileName,
    fileType: row.fileType,
    fileSizeBytes: row.fileSizeBytes,
    lease,
  };
}

/** Release the ledger row for an upload whose URL is handed back to a form (`return-url` purposes). */
export async function releasePending(publicId: string): Promise<void> {
  await pendingRepo.remove(publicId);
}
