import crypto from "node:crypto";

import type { Session } from "@prisma/client";

import * as sessionRepo from "./session.repository.js";
import type { Actor } from "../../utils/jwt.js";

// Max concurrent devices per account (business rule). Signing in past this evicts
// the least-recently-used session, so only this many ever stay live. The number is
// mirrored in the frontend's SessionsCard copy — change both together.
export const MAX_DEVICES = 3;

// How long a session (and its refresh token) stays valid. Matches the refresh
// cookie's lifetime.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface PublicSession {
  id: string;
  current: boolean;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
}

// Start a session for a new device. Enforces the device cap: anything beyond the
// (MAX_DEVICES - 1) most-recent sessions is evicted so this new one fits.
export async function startSession(
  principalId: string,
  principalType: Actor,
  meta: SessionMeta,
): Promise<string> {
  const sid = crypto.randomUUID();
  await sessionRepo.create({
    sid,
    principalId,
    principalType,
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });

  // Enforce the cap AFTER inserting so concurrent sign-ins self-heal: keep the
  // MAX_DEVICES most-recently-used LIVE sessions plus the one we just created, and
  // evict everything else — overflow and any already-expired-but-unpruned rows.
  // Pinning the new sid means a race (or 3+ simultaneous sign-ins) can never evict
  // the device that just logged in, and only live sessions count toward the cap.
  const all = await sessionRepo.findForPrincipal(principalId, principalType);
  const now = Date.now();
  const keep = new Set(
    all
      .filter((s) => s.expiresAt.getTime() > now)
      .slice(0, MAX_DEVICES)
      .map((s) => s.sid),
  );
  keep.add(sid);
  const evict = all.filter((s) => !keep.has(s.sid)).map((s) => s.sid);
  if (evict.length) {
    await sessionRepo.deleteManyBySids(evict);
  }
  return sid;
}

// Is this session still live (exists + not expired)? Lazily prunes an expired row.
export async function isActive(sid: string): Promise<boolean> {
  return (await findActive(sid)) !== null;
}

// Like isActive but returns the session row, so callers can cross-check that the
// access/refresh token's actor + sub match the session's principal — defence in
// depth for the multi-actor (admin/user/customer) model, on top of the JWT binding
// sub+actor+sid. Lazily prunes an expired row.
export async function findActive(sid: string): Promise<Session | null> {
  if (!sid) return null;
  const session = await sessionRepo.findBySid(sid);
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await sessionRepo.deleteBySid(sid);
    return null;
  }
  return session;
}

// True when a live session belongs to exactly this principal (actor + id).
export function sessionMatchesPrincipal(
  session: Session,
  actor: Actor,
  principalId: string,
): boolean {
  return session.principalType === actor && session.principalId === principalId;
}

export async function touch(sid: string): Promise<void> {
  try {
    await sessionRepo.touch(sid);
  } catch {
    // a concurrently-evicted session — harmless to ignore
  }
}

export async function endSession(sid: string): Promise<void> {
  await sessionRepo.deleteBySid(sid);
}

export async function endAll(principalId: string, principalType: Actor): Promise<void> {
  await sessionRepo.deleteAllForPrincipal(principalId, principalType);
}

export async function endOthers(
  principalId: string,
  principalType: Actor,
  keepSid: string,
): Promise<void> {
  await sessionRepo.deleteOthersForPrincipal(principalId, principalType, keepSid);
}

/**
 * Delete sessions that have already expired. Returns how many went.
 *
 * NOT a retention rule and not a new policy: the lifetime is the SESSION_TTL_MS the row was created
 * with, and every one of these rows is already unusable — `findActive` rejects an elapsed
 * `expiresAt`, `listSessions` filters it out of the device list, and `startSession` does not count
 * it toward the cap. This only stops the dead row (and the IP address on it) sitting there forever
 * because nobody happened to touch it again.
 */
export async function purgeExpiredSessions(now = new Date()): Promise<number> {
  const { count } = await sessionRepo.deleteExpired(now);
  return count;
}

export async function listSessions(
  principalId: string,
  principalType: Actor,
  currentSid: string,
): Promise<PublicSession[]> {
  const sessions = await sessionRepo.findForPrincipal(principalId, principalType);
  return sessions
    .filter((s) => s.expiresAt.getTime() >= Date.now())
    .map((s) => ({
      id: s.id,
      current: s.sid === currentSid,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
    }));
}
