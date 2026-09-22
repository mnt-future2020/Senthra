// ── DigitalOcean Spaces, behind the storage contract ───────────────────────────────────────────
//
// Spaces speaks the S3 API, so this is an ordinary S3 client pointed at a DigitalOcean endpoint.
// What makes it interesting is not the API but how DIFFERENT its model is from Cloudinary's, and
// every difference below is one the contract had to absorb rather than leak:
//
//   • ONE FLAT NAMESPACE. Cloudinary addresses an asset by `publicId` + `resource_type`, and the
//     same id can exist twice under different types. Spaces has a key and nothing else, so
//     `resourceType` is carried for the rest of the system's benefit and ignored here.
//   • NO INGEST PROCESSING. Cloudinary decodes an image and refuses what it cannot read; Spaces
//     stores whatever bytes arrive. That is a real validation gap — and deliberately NOT closed in
//     this file (see Task 6), because storing opaque bytes is exactly what this layer is for.
//   • NO SIGNED RECEIPT. Cloudinary signs its upload response. An S3 presigned POST answers 204
//     with no body, so `confirmUpload` proves the object exists by reading it back instead.
//   • NO DELIVERY-TIME TRANSFORMS. Nothing here can resize or re-encode on the way out.
//
// Credentials are passed IN, exactly as the Cloudinary adapter takes its own: this stays a pure
// transport with no config source of its own, so a test can build one without an environment and a
// caller cannot accidentally get a provider built from credentials it did not intend.

import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

import { badRequest } from "../../utils/http-error.js";

import type {
  AssetRef,
  HeadResult,
  SignUploadSpec,
  SignedUpload,
  StorageProvider,
  StoredAsset,
  UploadOptions,
} from "./types.js";

/** Everything needed to reach one Space. Resolved by settings.service, never read from here. */
export interface SpacesConfig {
  /** e.g. https://ams3.digitaloceanspaces.com */
  endpoint: string;
  /** e.g. ams3 */
  region: string;
  bucket: string;
  accessKeyId: string;
  /** Decrypted at the boundary. Never logged, never returned, never put in an error message. */
  secretAccessKey: string;
  /** Optional CDN origin. When set, delivery URLs are built from it instead of the bucket host. */
  cdnUrl: string | null;
}

/**
 * How long a presigned POST stays valid.
 *
 * The same 120 seconds the Cloudinary signature uses, and for the same reason: the browser uploads
 * immediately, so a longer window only widens the period in which a leaked policy could be replayed.
 */
const SIGNATURE_TTL_SECONDS = 120;

/**
 * Cache policy, chosen at WRITE time because S3 has no delivery-time equivalent.
 *
 * This is the one place Spaces needs a decision Cloudinary makes for itself. Cloudinary invalidates
 * its own CDN copy when it overwrites an asset; S3 serves whatever header the object was stored
 * with, for as long as that header says. So a DETERMINISTIC key — `logo`, `favicon`, `po-logo`,
 * `signature-<userId>`, all of which are overwritten in place — must carry a short TTL, or a
 * replaced company logo keeps being served from the edge for a year with nothing able to clear it.
 *
 * A UUID key can never be rewritten, so it gets the long immutable policy it deserves.
 */
const CACHE_MUTABLE = "public, max-age=300";
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";

function cacheControlFor(immutable: boolean): string {
  return immutable ? CACHE_IMMUTABLE : CACHE_MUTABLE;
}

/** `data:application/pdf;base64,…` → `application/pdf`. Null when it is not a data URI. */
function mediaTypeOf(dataUri: string): string | null {
  return /^data:([^;,]+)/i.exec(dataUri)?.[1]?.toLowerCase() ?? null;
}

/** The bytes of a base64 data URI. Throws a caller-facing error rather than a decode exception. */
function bytesOf(dataUri: string): Buffer {
  const comma = dataUri.indexOf(",");
  if (!dataUri.startsWith("data:") || comma < 0) throw badRequest("Upload a valid file.");
  return Buffer.from(dataUri.slice(comma + 1), "base64");
}

/**
 * The object key for a folder + public id.
 *
 * EXACTLY `<folder>/<publicId>`, which is the same string the rest of the system already persists
 * and later addresses the object by. Nothing is prepended, hashed, re-encoded or normalised: the
 * identity in the database and the key in the bucket have to be the same string or `head`,
 * `readRange`, `destroy` and `deliveryUrl` all stop finding the file.
 *
 * The leading slash is stripped because S3 would otherwise create an object whose name begins with
 * one — a key that looks identical in a URL and is a different object.
 */
