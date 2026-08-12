import { destroyFromCloudinary } from "../../lib/cloudinary.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";

import * as attachmentRepo from "./attachment.repository.js";

/** The identity as it comes off an attachment row — either half may be null on a legacy row. */
export interface AssetRef {
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
export async function releaseAsset(ref: AssetRef, context: string): Promise<void> {
  const { publicId, resourceType } = ref;

  // A row written before identity was persisted. We know the URL but not the pair that addresses
  // the asset, and deriving it by parsing the URL is exactly the guess that could destroy the
  // wrong file. Leaving it is the conservative half of that trade.
  if (!publicId || !resourceType) {
    console.error(`[attachment] no stored identity, Cloudinary asset left in place (${context})`);
    return;
  }

  try {
    const refs = await attachmentRepo.countRefs(resourceType, publicId);
    if (refs > 0) return; // still referenced — the shared-asset case, and not an error

    const creds = await getCloudinaryCreds();
    if (!creds) {
      console.error(`[attachment] Cloudinary not configured, asset ${publicId} left in place (${context})`);
      return;
    }

    await destroyFromCloudinary(publicId, resourceType, creds);
  } catch (e) {
    console.error(
      `[attachment] cleanup failed for ${resourceType}/${publicId} (${context}):`,
      e instanceof Error ? e.message : e,
    );
  }
}
