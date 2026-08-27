import type { Prisma, ReportRun, ReportSchedule } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";

// ── Scheduler persistence — the DB is the source of truth ─────────────────────────────────────
//
// Every safety property of the scheduler lives in this file, and every one of them is enforced by the
// DATABASE rather than by a check in the service:
//
//   • idempotency — `@@unique([scheduleId, periodStart])`. Two workers both attempt the insert; one
//     wins, the other takes a unique violation and stands down. A "does it exist?" check before an
//     insert leaves a window, and a retrying cron platform is exactly what lands in that window.
//   • mutual exclusion — every state change is a CONDITIONAL update (`updateMany` with the expected
//     state in the `where`). `update` takes a unique where and cannot carry a guard, so it would
//     happily overwrite another worker's claim.
//   • liveness — a claim carries an expiry, so a worker killed mid-run releases its work to the next
//     sweep instead of stranding the run forever.

export type { ReportRun, ReportSchedule };

export const RUN_PENDING = "pending";
export const RUN_RUNNING = "running";
export const RUN_DELIVERED = "delivered";
export const RUN_FAILED = "failed";

/**
 * How many times a run may be attempted before it stops being retried.
 *
 * Bounded because the two failure modes need opposite treatment: a transient SMTP outage should
 * recover on the next sweep, while a schedule pointing at a deleted report would otherwise retry
 * forever and bury the real failures. Three attempts distinguishes them without a human deciding.
 */
export const MAX_ATTEMPTS = 3;

/** Mongo's duplicate-key error, which is how a losing racer learns it lost. */
export function isDuplicateRun(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/**
 * Schedules that are due.
 *
 * `enabled` first, then the `nextRunAt` range — the order the compound index can serve. Bounded by
 * `take`: a sweep that has been down for a week must not try to drain every schedule in one pass.
 */
export function findDueSchedules(now: Date, take = 50): Promise<ReportSchedule[]> {
  return prisma.reportSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take,
  });
}

/**
 * Create the run for a period, or report that it already exists.
 *
 * The unique constraint does the work. A caller that gets `null` should stand down silently: another
 * worker owns this period, or it has already been delivered.
 */
export async function createRunIfAbsent(data: {
  scheduleId: string;
  periodStart: Date;
  periodEnd: Date;
  periodLabel: string;
}): Promise<ReportRun | null> {
  try {
    return await prisma.reportRun.create({ data: { ...data, status: RUN_PENDING } });
  } catch (e) {
    if (isDuplicateRun(e)) return null;
    throw e;
  }
}

/**
 * Take ownership of a run, if it is still available.
 *
 * Claimable when it is `pending`, or when it is `running` with a LAPSED claim — the second case is a
 * worker that died mid-flight, and reclaiming it is what stops one crash stranding a period forever.
 * A `delivered` run is never claimable, which is the second line of defence behind the unique key.
 *
 * `updateMany` rather than `update`: the guard has to be in the `where`, or two workers both "claim"
 * the same row and both send the email.
 */
export async function claimRun(runId: string, token: string, leaseMs: number, now: Date): Promise<boolean> {
  const res = await prisma.reportRun.updateMany({
    where: {
      id: runId,
      attempts: { lt: MAX_ATTEMPTS },
      OR: [
        { status: RUN_PENDING },
        { status: RUN_FAILED },
        // Reclaim: still marked running, but its lease has expired.
        { status: RUN_RUNNING, claimExpiresAt: { lt: now } },
      ],
    },
    data: {
      status: RUN_RUNNING,
      claimToken: token,
      claimExpiresAt: new Date(now.getTime() + leaseMs),
      startedAt: now,
      attempts: { increment: 1 },
    },
  });
  return res.count === 1;
}

/**
 * Record that ONE recipient has been sent this run's report, while we still hold the claim.
 *
 * Written per send rather than once at the end, because that is the only thing that makes a retry
 * safe. The `(scheduleId, periodStart)` key stops a period being RUN twice; it says nothing about a
 * run that got halfway through its recipient list before SMTP threw. Without this, a failure on the
 * third of five recipients meant the first two received the report again on every retry — the
 * duplicate the whole scheduler is built to prevent, arriving through the one door the unique key
 * does not cover.
 *
 * `push` rather than a read-modify-write: the claim already makes us the only writer, and appending
 * server-side keeps the row correct even if the process dies before the next line runs.
 */
