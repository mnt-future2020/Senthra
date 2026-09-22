import { randomUUID } from "node:crypto";

// No Cloudinary import of any kind. Signing, verification, delivery URLs and deletion all go
// through the provider abstraction now, which is what lets a second backend exist without this file
// changing again.
import {
  findActiveStorage,
  getStorageFor,
  normalizeProviderId,
  type AssetRef,
  type StorageProvider,
} from "../../lib/storage/index.js";
import { withTransaction } from "../../lib/prisma.js";
import { badRequest, conflict, forbidden } from "../../utils/http-error.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
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

/**
 * The provider a NEW upload should be signed against.
 *
 * Distinct from `requireStorage` below, and the distinction is the one this whole change is about:
 * this asks "where should a new file go", that asks "where does this existing file already live".
 * The message names no provider — it describes a configuration problem and points at the one screen
 * where every provider is configured. Which backend is missing credentials is not something an
 * upload form should disclose, and naming one would be wrong half the time.
 */
async function requireActiveStorage(): Promise<StorageProvider> {
  const storage = await findActiveStorage();
  if (!storage) throw badRequest("File uploads aren't configured. Set up a storage provider in Settings → Storage.");
  return storage;
}

/**
 * The provider that holds the asset being finalized.
 *
 * Resolved from the LEDGER ROW, never from whichever provider is currently selected. An upload
 * authorised against one provider must be verified against that SAME one: if an administrator
 * switches provider while a file is in flight, finalize would otherwise go looking for an object
 * on a backend it was never written to, and refuse a perfectly good upload.
 */
async function requireStorage(ref: Pick<AssetRef, "provider">): Promise<StorageProvider> {
  const storage = await getStorageFor(ref);
  if (!storage) throw badRequest("File uploads aren't configured. Set up a storage provider in Settings → Storage.");
  return storage;
}

// ── Signature ──────────────────────────────────────────────────────────────────────────────────

export interface SignatureInput {
  purpose: string;
  fileName: string;
  sizeBytes: number;
  mediaType: string;
}

/**
 * What the browser is told, and the whole of it.
 *
 * PROVIDER-NEUTRAL BY CONSTRUCTION: there is no Cloudinary cloud name, api key, timestamp, preset or
 * resource type here, and no provider id either. The browser performs the protocol it is handed —
 * POST these fields to this URL — and cannot tell which backend it is talking to. That is the point:
 * a frontend that could tell would eventually branch on it.
 *
 * `fields` is OPAQUE. Whatever provider-specific values a signature needs travel inside it, already
 * stringified, and the browser must post them verbatim: they are what the signature was computed
 * over, so renaming, reordering, re-stringifying or dropping one invalidates the upload.
 */
export interface SignatureResult {
  /** The HTTP method the upload itself uses. */
  method: "POST";
  /** Where to send it. */
  url: string;
  /** Posted verbatim, before the file. See the type doc — these are signed values. */
  fields: Record<string, string>;
  /**
   * The full key this upload was authorised for, folder included — the identity finalize looks up
   * in the pending ledger. Sent so a provider that returns no body still leaves the browser able to
   * name what it uploaded.
   */
  publicId: string;
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

  // ONE resolution, used for BOTH the signing and the ledger stamp. Asking twice — once for
  // credentials and once for "which provider is active" — would leave a window in which an upload
  // could be signed by one provider and recorded against another.
  const storage = await requireActiveStorage();
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

  // The adapter owns everything provider-specific from here: which fields exist, how they are
  // named, what the signature covers, which URL to post to. This service never learns any of it.
  const signed = await storage.signUpload({
    folder: spec.folder,
    publicId,
    resourceType,
    mediaType,
    maxBytes: spec.maxBytes,
  });

  // Stamp the provider the signature was minted against — `storage.id`, not a second lookup — so
  // finalize and the reaper resolve it from this row rather than from whatever Settings says by the
  // time they run. A switch between here and finalize must not change where the file is looked for.
  await pendingRepo.create({
    publicId: signed.publicId,
    resourceType,
    storageProvider: storage.id,
    purpose,
    actorId: actor.id,
  });

  // Deliberately NOT `...signed`: that carries the provider id, and the browser has no business
  // knowing which backend it is uploading to.
  return { method: signed.method, url: signed.url, fields: signed.fields, publicId: signed.publicId, purpose };
}

