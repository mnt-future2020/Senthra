import crypto from "node:crypto";

import type { Session } from "@prisma/client";

import * as sessionRepo from "./session.repository.js";
import { revokePrincipalSockets, revokeSessionSockets } from "../../lib/realtime.js";
import type { Actor } from "../../utils/jwt.js";

// realtime.ts imports this module back (its handshake auth calls findActive). That cycle is
// deliberate and safe under ESM — neither side touches the other at module-evaluation time, only
// inside function bodies — and it buys the invariant below: killing a session's socket lives HERE,
// next to the delete, instead of at each caller. A future call site that deletes sessions some new
// way therefore cannot forget to hang up on the device, which is exactly the kind of thing that is
// forgotten and leaves a revoked device quietly receiving broadcasts.

// Max concurrent devices per account (business rule). Signing in past this evicts
// the least-recently-used session, so only this many ever stay live. At 1 that means
// a new sign-in signs the previous device straight out. The number is mirrored in the
// frontend's SessionsCard copy — change both together.
export const MAX_DEVICES = 1;

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

  // Enforce the cap AFTER inserting so concurrent sign-ins self-heal: keep the new
  // session plus at most the (MAX_DEVICES - 1) most-recently-used LIVE others, and
  // evict everything else — overflow and any already-expired-but-unpruned rows.
  // The new sid is excluded from the ranking and re-added unconditionally, so the
  // total is exactly MAX_DEVICES no matter where the fresh row sorts: a race (or
  // several simultaneous sign-ins, or two rows sharing a lastUsedAt millisecond)
  // can neither evict the device that just logged in nor leave the account over cap.
  // Only live sessions count toward the cap.
  const all = await sessionRepo.findForPrincipal(principalId, principalType);
  const now = Date.now();
  const keep = new Set(
    all
      .filter((s) => s.sid !== sid && s.expiresAt.getTime() > now)
      .slice(0, MAX_DEVICES - 1)
      .map((s) => s.sid),
  );
  keep.add(sid);
  const evict = all.filter((s) => !keep.has(s.sid)).map((s) => s.sid);
  if (evict.length) {
    await sessionRepo.deleteManyBySids(evict);
    // Bump the evicted devices off their sockets now. At a cap of 1 this IS the feature: the
    // previous device lands on /login within the second instead of sitting on a stale screen
    // until its next request. Fire-and-forget — the row is already gone, so a missed push only
    // costs immediacy, never correctness.
    revokeSessionSockets(evict, "signed_in_elsewhere");
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
  // Ordinary logout, and it revokes the socket for the SAME reason the other three paths do: until
  // the socket is closed, a device whose session row is gone still sits in the broadcast rooms it
  // joined at connect and keeps receiving job, purchase-order and rental payloads it can no longer
  // fetch over REST. This was the one deleting call site that did not, which contradicted the
  // invariant stated at the top of this file — the whole reason revocation lives beside the delete.
  //
  // `sid` is the caller's argument, not something read back off the deleted row, so the ordering is
  // safe: the identifier the revocation needs cannot be lost by the delete that precedes it.
  //
  // "signed_out_remotely" rather than a reason of its own: this fires for every tab on the device,
  // and a sibling tab that did not press Logout is being told exactly what the copy says — this
  // device's session was ended. The tab that DID press it has already navigated itself.
  revokeSessionSockets([sid], "signed_out_remotely");
}

export async function endAll(principalId: string, principalType: Actor): Promise<void> {
  await sessionRepo.deleteAllForPrincipal(principalId, principalType);
  revokePrincipalSockets(principalId, "signed_out_remotely");
}

export async function endOthers(
  principalId: string,
  principalType: Actor,
  keepSid: string,
): Promise<void> {
  await sessionRepo.deleteOthersForPrincipal(principalId, principalType, keepSid);
  // Everything but the device that asked. Same push as the cap eviction so "Sign out other
  // devices" and a password change land on those screens as fast as a new sign-in does.
  revokePrincipalSockets(principalId, "signed_out_remotely", keepSid);
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
