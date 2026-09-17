import type { LoginChallenge, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for LoginChallenge — the ONLY place prisma.loginChallenge is touched.

export function create(data: Prisma.LoginChallengeCreateInput): Promise<LoginChallenge> {
  return prisma.loginChallenge.create({ data });
}

export function findByTokenHash(tokenHash: string): Promise<LoginChallenge | null> {
  return prisma.loginChallenge.findUnique({ where: { tokenHash } });
}

export function update(
  id: string,
  data: Prisma.LoginChallengeUpdateInput,
): Promise<LoginChallenge> {
  return prisma.loginChallenge.update({ where: { id }, data });
}

/**
 * CLAIM a challenge: delete it and report whether THIS caller is the one that removed it.
 *
 * This is the concurrency control for OTP verification, and it is why verify does not simply call
 * `deleteById`. A single MongoDB document delete is atomic, so of two concurrent requests carrying
 * the SAME correct code, exactly one sees `true` and the other sees `false` — the loser is then
 * rejected with the ordinary generic message. Without this, both could pass the bcrypt comparison
 * before either delete landed, and both would go on to open a session.
 *
 * Also the reason the delete must happen BEFORE the session is created, never after.
 */
export async function claimById(id: string): Promise<boolean> {
  const { count } = await prisma.loginChallenge.deleteMany({ where: { id } });
  return count === 1;
}

/** Fire-and-forget removal where nobody races us (expiry pruning, lockout, failed delivery). */
export async function deleteById(id: string): Promise<void> {
  // deleteMany, not delete: a concurrently-removed row is not an error for any caller here.
  await prisma.loginChallenge.deleteMany({ where: { id } });
}

export async function deleteByTokenHash(tokenHash: string): Promise<void> {
  await prisma.loginChallenge.deleteMany({ where: { tokenHash } });
}

/**
 * One live challenge per principal — called before issuing a new one, so a second login attempt
 * supersedes the first rather than leaving two guessable challenges open at once.
 */
export function deleteForPrincipal(
  principalId: string,
  principalType: string,
): Promise<Prisma.BatchPayload> {
  return prisma.loginChallenge.deleteMany({ where: { principalId, principalType } });
}

/**
 * Atomically bump the failed-attempt counter and hand back the new value.
 *
 * `increment` is applied by the database, so two concurrent wrong guesses cannot both read 3 and
 * both write 4 — the lockout threshold can't be walked past by racing it.
 */
export async function incrementAttempts(id: string): Promise<number | null> {
  // updateMany, not update: `update` throws P2025 when the row is gone, and the error middleware
  // maps that to a 404 "Not Found" — a database-shaped answer leaking out of a login endpoint, on a
  // step whose client only understands 401 and 410. The row CAN vanish between the read and this
  // write (a concurrent verify consumed it, or the sweep removed an expired one), so the race is
  // real rather than theoretical. `null` means "no longer there", which the caller reports as the
  // ordinary ended-challenge answer.
  const { count } = await prisma.loginChallenge.updateMany({
    where: { id },
    data: { attempts: { increment: 1 } },
  });
  if (count === 0) return null;

  // The incremented value, read back separately because updateMany cannot return it. A second
  // concurrent failure may already have bumped it further, which only makes the lockout fire
  // sooner — never later — so it stays safe under contention.
  const row = await prisma.loginChallenge.findUnique({
    where: { id },
    select: { attempts: true },
  });
  return row?.attempts ?? null;
}

export function deleteExpired(now: Date): Promise<Prisma.BatchPayload> {
  return prisma.loginChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
}