// ── Finalize ───────────────────────────────────────────────────────────────────────────────────

export interface FinalizeInput {
  /** The FULL public id of the uploaded object, folder included. */
  publicId: string;
  /**
   * The provider's own receipt, when it issues one — see the validation schema. Optional in the
   * TYPE, not in the Cloudinary adapter, which refuses a finalize that omits either.
   */
  version?: number | string;
  signature?: string;
  purpose: string;
  fileName: string;
  mediaType: string;
}

export interface VerifiedAsset {
  url: string;
  publicId: string;
  resourceType: string;
  /**
   * The provider that actually stored this asset, taken from the ledger row the upload was signed
   * against. It travels all the way to the attachment row so a later delete can resolve the backend
   * from the record instead of assuming the one currently selected.
   */
  provider: string;
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

  // THE ROW decides, not Settings. `normalizeProviderId` reads a null/missing column as Cloudinary,
  // which is what every upload authorised before this column existed was signed against.
  //
  // Held in its own const because `AssetRef.provider` is nullable — this value is not, and the
  // attachment row that eventually records it must not be handed a `null` it would then read back
  // as "unknown, assume Cloudinary".
  const provider = normalizeProviderId(pending.storageProvider);
  const asset: AssetRef = { provider, publicId: input.publicId, resourceType: pending.resourceType };
  const storage = await requireStorage(asset);
  await storage.confirmUpload(asset, { version: input.version, signature: input.signature });

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

  // WHO HAS ALREADY LOOKED INSIDE THIS FILE?
  //
  //   a `raw` upload — nobody. Every provider stores a document opaquely, so the bytes have been
  //   checked by no one until this line.
  //
  //   an IMAGE — it depends on the provider, and that is the whole of what this flag answers.
  //   Cloudinary decodes on ingest and refuses what it cannot read, so its acceptance IS the check
  //   and a second read here would cost a request to re-prove it. An object store decodes nothing,
  //   so on that provider an image arrives exactly as unexamined as a document.
  //
  // Reading the capability rather than the provider name is what keeps this correct for the next
  // backend too: a provider is asked what it does, not recognised by who it is.
  //
  // `discardInvalid` is passed ONLY for the second case, and the asymmetry is deliberate rather than
  // an oversight. The document path has always left a rejected upload for the reaper, and that is
  // existing, working behaviour with its own tests; changing it is not what this validation is for.
  // The IMAGE path is new, so it gets the stricter treatment from the start — proven-invalid bytes
  // should not sit in a public bucket waiting for a daily sweep.
  const isNewImageCheck = pending.resourceType !== "raw";
  if (pending.resourceType === "raw" || !storage.validatesImagesOnIngest) {
    await assertContentMatches(
      storage,
      asset,
      mediaType,
      isNewImageCheck ? () => discard(storage, asset) : null,
    );
  }

  const { sizeBytes: size } = await storage.head(asset);
  if (size > spec.maxBytes) {
    // Refuse AND remove it: the file is already in storage, and leaving an oversize asset behind
    // because the row is about to be deleted would be the leak this whole design exists to avoid.
    await discard(storage, asset);
    throw badRequest(`File must be ${Math.floor(spec.maxBytes / (1024 * 1024))} MB or smaller.`);
  }

  // EVERYTHING ABOVE INSPECTED THE UPLOADED OBJECT. Only now is it moved to the key this app will
  // serve — because the permit the browser still holds authorises the staging key alone, and a
  // permit stays valid for its whole life rather than for a single use. Without this step a client
  // could post again, after approval, and replace the very bytes that were just validated: same
  // URL, same row, different file. Cloudinary refuses that itself (`overwrite: false`) and its
  // `promoteUpload` is an identity, so this line changes nothing there.
  //
  // Promotion is LAST among the checks and FIRST among the writes: nothing invalid is ever moved
  // into place, and nothing is recorded until it has been.
  const stored = await storage.promoteUpload(asset);
  const url = storage.deliveryUrl(stored);

  return {
    url,
    publicId: stored.publicId,
    resourceType: pending.resourceType,
    // Resolved from the PendingUpload row above, not from Settings.
    provider,
    fileName: input.fileName.trim().slice(0, 200) || "attachment",
    fileType: FILE_TYPE_BY_MEDIA[mediaType] ?? "png",
    fileSizeBytes: size,
    lease,
  };
}