function keyOf(folder: string, publicId: string): string {
  return `${folder}/${publicId}`.replace(/^\/+/, "");
}

/**
 * The key a browser upload is ALLOWED to write, which is never the key the object ends up at.
 *
 * An S3 POST policy authorises a destination for its whole lifetime, not for a single use — so a
 * client that has uploaded once can post again to the same key and replace bytes finalize has
 * already approved. There is no POST condition that prevents it; S3 has no "only if absent".
 *
 * So the permit is issued for a key the app never serves. Finalize validates the object here, then
 * copies it to its real key and deletes this one. A replayed permit can still write — but only to a
 * staging key that no row references and that the reaper sweeps up.
 *
 * The suffix is safe as a marker because the final segment of every key is a server-generated name
 * ending in an allow-listed extension; nothing the user supplies can produce a real key ending in
 * `.staged`.
 */
const STAGING_SUFFIX = ".staged";

function stagingKeyOf(key: string): string {
  return `${key}${STAGING_SUFFIX}`;
}

/** The real key a staging key promotes to. Any other key is already final and returned unchanged. */
function finalKeyOf(key: string): string {
  return key.endsWith(STAGING_SUFFIX) ? key.slice(0, -STAGING_SUFFIX.length) : key;
}

/** Join a base URL and a key with exactly one separator, whatever either side brought. */
function joinUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

/**
 * Turn an SDK failure into something a user can act on, WITHOUT leaking what went wrong internally.
 *
 * An S3 error carries the request id, the endpoint, and sometimes the signature that failed — none
 * of which belongs in a message shown to someone uploading a photo, and the secret key must never
 * appear anywhere near one. So the name is mapped to a sentence and everything else is dropped.
 */
function configurationError(e: unknown): never {
  const name = e instanceof Error ? e.name : "";
  const reason =
    name === "NoSuchBucket"
      ? "the bucket does not exist"
      : name === "AccessDenied" || name === "InvalidAccessKeyId" || name === "SignatureDoesNotMatch"
        ? "the credentials were refused"
        : "it could not be reached";
  throw badRequest(`File storage isn't configured correctly (DigitalOcean Spaces: ${reason}). Check Settings → Storage.`);
}

/** True when the SDK says the object is not there, as opposed to anything else going wrong. */
function isNotFound(e: unknown): boolean {
  const name = e instanceof Error ? e.name : "";
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === "NotFound" || name === "NoSuchKey" || status === 404;
}

/** The public base a delivery URL is built on: the CDN when configured, else the bucket host. */
function deliveryBaseFor(config: SpacesConfig): string {
  if (config.cdnUrl) return config.cdnUrl;
  // https://ams3.digitaloceanspaces.com → https://<bucket>.ams3.digitaloceanspaces.com
  return config.endpoint.replace(/^(https?:\/\/)/i, `$1${config.bucket}.`);
}

/** Identity of one configuration, with the secret hashed rather than held as a map key. */
function clientKey(c: SpacesConfig): string {
  return createHash("sha256")
    .update([c.endpoint, c.region, c.bucket, c.accessKeyId, c.secretAccessKey].join("\u0000"))
    .digest("hex");
}

/**
 * ONE live S3 client, reused across every call that resolves the same configuration.
 *
 * A new `S3Client` is not free: each one carries its own HTTPS agent and socket pool, and nothing
 * here ever awaited a `.destroy()`. Building one per call meant the reaper opened a client PER
 * ABANDONED ROW, and every `releaseAsset` opened another — a leak that scales with traffic on a
 * process designed to stay up for months, and which surfaces as "the backend stopped being able to
 * reach storage" long after the cause.
 *
 * Keyed by the configuration, so rotating a credential builds a new client rather than quietly
 * reusing one holding the old secret. The previous client is destroyed on replacement: a request
 * in flight at the exact moment an administrator changes storage settings would fail and be
 * retried, which is a better trade than keeping every superseded socket pool alive for ever.
 */
let liveClient: { key: string; client: S3Client } | null = null;