export async function recordDelivery(runId: string, token: string, email: string): Promise<boolean> {
  const res = await prisma.reportRun.updateMany({
    where: { id: runId, claimToken: token },
    data: { deliveredTo: { push: email } },
  });
  return res.count === 1;
}

/**
 * Mark a run delivered — but ONLY if we still hold the claim.
 *
 * The compare-and-set on `claimToken` is the point. A lease can lapse while its holder is still inside
 * a slow SMTP call; if that worker then wrote unconditionally it would stamp "delivered" over a run a
 * second worker had already reclaimed and was actively sending, and the recipients would get two
 * copies with the record showing one.
 */
export async function completeRun(
  runId: string,
  token: string,
  data: { deliveredTo: string[]; rowCount?: number },
  now: Date,
): Promise<boolean> {
  const res = await prisma.reportRun.updateMany({
    where: { id: runId, claimToken: token },
    data: {
      status: RUN_DELIVERED,
      completedAt: now,
      deliveredTo: data.deliveredTo,
      rowCount: data.rowCount ?? null,
      error: null,
      claimToken: null,
      claimExpiresAt: null,
    },
  });
  return res.count === 1;
}

/**
 * Record a failure, releasing the claim so the next sweep may retry.
 *
 * The attempt was already counted at claim time, so a worker that dies before reaching here still
 * burns its attempt — which is what stops a crash-looping schedule retrying without bound.
 */
export async function failRun(runId: string, token: string, message: string, now: Date): Promise<boolean> {
  const res = await prisma.reportRun.updateMany({
    where: { id: runId, claimToken: token },
    data: {
      status: RUN_FAILED,
      completedAt: now,
      // Truncated: an ORM stack trace in a column nobody reads is not diagnostics, and the operator
      // sees the full error in the logs.
      error: message.slice(0, 500),
      claimToken: null,
      claimExpiresAt: null,
    },
  });
  return res.count === 1;
}

/**
 * Advance the schedule's own clock.
 *
 * Guarded on the `nextRunAt` we read, so two workers that both picked up the same due schedule cannot
 * both advance it — the loser's update matches nothing and it moves on. Advancing by exactly ONE
 * period (the caller computes it) means a long outage drains one period per sweep and the periods
 * that were missed remain visible as absent ReportRuns rather than collapsing into a single catch-up.
 */
export async function advanceSchedule(
  scheduleId: string,
  expectedNextRunAt: Date,
  nextRunAt: Date,
  lastRunAt: Date,
): Promise<boolean> {
  const res = await prisma.reportSchedule.updateMany({
    where: { id: scheduleId, nextRunAt: expectedNextRunAt },
    data: { nextRunAt, lastRunAt },
  });
  return res.count === 1;
}

export function findRun(scheduleId: string, periodStart: Date): Promise<ReportRun | null> {
  return prisma.reportRun.findUnique({ where: { scheduleId_periodStart: { scheduleId, periodStart } } });
}

/**
 * The most recent run of each of the given schedules, keyed by schedule id.
 *
 * For the LIST screen's health column. Without it a schedule whose every run fails looks perfectly
 * healthy there — Status reads "Active", Next run reads a future date, and the failure is visible
 * only to somebody who opens that one schedule's run-history modal. A report that silently stopped
 * arriving is the failure mode this whole module is built to prevent, so it has to be legible from
 * the list rather than found.
 *
 * One query for the page, then reduced in memory: Mongo cannot express "latest per group" through
 * Prisma, and the row count here is (schedules × runs kept) — small, and already bounded by `take`.
 */
export async function findLatestRuns(scheduleIds: string[]): Promise<Map<string, ReportRun>> {
  const out = new Map<string, ReportRun>();
  if (scheduleIds.length === 0) return out;
  const runs = await prisma.reportRun.findMany({
    where: { scheduleId: { in: scheduleIds } },
    orderBy: { periodStart: "desc" },
  });
  for (const r of runs) if (!out.has(r.scheduleId)) out.set(r.scheduleId, r);
  return out;
}

export function listRuns(scheduleId: string, take = 50): Promise<ReportRun[]> {
  return prisma.reportRun.findMany({ where: { scheduleId }, orderBy: { periodStart: "desc" }, take });
}

export function createSchedule(data: Prisma.ReportScheduleUncheckedCreateInput): Promise<ReportSchedule> {
  return prisma.reportSchedule.create({ data });
}