/** The first bytes really are the format the caller declared. Raw uploads only — see the catalog. */
async function assertContentMatches(
  storage: StorageProvider,
  asset: AssetRef,
  mediaType: string,
  /**
   * Remove the object whose bytes just failed — or NULL to leave it for the reaper.
   *
   * The file is already in storage by the time anything can look at it, so a rejection that only
   * threw would leave it there: reachable at its URL, referenced by nothing, until the reaper's
   * next pass.
   *
   * Passed for the IMAGE check, which is new — bytes proven to be something other than what they
   * claim should not sit in a public bucket for a day. NOT passed for the document check, whose
   * leave-it-for-the-reaper behaviour predates this and is relied upon by its own tests. Making the
   * two the same is a separate decision from adding the image check, so it is not made here.
   */
  discardInvalid: (() => Promise<void>) | null,
): Promise<void> {
  const spec = CONTENT_SIGNATURES.find((s) => s.mediaType === mediaType);
  // FAIL CLOSED. Every media type that reaches here as `raw` has an entry (verifyFinalize now
  // rejects a declaration whose resource type disagrees with the signed one, which leaves only PDF
  // and DOCX), so a miss means the catalog and this table have drifted apart — a new raw type added
  // without its magic bytes. Returning silently in that case is what made the bypass above possible
  // in the first place: it turns "I don't know how to check this" into "this passed".
  if (!spec) {
    await discardInvalid?.();
    throw badRequest("That file type isn't accepted here.");
  }

  let head: Buffer;
  try {
    head = await storage.readRange(asset, CONTENT_PROBE_BYTES);
  } catch (e) {
    // Could not read it back. Refuse rather than assume: an unreadable upload is not one to attach.
    //
    // NOT discarded, deliberately: this is a transport failure, not a verdict on the bytes. The file
    // may be perfectly valid and the read may succeed a moment later, so the ledger row is left for
    // the reaper rather than destroying something that was never shown to be wrong.
    throw badRequest(`Could not verify the uploaded file (${e instanceof Error ? e.message : "read failed"}).`);
  }

  // A format with no signature of its own (CSV) is checked by exclusion instead — see
  // ContentSignature. The two branches are alternatives, not a fallback: a `text` entry has no
  // `bytes` to test, and a `bytes` entry is never subjected to the binary sweep.
  if (spec.text) {
    await guard(discardInvalid, () => assertLooksLikeText(head));
    return;
  }

  const needle = Buffer.from(spec.bytes);
  const ok = spec.searchWindow
    ? head.subarray(0, spec.searchWindow).includes(needle)
    : head.subarray(0, needle.length).equals(needle);
  // A SECOND anchor, for a format whose leading bytes are a shared container — see ContentSignature.
  // WEBP is the only one: `RIFF` alone is equally a WAV or an AVI.
  const alsoOk =
    !spec.alsoBytes ||
    head
      .subarray(spec.alsoBytes.at, spec.alsoBytes.at + spec.alsoBytes.bytes.length)
      .equals(Buffer.from(spec.alsoBytes.bytes));

  if (!ok || !alsoOk) {
    await discardInvalid?.();
    throw badRequest("That file isn't a valid PDF, DOCX, XLSX, XLS, PNG or JPG.");
  }
}

/** Run a synchronous check, removing the stored object before letting its rejection through. */
async function guard(discardInvalid: (() => Promise<void>) | null, check: () => void): Promise<void> {
  try {
    check();
  } catch (e) {
    await discardInvalid?.();
    throw e;
  }
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

/*
 * The stored size used to be measured here, by `measure(url)`. It now lives on the provider as
 * `head()` — same HTTP HEAD, same "check the status before believing content-length" rule, same
 * timeout — because reading an object's size is a storage concern and every provider answers it
 * differently. Moved rather than duplicated: there is exactly one implementation.
 */

async function discard(storage: StorageProvider, asset: AssetRef): Promise<void> {
  await storage.destroy(asset).catch((e: unknown) =>
    console.error(
      `[upload] could not discard ${asset.resourceType}/${asset.publicId}:`,
      e instanceof Error ? e.message : e,
    ),
  );
  await pendingRepo.remove(asset.publicId);
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
  /** The provider the upload was signed against — see VerifiedAsset.provider. */
  provider: string;
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
    provider: normalizeProviderId(row.storageProvider),
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