function clientFor(config: SpacesConfig): S3Client {
  const key = clientKey(config);
  if (liveClient?.key === key) return liveClient.client;
  liveClient?.client.destroy();
  liveClient = {
    key,
    client: new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // Spaces serves a bucket as a SUBDOMAIN of the region endpoint, which is the modern
      // virtual-hosted style. Path-style would address `endpoint/bucket/key` and 404 on Spaces.
      forcePathStyle: false,
    }),
  };
  return liveClient.client;
}

/** Test-only: drop the cached client so a suite cannot leak one into the next. */
export function __resetSpacesClient(): void {
  liveClient?.client.destroy();
  liveClient = null;
}

export function createSpacesProvider(config: SpacesConfig): StorageProvider {
  const client = clientFor(config);
  const deliveryBase = () => deliveryBaseFor(config);

  return {
    id: "spaces",

    /**
     * FALSE. Spaces stores opaque bytes — it never looks inside them, so a file of arbitrary content
     * uploaded as `image/png` is stored exactly as happily as a real photograph. That gap is closed
     * by the application instead: finalize reads this flag and runs a magic-byte pass that Cloudinary
     * does not need.
     */
    validatesImagesOnIngest: false,

    /**
     * FALSE. An object store hands back exactly the bytes it was given; there is no equivalent of a
     * transformation URL. Anything a renderer needs in a different shape has to be produced with
     * `sharp` at upload time and stored as its own object — see lib/storage/derivatives.ts.
     */
    transformsOnDelivery: false,

    /**
     * Store a file from a data URI.
     *
     * `kind` does not change the object: Spaces has one flat namespace and stores opaque bytes
     * either way. What it DOES still decide, along with `immutable`, is the metadata written
     * alongside — the content type a browser will trust, and how long the edge may hold it.
     */
    async upload(source: string, publicId: string, opts: UploadOptions): Promise<StoredAsset> {
      const key = keyOf(opts.folder, publicId);
      // Explicit, never inferred. S3 stores `binary/octet-stream` when it is not told, and a
      // document served under that type downloads as a blob instead of opening.
      const contentType = mediaTypeOf(source) ?? "application/octet-stream";
      // Decoded BEFORE the try, and that placement is the whole point. `bytesOf` throws when the
      // source is not a base64 data URI — a caller's problem — and inside the try it came back out
      // as "File storage isn't configured correctly (DigitalOcean Spaces: it could not be reached)".
      // An administrator reading that goes and edits credentials that were working perfectly, which
      // is worse than an unhelpful message: it invites someone to break a correct configuration.
      const body = bytesOf(source);

      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            // Phase 1 is public-read: the delivery URL is what every stored record already holds,
            // and it must keep working without an authenticated request. Private delivery would
            // expire those URLs, which is a different piece of work entirely.
            ACL: "public-read",
            CacheControl: cacheControlFor(opts.immutable),
            // Opens in the browser rather than forcing a save. The file name is the key's own last
            // segment, which is why the key shapes carry a readable name in the first place.
            ContentDisposition: "inline",
          }),
        );
      } catch (e) {
        configurationError(e);
      }

      return {
        url: joinUrl(deliveryBase(), key),
        publicId: key,
        // Echoed rather than replaced. The service stamps its OWN resourceType on the ledger, so
        // inventing one here would only create two values for the same asset. Spaces ignores it.
        resourceType: opts.kind === "image" ? "image" : "raw",
        provider: "spaces",
      };
    },

    /**
     * Authorise one direct browser upload as a presigned POST.
     *
     * A POST POLICY rather than a presigned PUT, and the difference is load-bearing: a policy can
     * carry CONDITIONS the browser cannot edit, which is how the size ceiling and the content type
     * survive the trip. A presigned PUT has no equivalent, so the only cap would be the one the
     * client chose to respect — i.e. none.
     */
    async signUpload(spec: SignUploadSpec): Promise<SignedUpload> {
      // The permit is minted for the STAGING key, never the real one — see `stagingKeyOf`. Every
      // condition below therefore pins the staging destination, and the object only reaches the key
      // this app serves once finalize has approved its contents.
      const key = stagingKeyOf(keyOf(spec.folder, spec.publicId));
      // `immutable` is not on SignUploadSpec: every direct browser upload carries a UUID key and is
      // never rewritten, so the long policy is always the right one here. The deterministic keys
      // (branding, signatures) all go through `upload` above, which is given the flag.
      const cacheControl = CACHE_IMMUTABLE;

      let presigned;
      try {
        presigned = await createPresignedPost(client, {
          Bucket: config.bucket,
          Key: key,
          Expires: SIGNATURE_TTL_SECONDS,
          // Echoed into the form AND signed, so the browser cannot alter any of them.
          Fields: {
            "Content-Type": spec.mediaType,
            acl: "public-read",
            "Cache-Control": cacheControl,
            "Content-Disposition": "inline",
          },
          Conditions: [
            // The key is exact — not a prefix — so a client holding this policy can write to one
            // object and no other.
            ["eq", "$key", key],
            ["eq", "$Content-Type", spec.mediaType],
            ["eq", "$acl", "public-read"],
            ["eq", "$Cache-Control", cacheControl],
            ["eq", "$Content-Disposition", "inline"],
            // The edge-side size cap. This is what replaces Cloudinary's upload preset: the one
            // limit that is enforced BEFORE the bytes are spent, rather than after.
            ["content-length-range", 1, spec.maxBytes],
          ],
        });
      } catch (e) {
        configurationError(e);
      }

      return {
        method: "POST",
        url: presigned.url,
        // Every field the policy produced, unchanged. The browser posts them verbatim; renaming or
        // dropping one breaks the signature.
        fields: { ...presigned.fields },
        // The SAME string the ledger and every attachment row will hold.
        publicId: key,
        resourceType: spec.resourceType,
        provider: "spaces",
      };
    },

    /**
     * Move the approved bytes to the key this app actually serves.
     *
     * `MetadataDirective: "COPY"` carries the content type, cache policy and disposition the permit
     * pinned, so the promoted object is byte-for-byte the one that was validated, described exactly
     * as it was described on the way in. The ACL is re-stated because a copy does NOT inherit it —
     * omit that and every promoted file becomes private, which on a provider whose delivery URLs are
     * plain and unauthenticated means every attachment 403s.
     *
     * The staging object is deleted AFTER the copy succeeds. If that delete fails the promotion has
     * still worked, so it is logged rather than thrown: the pending row is keyed by the staging key
     * and the reaper will collect it. Failing here would reject an upload that is already safely
     * stored.
     */
    async promoteUpload(ref: AssetRef): Promise<AssetRef> {
      const finalKey = finalKeyOf(ref.publicId);
      if (finalKey === ref.publicId) return ref; // already final — nothing was staged

      try {
        await client.send(
          new CopyObjectCommand({
            Bucket: config.bucket,
            CopySource: `/${config.bucket}/${ref.publicId}`,
            Key: finalKey,
            MetadataDirective: "COPY",
            ACL: "public-read",
          }),
        );
      } catch (e) {
        configurationError(e);
      }

      try {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: ref.publicId }));
      } catch (e) {
        console.error(`[spaces] promoted ${finalKey} but could not remove its staged copy:`, e instanceof Error ? e.message : e);
      }

      return { ...ref, publicId: finalKey };
    },

    /**
     * Is this really the asset we authorised?
     *
     * S3 issues no signed receipt — a presigned POST answers 204 with an empty body — so `evidence`
     * is unused and the proof is that the object is THERE, under the exact key the policy allowed.
     * That is not weaker than Cloudinary's check: ownership was never established by the response
     * signature, it is established by the PendingUpload row, which the caller has already matched.
     *
     * The message is deliberately identical to Cloudinary's. Which provider failed, and why, is not
     * something an upload form should disclose.
     */
    async confirmUpload(ref: AssetRef): Promise<void> {
      try {
        await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: ref.publicId }));
      } catch {
        // Deliberately one message for every cause. Whether the object is absent or the bucket
        // refused the request is a detail about OUR storage, and an upload form is not where that
        // gets disclosed. (This used to branch on `isNotFound` and throw the same sentence twice,
        // which read as though the two cases differed.)
        throw badRequest("That upload could not be verified.");
      }
    },

    /**
     * What the stored object reports about itself. A HeadObject — metadata only, never the bytes.
     *
     * A MISSING object and a zero-length one are different answers: the first throws, the second
     * returns `sizeBytes: 0`. The caller's size ceiling depends on telling them apart, and an
     * unreadable asset must never measure as a plausible small number.
     */
    async head(ref: AssetRef): Promise<HeadResult> {
      let res;
      try {
        res = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: ref.publicId }));
      } catch (e) {
        if (isNotFound(e)) throw badRequest("Could not verify the uploaded file (not found).");
        throw badRequest("Could not verify the uploaded file.");
      }
      return { sizeBytes: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
    },

    /**
     * The first bytes of a stored object, for magic-byte validation.
     *
     * A RANGED GetObject, so a 10 MB document costs about a kilobyte to inspect — the whole point,
     * and the reason this is not a full download followed by a slice.
     *
     * The body stream is consumed to completion, which is what releases the underlying socket back
     * to the SDK's pool. Abandoning it half-read leaks a connection per call, and the symptom is a
     * process that stops being able to reach Spaces at all after a few hundred uploads.
     */
    async readRange(ref: AssetRef, byteCount: number): Promise<Buffer> {
      let res;
      try {
        res = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: ref.publicId,
            Range: `bytes=0-${byteCount - 1}`,
          }),
        );
      } catch (e) {
        if (isNotFound(e)) throw badRequest("Could not read the uploaded file (not found).");
        throw badRequest("Could not read the uploaded file.");
      }

      const body = res.Body;
      if (!body) throw badRequest("Could not read the uploaded file.");

      const chunks: Buffer[] = [];
      // `transformToByteArray` reads the whole stream and releases it, which is what the SDK's own
      // helper exists for. It is preferred over iterating by hand precisely because the release is
      // not optional.
      if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
        const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
        return Buffer.from(bytes).subarray(0, byteCount);
      }
      // Node stream fallback, for a body the SDK handed back without the helper.
      for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks).subarray(0, byteCount);
    },

    /**
     * Delete one stored object. BEST-EFFORT CLEANUP, and idempotent.
     *
     * An ALREADY-MISSING object is a SUCCESS, matching the Cloudinary adapter exactly: S3 answers a
     * delete for a key it has no record of with a 204 either way, and that is indistinguishable
     * from "a previous attempt already removed it". Both mean the intended end state holds, and
     * treating it as an error would make a retry look broken.
     *
     * This method belongs to a provider INSTANCE, which is what makes Task 3's design work: the
     * caller resolved which provider holds the asset from the row, and this one already knows it is
     * Spaces. Nothing here reads Settings to decide ownership.
     */
    async destroy(ref: AssetRef): Promise<void> {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: ref.publicId }));
      } catch (e) {
        if (isNotFound(e)) return;
        throw e;
      }
    },

    /**
     * The public URL an object is served at.
     *
     * Phase 1 is public-read, so this is a plain URL and not a signed one — and it must stay plain:
     * every stored record already holds a URL of this shape, and a signed URL would expire.
     */
    deliveryUrl(ref: AssetRef): string {
      return joinUrl(deliveryBase(), ref.publicId);
    },
  };
}