export function updateSchedule(id: string, data: Prisma.ReportScheduleUncheckedUpdateInput): Promise<ReportSchedule> {
  return prisma.reportSchedule.update({ where: { id }, data });
}

export function findScheduleById(id: string): Promise<ReportSchedule | null> {
  return prisma.reportSchedule.findUnique({ where: { id } });
}

export function listSchedules(): Promise<ReportSchedule[]> {
  return prisma.reportSchedule.findMany({ orderBy: { createdAt: "desc" } });
}

/**
 * Delete a schedule AND its run history, atomically.
 *
 * The child rows are removed explicitly because `ReportRun.schedule` is a required relation with no
 * `onDelete` — as is every relation in this schema. Prisma emulates referential integrity on MongoDB
 * and a required relation defaults to RESTRICT, so deleting a parent that has children is refused
 * with P2014: the delete button worked only on a schedule that had never run, which is the opposite
 * of the ones people want to remove. Same explicit-children pattern the purchase-order repository
 * already uses.
 *
 * Removing the runs with it is the intended behaviour, not a side effect — the confirm dialog says
 * so, and a run row is delivery state for a schedule that no longer exists. The audit trail is what
 * outlives the record; `report_schedule.deleted` is written by the service.
 */
export function deleteSchedule(id: string): Promise<ReportSchedule> {
  return withTransaction(async (tx) => {
    await tx.reportRun.deleteMany({ where: { scheduleId: id } });
    return tx.reportSchedule.delete({ where: { id } });
  });
}

/** A user who may receive a scheduled report — the shape the picker and the validator both use. */
export interface RecipientCandidate {
  id: string;
  name: string;
  email: string;
}

/**
 * Active users authorised to view a report, by the permission that report requires.
 *
 * TWO steps rather than a relation filter, because Prisma on MongoDB cannot filter a to-one relation
 * by an array field: find the roles that grant it, then the users holding one of those roles. The
 * same shape the rest of this codebase uses for cross-collection reads.
 *
 * `"*"` is included because a super-admin role grants everything by holding it, and a role's stored
 * permission array is already expanded (role.service applies implied permissions at save time), so
 * membership is the whole test.
 *
 * Excluded deliberately: soft-deleted users, any status other than `active` (suspended and inactive
 * are people who should stop receiving company reports), and anyone without an address to send to.
 */
export async function findEligibleRecipients(permissions: string[]): Promise<RecipientCandidate[]> {
  const roles = await prisma.role.findMany({
    // EVERY permission, not any of them — a recipient must hold the report's view right AND the
    // export right. `hasSome` would have qualified somebody on either one alone.
    //
    // `"*"` stays an OR branch rather than a member of the list: a super-admin role holds it INSTEAD
    // of the individual keys, so `hasEvery` would reject the one role that is allowed everything.
    where: { OR: [{ permissions: { hasEvery: permissions } }, { permissions: { has: "*" } }] },
    select: { id: true },
  });
  if (roles.length === 0) return [];

  const users = await prisma.user.findMany({
    where: {
      roleId: { in: roles.map((r) => r.id) },
      status: "active",
      // Rows predating the soft-delete column have no `deletedAt` at all, which `null` alone misses.
      OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
    },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  return users
    .filter((u) => typeof u.email === "string" && u.email.includes("@"))
    .map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email }));
}

/** A stored recipient key is a user id; rows saved before that change hold an email instead. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * Resolve stored recipient keys to something a human can read.
 *
 * DISPLAY ONLY, and deliberately unfiltered: a schedule's list should still name somebody who has
 * since been deactivated or lost the permission, because that is who was selected and the operator
 * needs to recognise the row. Whether they will actually be SENT to is a different question, answered
 * by findEligibleRecipients at save time and again at send time.
 *
 * Ids are screened against the ObjectId shape first — Prisma throws on a malformed one, which a
 * legacy email row would otherwise trigger.
 */
export async function findRecipientProfiles(keys: string[]): Promise<RecipientCandidate[]> {
  const ids = [...new Set(keys.filter((k) => OBJECT_ID.test(k)))];
  const emails = [...new Set(keys.filter((k) => k.includes("@")))];
  if (ids.length === 0 && emails.length === 0) return [];

  const or: { id?: { in: string[] }; email?: { in: string[] } }[] = [];
  if (ids.length) or.push({ id: { in: ids } });
  if (emails.length) or.push({ email: { in: emails } });

  const users = await prisma.user.findMany({
    where: { OR: or },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  return users.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email }));
}
