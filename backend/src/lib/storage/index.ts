// ── The storage entry point ────────────────────────────────────────────────────────────────────
//
// The ONE module the rest of the app imports to get a storage backend. Two functions, and the
// difference between them is the whole design:
//
//   getActiveStorage()  — where a NEW upload goes. Reads the configured provider.
//   getStorageFor(ref)  — where an EXISTING asset already lives. Reads the asset's own row and
//                         never consults the configured provider.
//
// Mixing those up is the one mistake that cannot be recovered from cheaply: resolving a delete from
// the active setting means that the moment an administrator switches provider, every previously
// stored file becomes unreachable by the delete path — silently, because nothing errors. Files stop
// being cleaned up and nobody notices until the storage bill does.

import { getCloudinaryCreds, getSpacesConfig, getStoredProviderId } from "#modules/settings/settings.service.js";

import { badRequest } from "../../utils/http-error.js";

import { createCloudinaryProvider } from "./cloudinary.js";
import { createSpacesProvider } from "./spaces.js";
import type { AssetRef, StorageProviderId, StorageProvider } from "./types.js";

export type {
  AssetRef,
  HeadResult,
  SignUploadSpec,
  SignedUpload,
  StorageProvider,
  StorageProviderId,
  StoredAsset,
  UploadEvidence,
  UploadOptions,
} from "./types.js";

/**
 * Read a stored provider value.
 *
 * NULL, missing and empty all mean "cloudinary". Every asset row written before multi-provider
 * support has no provider recorded, and this is what makes all of them correct without a backfill.
 * An unrecognised value also falls back rather than throwing: a delete path must not be the thing
 * that discovers a typo, and the fallback is the provider every legacy asset is actually on.
 */
export function normalizeProviderId(v: string | null | undefined): StorageProviderId {
  return v === "spaces" ? "spaces" : "cloudinary";
}

/**
 * Which provider NEW uploads go to.
 *
 * Read from Settings on every call, deliberately NOT cached. A cached value is how the UI ends up
 * showing one provider while uploads go to another — the administrator saves the change, the screen
 * confirms it, and files keep landing in the old bucket until something restarts. The read is a
 * single indexed lookup of a singleton row; it is not worth a staleness bug.
 *
 * NULL means Cloudinary, which is what every install that has never touched this setting has.
 *
 * This answers "where should a NEW upload go" and nothing else. Which provider holds an EXISTING
 * asset is recorded on that asset's own row and resolved by `getStorageFor` — see the header.
 */
export async function getActiveProviderId(): Promise<StorageProviderId> {
  return normalizeProviderId(await getStoredProviderId());
}

/** Build one provider, or null when its credentials are not fully configured. */
async function build(id: StorageProviderId): Promise<StorageProvider | null> {
  // Each branch resolves ONLY its own configuration. A broken Cloudinary setup must not stop a
  // Spaces asset being read or deleted, and vice versa — the two providers coexist for as long as
  // any asset remains on the older one, which is forever unless someone migrates it.
  if (id === "spaces") {
    const config = await getSpacesConfig();
    return config ? createSpacesProvider(config) : null;
  }
  const creds = await getCloudinaryCreds();
  return creds ? createCloudinaryProvider(creds) : null;
}

/**
 * The provider a NEW upload should go to, or null when it is not configured.
 *
 * For the callers that already have their OWN "not configured" message. Several do, and they differ
 * — branding names Settings → Storage, the avatar path names profile images, the PO archive
 * logs and carries on without failing the send. Those messages are user-facing text, so the
 * not-configured branch stays with the caller rather than being centralised into one wording.
 */
export async function findActiveStorage(): Promise<StorageProvider | null> {
  return build(await getActiveProviderId());
}

/**
 * The provider a NEW upload should go to.
 *
 * Throws when it is not configured, because there is no sensible partial outcome: the caller is
 * about to store a file and cannot. The message matches what the upload path already says, and names
 * NO provider: this resolves whichever one is active, so naming Cloudinary here told an administrator
 * running Spaces to go and fix the wrong thing, in a tab that no longer holds those fields either.
 */
export async function getActiveStorage(): Promise<StorageProvider> {
  const id = await getActiveProviderId();
  const provider = await build(id);
  if (!provider) {
    throw badRequest("File uploads aren't configured. Set up a storage provider in Settings → Storage.");
  }
  return provider;
}

/**
 * The provider that already holds THIS asset.
 *
 * Reads `ref.provider` and nothing else — never the active setting. Returns null when that
 * provider's credentials are missing, which every caller treats the same way it does today: log,
 * leave the asset in place, and carry on. A cleanup that cannot run is not a business failure.
 */
export function getStorageFor(ref: Pick<AssetRef, "provider">): Promise<StorageProvider | null> {
  return build(normalizeProviderId(ref.provider));
}
