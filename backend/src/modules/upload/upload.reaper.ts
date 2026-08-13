import { destroyFromCloudinary } from "../../lib/cloudinary.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";

import * as pendingRepo from "./upload.repository.js";

/**
 * Destroy assets the browser uploaded and never came back for.
 *
 * Direct upload means Cloudinary can hold a file before anything here refers to it: the tab closed,
 * the network died, the user walked away. The PendingUpload row is the record that we asked for that
 * asset and nobody took delivery, so this can destroy it knowing it is unreferenced — WITHOUT
 * listing the Cloudinary account, and without comparing anything against the database.
 *
 * ## Why it cannot delete a live asset
 *
 * It only ever touches rows in its own ledger, and a row only exists between "we authorised an upload"
 * and "someone claimed it". Finalize deletes the row inside the same transaction as the attachment
 * write, so an attached asset has no row for this to find. There is no window in which both are true.
 *
 * `countRefs` is deliberately NOT the safety mechanism here. It counts the three attachment tables
 * only — a job or van-stock attachment lives in a `String[]`, so it would read as zero references and
 * this would destroy a file that is on screen.
 *
 * ## Why it cannot interrupt a finalize
 *
 * Both take the row through the same conditional update, so exactly one wins. A finalize that is
 * running holds a live lease and this skips the row; if this wins first, that finalize's own claim
 * fails and it refuses rather than attaching an asset that is being deleted.
 */

/** Old enough that the browser is certainly not coming back. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
/** Held long enough for one destroy; a crash frees the row again on its own. */
const REAP_LEASE_MS = 60 * 1000;
/** Bounded so one pass cannot become an unbounded loop against Cloudinary. */
const BATCH = 100;

export interface ReapResult {
  scanned: number;
  destroyed: number;
  skipped: number;
  failed: number;
}

export async function reapAbandonedUploads(now = new Date()): Promise<ReapResult> {
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS);
  const rows = await pendingRepo.findReapable(cutoff, BATCH);
  const result: ReapResult = { scanned: rows.length, destroyed: 0, skipped: 0, failed: 0 };
  if (rows.length === 0) return result;

  const creds = await getCloudinaryCreds();
  if (!creds) {
    // Nothing to destroy with. Leave every row where it is — they will be reconsidered next pass, and
    // deleting the ledger without deleting the asset would lose the only record that it exists.
    console.error(`[upload-reaper] Cloudinary not configured — ${rows.length} abandoned uploads left in place`);
    return { ...result, skipped: rows.length };
  }

  for (const row of rows) {
    // Re-take the lease per row. Between the query above and this line a finalize may have started, and
    // this is what makes the two mutually exclusive rather than merely unlikely.
    if (!(await pendingRepo.claim(row.publicId, REAP_LEASE_MS))) {
      result.skipped++;
      continue;
    }
    try {
      await destroyFromCloudinary(row.publicId, row.resourceType, creds);
      await pendingRepo.remove(row.publicId);
      result.destroyed++;
    } catch (e) {
      // Keep the row. Its lease expires in a minute and the next pass tries again — dropping it here
      // would leave the asset with nothing left to find it by.
      result.failed++;
      console.error(
        `[upload-reaper] could not destroy ${row.resourceType}/${row.publicId}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return result;
}

/**
 * Run it periodically.
 *
 * An in-process timer, because this app has no scheduler and one abandoned-upload sweep is not a
 * reason to introduce a queue, a worker or Redis. It is safe to run on every instance at once: each
 * row is claimed through the same conditional update, so two servers sweeping together simply means
 * one of them skips the row.
 *
 * `unref()` so the timer never holds the process open — a shutting-down server should shut down.
 */
export function startUploadReaper(intervalMs = 60 * 60 * 1000): () => void {
  const tick = () => {
    void reapAbandonedUploads()
      .then((r) => {
        if (r.destroyed || r.failed) {
          console.info(`[upload-reaper] destroyed ${r.destroyed}, failed ${r.failed}, skipped ${r.skipped}`);
        }
      })
      .catch((e: unknown) => console.error("[upload-reaper] pass failed:", e instanceof Error ? e.message : e));
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