/**
 * Prove one Spaces configuration is usable, WITHOUT leaving anything behind.
 *
 * Lives here rather than in the settings service for the same reason every other S3 call does: the
 * AWS client is this file's business and nowhere else's. A boundary test asserts that.
 *
 * TWO STEPS, and the second is the one that matters:
 *
 *   1. HeadBucket — the endpoint resolves, the credentials are accepted, the bucket exists.
 *   2. Put then Delete a zero-byte `_healthcheck/<uuid>` object.
 *
 * Step 1 alone would pass for a READ-ONLY key, which then fails every upload the moment the provider
 * is switched — exactly the "save it, discover it is broken later" outcome the switch guard exists
 * to prevent. Step 2 is the smallest operation that proves the permissions the adapter actually
 * uses, and the delete is part of the test rather than an afterthought: if cleanup fails, that is
 * reported, not swallowed.
 *
 * Never throws, and never repeats an SDK message. An S3 error carries the endpoint, a request id and
 * sometimes the failed signature; none of that belongs in a message an administrator reads, and the
 * secret must not appear within a mile of one.
 */
const PROBE_FETCH_TIMEOUT_MS = 8_000;

/**
 * Can the public actually READ what we just wrote, at the address we would hand out?
 *
 * The step this probe was missing, and the reason it needed one. Every stored row holds a plain
 * delivery URL that must resolve for an unauthenticated browser, and that URL is built from
 * `cdnUrl` when one is set — a value the S3 calls above NEVER touch. So a mistyped CDN origin
 * passed the whole test, and then went on being written into attachment rows, job attachments,
 * avatars and signatures as a permanent part of each record. Discovering it later is a data
 * migration, not a settings change.
 *
 * Fetching the object back also proves two things the SDK calls cannot: that the bucket ACCEPTS an
 * `public-read` ACL, and that it then serves the object anonymously. Both are assumptions the
 * adapter makes on every single upload.
 */
