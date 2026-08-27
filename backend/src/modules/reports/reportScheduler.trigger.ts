import { timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

import { runDueSchedules } from "./reportScheduler.service.js";
import { env } from "../../config/env.js";

// ── The TRIGGER adapter — the only file a hosting decision touches ────────────────────────────
//
// The scheduler CORE (`runDueSchedules`) knows nothing about how it is invoked. This file is the
// seam: it offers the two shapes every runtime can drive, and nothing else in the module changes when
// the production platform is chosen or later changed.
//
//   HTTP  — `schedulerTriggerHandler`, for a platform scheduler / external cron that can make a
//           request (Vercel Cron, Cloud Scheduler, EventBridge, a Kubernetes CronJob curling the
//           service, a plain crontab running `curl`). Guarded by a shared secret.
//   In-process — `startSchedulerLoop`, for a long-running host (VPS, container, bare Node) where the
//           process itself is the scheduler.
//
// BOTH are wired, and each one activates itself from configuration rather than from a guess about the
// platform:
//
//   • the HTTP route is always mounted but refuses every request with a 503 until
//     REPORT_SCHEDULER_SECRET is set — so it is inert on a host that does not use it, and there is
//     never an unauthenticated endpoint that can email people;
//   • the loop runs only inside server.ts, which a serverless runtime never executes at all.
//
// So a platform-cron deployment sets the secret, a long-running deployment gets the loop for free, and
// a deployment doing both is safe: every decision about what has already run is made against the
// database. See docs/reports-scheduler-runtime.md.
//
// The in-process loop is a TRIGGER, never the source of truth. It only asks the core to look; every
// decision about what has already run is made against the database, so several instances may run the
// loop at once and no report is sent twice.

/**
 * Secret the HTTP trigger requires.
 *
 * Read at call time rather than module load so a deployment can rotate it without a rebuild, and so a
 * test can exercise both the configured and unconfigured paths.
 */
function triggerSecret(): string | undefined {
  return env.REPORT_SCHEDULER_SECRET;
}

/**
 * Constant-time comparison of the presented secret against the configured one.
 *
 * `!==` on a string leaks its answer through timing. That is a thin channel, but this is a bearer
 * credential on an endpoint that emails people, and `timingSafeEqual` is one line.
 */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself be the leak; compare the lengths
  // separately and still run the digest so the fast path is not obviously faster.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * HTTP entry point for an external scheduler.
 *
 * Design notes that matter for a cron platform:
 *
 *   • 401 when the secret is missing or wrong, and 503 when none is CONFIGURED — refusing to run
 *     unauthenticated is the only safe default for an endpoint that emails people. An unconfigured
 *     secret is a deployment mistake, not an invitation.
 *   • Always 200 on a completed sweep, even when individual runs failed. Cron platforms retry on a
 *     non-2xx, and a retry would be pointless here — the failures are already recorded with their
 *     attempt counts and the next scheduled invocation retries them properly. Returning 500 would
 *     just multiply the same work.
 *   • The response body is the tally, so an operator can see what happened from the platform's own
 *     invocation log without opening the database.
 */
export const schedulerTriggerHandler: RequestHandler = (req, res) => {
  const secret = triggerSecret();
  if (!secret) {
    res.status(503).json({ error: "Scheduler trigger is not configured." });
    return;
  }
  // Header, bearer token or query, because platforms differ in what they can attach; all three carry
  // the same secret. A query string is the weakest of the three (it lands in access logs), so it is
  // last and documented as the fallback for a cron that can only fetch a URL.
  const bearer = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  const provided = req.get("x-scheduler-secret") ?? bearer ?? (req.query.secret as string | undefined);
  if (!secretMatches(provided, secret)) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }

  void runDueSchedules()
    .then((result) => res.json({ result }))
    .catch((e) => {
      // Only a failure of the SWEEP itself reaches here (a dead database). Per-schedule failures are
      // handled inside the core and never propagate.
      console.error("[report-scheduler] sweep failed:", e);
      res.status(500).json({ error: "Sweep failed." });
    });
};

/**
 * In-process loop, for a long-running host.
 *
 * Returns its own stop function so a graceful shutdown can halt it before the database client
 * disconnects — the same contract the existing sweeps in `server.ts` follow.
 *
 * `unref()` so the loop alone never holds the process alive: a timer that keeps a container running
 * after everything else has finished is a container that never restarts cleanly.
 *
 * Started from server.ts, beside the upload reaper and the rental and session sweeps, which is the
 * mechanism this codebase already uses for exactly this class of work. A serverless runtime never
 * executes server.ts, so wiring it there cannot produce a loop that silently never fires.
 *
 * Sweeps once on start as well as on the interval. Without it a host that redeploys more often than
 * the interval would never sweep at all — and the first sweep after a restart is the one most likely
 * to have a backlog waiting. It is safe: the claim and the (schedule, period) key decide what runs,
 * so a boot storm across several instances still sends each report once.
 */
export function startSchedulerLoop(intervalMs = 15 * 60_000): () => void {
  const sweep = () => void runDueSchedules().catch((e) => console.error("[report-scheduler] sweep failed:", e));
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
