import { purgeExpiredSessions } from "./session.service.js";

/**
 * Remove session rows whose lifetime has already elapsed.
 *
 * ## Why this is not a retention policy
 *
 * It introduces NO new period. A session row is born with `expiresAt` set from SESSION_TTL_MS, and
 * from that moment the application treats an elapsed row as no session at all: `findActive` refuses
 * it (and deletes the one it touched), `listSessions` filters it out of the device list, and
 * `startSession` excludes it from the 2-device cap. This sweep deletes exactly those rows — data the
 * app already refuses to act on. Nothing about login, logout, refresh or the device cap changes.
 *
 * What it fixes is that the existing pruning is LAZY. A row is only reconsidered when its sid is
 * presented again or the same principal signs in, so a device that never returns leaves its row —
 * and the IP address and user-agent on it — in the database indefinitely.
 *
 * ## Why an in-process timer
 *
 * The same reasoning as the upload reaper and the rental-deadline sweep: this app has no scheduler,
 * and one delete-by-predicate is not a reason to introduce a queue or a worker. It is safe on every
 * instance at once — the delete is idempotent, so a second instance simply finds nothing left.
 *
 * `unref()` so the timer never holds a shutting-down process open.
 */
export function startExpiredSessionSweep(intervalMs = 6 * 60 * 60 * 1000): () => void {
  const tick = () => {
    void purgeExpiredSessions()
      .then((count) => {
        if (count > 0) console.info(`[session-sweep] removed ${count} expired session(s)`);
      })
      .catch((e: unknown) =>
        console.error("[session-sweep] pass failed:", e instanceof Error ? e.message : e),
      );
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
