import { randomUUID } from "node:crypto";

import { formatDate } from "#modules/document/document.formatter.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
// The regional prefs give BOTH the timezone that decides "today" and the date format for the email
// body. Same accessor the PO document builder uses.
import { getRegionalSettings } from "#modules/settings/settings.service.js";
import { startOfDayIn } from "../../utils/filter-date.js";

import * as poRepo from "./purchase-order.repository.js";

/** Give up after this many failed sends — a broken SMTP config must not retry forever. */
const MAX_ATTEMPTS = 5;
/** Bounded so one pass cannot become an unbounded loop against the mail server. */
const BATCH = 100;

export interface SweepResult {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
  givenUp: number;
  /** Claimed, then lost the lease mid-send — someone else owns the row now. */
  lostLease: number;
}

/**
 * Remind someone that a hire is about to end.
 *
 * AT-LEAST-ONCE, deliberately. The transport is nodemailer over raw SMTP, which has no idempotency
 * key, and EmailLog is written after the attempt with no dedupe column — so a crash between the
 * server accepting the mail and `deadlineNotifiedAt` being written means the next pass sends a
 * second copy. The alternative ordering (mark, then send) loses the reminder entirely, which is the
 * failure this feature exists to prevent. A duplicate is an annoyance; a miss is the bug.
 *
 * The badge is the DURABLE notification and this is the convenience layer: the badge is recomputed
 * from the rows on every read, so it does not depend on this having run, on SMTP working, or on
 * anyone having received anything. That is what makes giving up after MAX_ATTEMPTS safe.
 */
export async function sweepRentalDeadlines(now = new Date()): Promise<SweepResult> {
  const regional = await getRegionalSettings();
  const todayStart = startOfDayIn(regional.timezone, now);
  // MAX_ATTEMPTS is passed to the QUERY, not only checked below: a row that has given up writes no
  // "notified" stamp and takes no lease, so nothing else would ever take it out of the running set.
  const rows = await poRepo.findDueForReminder(todayStart, BATCH, MAX_ATTEMPTS);
  const result: SweepResult = { scanned: rows.length, sent: 0, skipped: 0, failed: 0, givenUp: 0, lostLease: 0 };

  for (const row of rows) {
    // A backstop only, now that the query excludes them: a row claimed under an older, higher limit
    // could still arrive here. The give-up is REPORTED at the moment it happens, in the failure path
    // below — a line printed here would repeat on every pass for as long as the row kept matching,
    // which is what the log used to do.
    if (row.deadlineNotifyAttempts >= MAX_ATTEMPTS) {
      result.givenUp++;
      continue;
    }
    const to = row.purchaseOrder.pmEmail ?? row.purchaseOrder.createdBy;
    if (!to) {
      result.skipped++;
      continue;
    }
    // Claim BEFORE sending, under a token unique to this attempt, so a second instance cannot also
    // send AND so every write below can prove it is still the owner.
    const token = randomUUID();
    if (!(await poRepo.claimReminder(row.id, token))) {
      result.skipped++;
      continue;
    }
    try {
      await sendTemplatedEmail("rental_deadline_reminder", to, {
        poCode: row.purchaseOrder.code,
        itemName: row.itemName,
        quantity: String(row.quantity),
        // Rendered in the configured DATE FORMAT but explicitly in UTC, not the company timezone.
        // A hire date is a calendar day stored as UTC midnight (utils/calendar-day.ts); formatting
        // it in a zone behind UTC would render 2026-10-01T00:00:00Z as 30 September and name the
        // wrong deadline in the one message whose whole job is naming the deadline.
        hireEndDate: formatDate(row.hireEndDate, regional.dateFormat, "UTC"),
      });
      // The mail went. If the lease lapsed while it was going, someone else owns the row — say so
      // rather than stamping over them. The email is out either way (at-least-once, above).
      if (await poRepo.markReminderSent(row.id, token)) {
        result.sent++;
      } else {
        result.lostLease++;
        console.warn(
          `[rental-sweep] lease lapsed mid-send for ${row.purchaseOrder.code} / ${row.itemName} — the mail went, another worker owns the row`,
        );
      }
    } catch (e) {
      // Conditional too: a stale worker must never clear the live worker's claim.
      const attempts = row.deadlineNotifyAttempts + 1;
      if (await poRepo.releaseReminderClaim(row.id, token, attempts)) {
        result.failed++;
        // The transition, announced once: this reminder has stopped being retried. Safe because the
        // BADGE is the durable notification — recomputed from the rows on every read, whatever the
        // sweep managed to send.
        if (attempts >= MAX_ATTEMPTS) {
          result.givenUp++;
          console.error(
            `[rental-sweep] giving up on the reminder for ${row.purchaseOrder.code} / ${row.itemName} after ${attempts} attempts — the deadline is still on the badge`,
          );
        }
      } else {
        result.lostLease++;
      }
      console.error(`[rental-sweep] reminder for ${row.purchaseOrder.code} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return result;
}

/**
 * Run it periodically.
 *
 * An in-process timer, mirroring the upload reaper: this app has no scheduler and one reminder
 * sweep is not a reason to introduce a queue. Safe to run on every instance at once — each row is
 * claimed through a conditional update, so a second instance simply skips it.
 *
 * `unref()` so the timer never holds a shutting-down process open.
 */
export function startRentalDeadlineSweep(intervalMs = 2 * 60 * 60 * 1000): () => void {
  const tick = () => {
    void sweepRentalDeadlines()
      .then((r) => {
        // `skipped` included: a pass where every hire lacked an address printed NOTHING, which reads as
  // a sweep that found no work rather than one that could not act on any of it.
  if (r.sent || r.failed || r.givenUp || r.lostLease || r.skipped) {
          console.info(
            `[rental-sweep] sent ${r.sent}, failed ${r.failed}, gave up ${r.givenUp}, lost lease ${r.lostLease}, skipped ${r.skipped}`,
          );
        }
      })
      .catch((e: unknown) => console.error("[rental-sweep] pass failed:", e instanceof Error ? e.message : e));
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
