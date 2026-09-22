import { getStorageFor, normalizeProviderId } from "../../lib/storage/index.js";

import * as attachmentRepo from "./attachment.repository.js";

/**
 * The identity as it comes off an attachment row.
 *
 * `publicId`/`resourceType` may be null on a legacy row written before identity was persisted —
 * that pair being incomplete is what makes an asset unaddressable, and the release path skips it.
 *
 * `provider` is different: null is a VALID, complete value meaning Cloudinary, because that is what
 * every row written before multi-provider support is. It is never a reason to skip.
 */
export interface AssetRef {
  provider: string | null;
  publicId: string | null;
  resourceType: string | null;
}

/**
 * Release the Cloudinary asset an attachment row used to reference — IF nothing else references it.
 *
 * ## The ordering is the safety mechanism
 *
 * CALL THIS ONLY AFTER THE DATABASE DELETE HAS COMMITTED. Not before, and not inside a
 * transaction. The invariant it upholds is:
 *
 *   > if a committed PRF/PO/GRN row still references (resourceType, publicId),
 *   > the asset is NOT destroyed.
 *
 * Counting AFTER the commit is what proves that, and it needs no lock to do so. Consider what a
 * concurrent removal of the two rows that can share one asset can produce:
 *
 *   - one commits first, counts, sees the other → skips. The other counts, sees none → destroys. ✓
 *   - both commit, both count, both see none → both destroy. `destroy` is idempotent. ✓
 *   - both commit, each still sees the other's row → both skip → the asset survives unreferenced. ✓
 *
 * The last case leaks a file. That is the intended outcome: every ordering either deletes an
 * unreferenced asset or leaves an orphan, and none can delete a referenced one. Counting BEFORE the
 * delete is what breaks it — the other side could commit its reference in the gap — so the sequence
 * must not be "optimised" into one step.
 *
 * The remaining hazard would be a reference appearing AFTER the count. It cannot: the only path
 * that copies an attachment identity is PRF → PO conversion, `converted` is a terminal PRF status
 * re-checked inside its transaction, and PRF attachments are editable in `draft` only. So an asset
 * whose last reference was just removed cannot acquire a new one.
 *
 * ## Failure is not the caller's failure
 *
 * Never throws. The business operation has already succeeded and committed; surfacing a storage
 * error now would report a false failure for work that is done, and rolling back is not on the
 * table. Every give-up path logs enough to identify the asset later — that log is the input a
 * future reconciliation pass would read, and is the reason not to build one yet.
 *
 * @param ref     identity read off the row BEFORE it was deleted
 * @param context short label for the log line, e.g. `purchase_order PO-0042`
 */
/**
 * Build a release reference from an attachment row.
 *
 * The five attachment tables all name the column `storageProvider`; `AssetRef` calls it `provider`.
 * One mapping in one place, so a call site cannot quietly drop the provider and fall back to the
 * active one — which would look identical until somebody switched provider.
 */
export function refFromAttachment(row: {
  storageProvider: string | null;
  publicId: string | null;
  resourceType: string | null;
}): AssetRef {
  return { provider: row.storageProvider, publicId: row.publicId, resourceType: row.resourceType };
}

export async function releaseAsset(ref: AssetRef, context: string): Promise<void> {
  const { provider, publicId, resourceType } = ref;

  // A row written before identity was persisted. We know the URL but not the pair that addresses
  // the asset, and deriving it by parsing the URL is exactly the guess that could destroy the
  // wrong file. Leaving it is the conservative half of that trade.
  if (!publicId || !resourceType) {
    console.error(`[attachment] no stored identity, Cloudinary asset left in place (${context})`);
    return;
  }

  try {
    const refs = await attachmentRepo.countRefs(provider, resourceType, publicId);
    if (refs > 0) return; // still referenced — the shared-asset case, and not an error

    // THE INVARIANT OF THIS WHOLE TASK: the provider comes off the ROW, never from whichever
    // provider Settings currently selects. An administrator switching provider must not change
    // where an existing file is looked for — do that and every older asset silently stops being
    // deletable, with nothing erroring to say so.
    // `normalizeProviderId` is the ONE place a stored string becomes a provider id, and it reads
    // null/missing/unrecognised as Cloudinary — the value every legacy row carries.
    const storage = await getStorageFor({ provider: normalizeProviderId(provider) });
    if (!storage) {
      console.error(
        `[attachment] ${provider ?? "cloudinary"} not configured, asset ${publicId} left in place (${context})`,
      );
      return;
    }

    await storage.destroy({ provider: normalizeProviderId(provider), publicId, resourceType });
  } catch (e) {
    console.error(
      `[attachment] cleanup failed for ${resourceType}/${publicId} (${context}):`,
      e instanceof Error ? e.message : e,
    );
  }
}