async function probeDelivery(config: SpacesConfig, key: string, expected: string): Promise<string | null> {
  const url = joinUrl(deliveryBaseFor(config), key);
  const via = config.cdnUrl ? "CDN" : "bucket";
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS), redirect: "follow" });
  } catch {
    // Name the host, never the exception: a DNS failure and a TLS failure are the same advice here,
    // and the URL is the thing the administrator actually has to look at.
    return `wrote a test object, but the ${via} address did not respond (${url}). Check the ${config.cdnUrl ? "CDN URL" : "endpoint and bucket"}.`;
  }
  if (res.status === 403) {
    return `wrote a test object, but it is not publicly readable (${url} returned 403). The Space must allow public-read objects.`;
  }
  if (!res.ok) {
    return `wrote a test object, but the ${via} address returned ${res.status} (${url}).`;
  }
  // Content equality, not merely a 200: a CDN pointed at the WRONG origin answers 200 all day long
  // with somebody else's bytes, which is precisely the mistake a typo produces.
  const body = await res.text().catch(() => "");
  if (body.trim() !== expected) {
    return `the ${via} address answered, but served different content than was uploaded (${url}). It is probably pointing at another origin.`;
  }
  return null;
}

export async function probeSpacesConnection(config: SpacesConfig): Promise<{ ok: boolean; message: string }> {
  const client = clientFor(config);
  const key = `_healthcheck/${randomUUID()}`;
  // Unique per probe, so a stale cached copy at a CDN edge cannot be mistaken for this one's.
  const token = `senthra-storage-check-${randomUUID()}`;

  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  } catch (e) {
    return { ok: false, message: `Could not reach the bucket — ${reasonFor(e)}.` };
  }

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: Buffer.from(token),
        ContentType: "text/plain",
        // EXACTLY what a real upload writes. A bucket that refuses this ACL refuses every upload
        // the app will ever make, and the old probe — which sent no ACL — passed cheerfully.
        ACL: "public-read",
        CacheControl: "no-store",
      }),
    );
  } catch (e) {
    return {
      ok: false,
      message: `Connected, but the credentials cannot write to the bucket — ${reasonFor(e)}.`,
    };
  }

  // From here the object EXISTS, so every exit runs the delete. A probe that leaves its own litter
  // behind on the failure paths is a probe an administrator runs ten times while debugging.
  // `probeDelivery` reports its own failures as a string rather than throwing, so this cannot leave
  // the cleanup below unreached. Sequenced explicitly rather than with try/finally: a `return`
  // inside a `finally` silently discards whatever the block was already throwing, which would turn
  // an unexpected fault here into a misleading "could not be deleted".
  const delivery = await probeDelivery(config, key, token);

  try {
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
  } catch (e) {
    // Reported rather than ignored: a key that can write but not delete will leak every replaced
    // avatar and every abandoned upload, silently, forever. Reported BEFORE the delivery result,
    // because a bucket the app cannot clean up is the more serious of the two findings.
    return {
      ok: false,
      message: `Connected and wrote a test object, but it could not be deleted — ${reasonFor(e)}. The credentials need delete permission.`,
    };
  }

  if (delivery) return { ok: false, message: `Connected and ${delivery}` };

  return {
    ok: true,
    message: `Connected to ${config.bucket} (${config.region}), and it serves public files${config.cdnUrl ? " through the CDN" : ""}.`,
  };
}

/** An SDK failure, reduced to a phrase that names no credential and no internal detail. */
function reasonFor(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "NoSuchBucket" || name === "NotFound") return "the bucket does not exist";
  if (name === "InvalidAccessKeyId") return "the access key was not recognised";
  if (name === "SignatureDoesNotMatch") return "the secret key was rejected";
  if (name === "AccessDenied" || name === "Forbidden") return "access was denied";
  return "the endpoint could not be reached";
}
