import crypto from "node:crypto";

import * as challengeRepo from "./twoFactor.repository.js";
import * as auditService from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
import { HttpError } from "../../utils/http-error.js";
import type { Actor } from "../../utils/jwt.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";

// --- Approved policy (spec §7). Changing any of these changes the security posture. ---

/** How long a challenge stays valid. A resend RE-BASES this from the resend moment. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** Wrong codes allowed per challenge before it is destroyed. */
export const MAX_ATTEMPTS = 5;
/** Minimum gap between resends. */
export const RESEND_COOLDOWN_MS = 60 * 1000;
/** Resends allowed per challenge. */
export const MAX_RESENDS = 3;

// ONE message for wrong / expired / already-consumed / unknown. Distinguishing them would turn the
// endpoint into an oracle telling an attacker whether a challenge is still live.
export const INVALID_CODE_MESSAGE = "That code is incorrect or has expired.";

/**
 * Thrown as 410 Gone when the challenge no longer exists — burned by too many wrong codes, expired,
 * already used, or never there.
 *
 * Deliberately DISTINCT from INVALID_CODE_MESSAGE, and the distinction is a usability fix, not a
 * weakening. While a challenge is alive, wrong / expired / consumed stay indistinguishable so the
 * endpoint is no oracle. Once it is gone there is nothing left to probe: the only possible next
 * move is to sign in again, and saying so is the difference between a user retrying and a user
 * stuck on a dead screen where neither Verify nor Resend can ever work again.
 */
export const CHALLENGE_ENDED_MESSAGE =
  "For your security, that sign-in attempt has ended. Please sign in again.";
export const TOO_MANY_ATTEMPTS_MESSAGE =
  "Too many incorrect codes. For your security, please sign in again.";

/** 410 Gone — the caller must restart the sign-in, not retry. */
export function challengeEnded(message = CHALLENGE_ENDED_MESSAGE): HttpError {
  return new HttpError(410, message);
}

/**
 * 6 digits from a CSPRNG.
 *
 * `randomInt` is uniform and unpredictable; `Math.random` is neither and must never be used here.
 * padStart keeps leading zeros, so "000123" stays six characters rather than becoming "123".
 */
export function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * "john.smith@acme.com" -> "j•••@acme.com".
 *
 * Shown so the user knows WHICH mailbox to open, without the page restating an address an onlooker
 * could read. The mask is fixed-width, so it never leaks the local part's length either.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

/**
 * SHA-256 of the challenge cookie's raw token — only the hash is stored, mirroring how password
 * reset tokens are handled.
 *
 * A fast hash is correct HERE (and wrong for the 6-digit code) because the token is 32 random
 * bytes: there is no dictionary and no enumeration that reaches it.
 */
export function hashChallengeToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** When the next resend becomes allowed, given the last send. Server-derived; the UI only counts down. */
function resendAvailableAt(lastSentAt: Date): Date {
  return new Date(lastSentAt.getTime() + RESEND_COOLDOWN_MS);
}

export interface CreateChallengeInput {
  principalId: string;
  principalType: Actor;
  /** The REAL address. Snapshotted on the row so a later account email change cannot redirect it. */
  email: string;
  /** Greeting for the OTP email, snapshotted so a resend addresses the user identically. */
  firstName: string;
  /** The login's "remember me", carried across so the eventual session honours it. */
  remember: boolean;
  ip?: string;
  userAgent?: string;
}

/**
 * Everything the browser is allowed to know about a pending challenge.
 *
 * Both clocks are expressed as SECONDS REMAINING, never as absolute timestamps, and that is a
 * correctness requirement rather than a formatting preference. An absolute instant is only
 * meaningful to a client whose clock agrees with ours: a browser running a few minutes fast would
 * read a real 60s cooldown as already elapsed, and one running slow would keep Resend disabled past
 * the challenge's own expiry — with no way left to obtain a working code. A duration is immune,
 * because the page measures it with its own elapsed time and never has to agree with us about what
 * time it is.
 *
 * A refresh still resumes the true remaining cooldown: the page re-asks, and the server recomputes
 * these from `lastSentAt`.
 */
export interface PublicChallenge {
  /** MASKED — safe to send to the browser. */
  email: string;
  /** Seconds until the code stops working. 0 means it already has. */
  expiresInSeconds: number;
  /** Seconds until "Resend code" is allowed. 0 means now. */
  resendInSeconds: number;
  resendsRemaining: number;
}

export interface PendingChallenge extends PublicChallenge {
  /** The raw cookie value. Returned ONCE, to the controller, and never stored. */
  challengeToken: string;
}

/** Whole seconds from `now` to `at`, never negative. Rounded UP so nothing reads as ready early. */
function secondsUntil(at: Date, now: Date): number {
  return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 1000));
}

function toPublic(
  row: {
    email: string;
    expiresAt: Date;
    lastSentAt: Date;
    resendCount: number;
  },
  now = new Date(),
): PublicChallenge {
  return {
    email: maskEmail(row.email),
    expiresInSeconds: secondsUntil(row.expiresAt, now),
    resendInSeconds: secondsUntil(resendAvailableAt(row.lastSentAt), now),
    resendsRemaining: Math.max(0, MAX_RESENDS - row.resendCount),
  };
}

/**
 * Open a challenge and email its code.
 *
 * Fails CLOSED: if the email cannot be sent, the row is destroyed and a 502 is thrown, so a user is
 * never parked on an OTP step holding a code that was never delivered.
 */
export async function createChallenge(input: CreateChallengeInput): Promise<PendingChallenge> {
  // One live challenge per principal — a second login attempt supersedes the first rather than
  // leaving two independently guessable challenges open at once.
  await challengeRepo.deleteForPrincipal(input.principalId, input.principalType);

  const challengeToken = crypto.randomBytes(32).toString("hex");
  const code = generateCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);

  const row = await challengeRepo.create({
    tokenHash: hashChallengeToken(challengeToken),
    principalId: input.principalId,
    principalType: input.principalType,
    email: input.email,
    firstName: input.firstName,
    // bcrypt, NOT SHA-256: a 6-digit code has only 10^6 preimages, so a fast hash would be
    // reversible from a database dump in milliseconds.
    codeHash: await hashPassword(code),
    // Written explicitly rather than left to the schema defaults, so the public view below is
    // built from values this function KNOWS instead of whatever the driver echoes back.
    attempts: 0,
    resendCount: 0,
    remember: input.remember,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    expiresAt,
    lastSentAt: now,
  });

  // Destroy-on-failure is right HERE and only here: the row is brand new, so there is nothing to
  // lose by removing it, and leaving it would park the user on an OTP step holding a code that was
  // never delivered. (resendChallenge must not do this — see there.)
  try {
    await sendCode(input.email, input.firstName, code);
  } catch (e) {
    await challengeRepo.deleteById(row.id);
    throw e;
  }

  return {
    challengeToken,
    ...toPublic({ email: input.email, expiresAt, lastSentAt: now, resendCount: 0 }, now),
  };
}

/**
 * Send one code. Throws 502 on failure and changes NOTHING — the caller decides what a failed send
 * means for the row, because the answer differs between the two callers (see each).
 *
 * `force: true` matches the password-reset and password-changed emails: a disabled template must
 * never suppress a security-critical message — and here it would lock every user out of the app.
 */
async function sendCode(to: string, firstName: string, code: string): Promise<void> {
  try {
    await sendTemplatedEmail(
      "auth.two_factor_code",
      to,
      { firstName, code, expiryMinutes: CHALLENGE_TTL_MS / 60_000 },
      { force: true },
    );
  } catch (e) {
    // The message only — never the code, and never the rendered body.
    console.error("2FA code email failed:", e instanceof Error ? e.message : e);
    throw new HttpError(502, "Couldn't send your verification code. Please try again.");
  }
}

/**
 * The pending challenge for this browser, if any — powers GET /auth/2fa/challenge.
 *
 * Returns ONLY masked email, expiry and resend state. Never the code, the code hash, the challenge
 * token, the principal id or the principal type. It does not count as an attempt and does not
 * extend the expiry, so polling or refreshing the page can never keep a challenge alive.
 */
export async function readChallenge(token: string): Promise<PublicChallenge | null> {
  const row = await findLive(token);
  return row ? toPublic(row) : null;
}

/**
 * Look up a challenge by its raw cookie token, pruning it if it has already elapsed.
 *
 * Mirrors sessionService.findActive — lazy cleanup on touch, with the periodic sweep as backstop.
 */
async function findLive(token: string) {
  if (!token) return null;
  const row = await challengeRepo.findByTokenHash(hashChallengeToken(token));
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await challengeRepo.deleteById(row.id);
    return null;
  }
  return row;
}

/**
 * Check a submitted code and CONSUME the challenge.
 *
 * Returns only what the caller needs to open a session. It deliberately does NOT re-read
 * `emailTwoFactorEnabled`: an issued challenge stays completable even if an administrator turns 2FA
 * off mid-flight, which is exactly the "nobody gets stranded" outcome the design calls for. Adding
 * a setting check here would create the stranding it is meant to prevent.
 */
export async function verifyChallenge(
  token: string,
  code: string,
): Promise<{ principalId: string; principalType: Actor; remember: boolean }> {
  const row = await findLive(token);
  // Nothing to verify against — the caller has to start over, so say so instead of leaving them on
  // a step where every button is already dead.
  if (!row) throw challengeEnded();

  // The row carries an email snapshot, so a failure is attributable without a second lookup.
  const actor: AuditActor = {
    id: row.principalId,
    email: row.email,
    type: row.principalType as AuditActor["type"],
  };

  if (!(await verifyPassword(code, row.codeHash))) {
    const attempts = await challengeRepo.incrementAttempts(row.id);
    // The row vanished between the read above and the increment — a concurrent verify consumed it,
    // or the sweep removed it. Report the ordinary ended-challenge answer rather than letting a
    // database error surface, and say nothing about which of those happened.
    if (attempts === null) throw challengeEnded();
    if (attempts >= MAX_ATTEMPTS) {
      // Burned. The attacker must prove the password again to get another challenge — and the user
      // is TOLD that, because from here Verify and Resend can both only ever fail.
      await challengeRepo.deleteById(row.id);
      // Metadata carries the ATTEMPT COUNT only — never the submitted code.
      auditService.record({ actor, action: "auth.2fa_blocked", metadata: { attempts } });
      throw challengeEnded(TOO_MANY_ATTEMPTS_MESSAGE);
    }
    auditService.record({ actor, action: "auth.2fa_failed", metadata: { attempts } });
    // Still live, so still no oracle: wrong and expired read identically.
    throw new HttpError(401, INVALID_CODE_MESSAGE);
  }

  // Atomic single-use claim. Of two concurrent requests carrying the same correct code, exactly one
  // deletes the row and proceeds; the loser is rejected like any invalid code. Claiming BEFORE the
  // session is created is what stops a race producing two sessions.
  if (!(await challengeRepo.claimById(row.id))) {
    throw challengeEnded();
  }

  return {
    principalId: row.principalId,
    principalType: row.principalType as Actor,
    remember: row.remember,
  };
}

/**
 * Issue a fresh code on the SAME challenge row.
 *
 * `lastSentAt` and `expiresAt` are written TOGETHER. Re-basing the expiry is the point: without it,
 * a resend at T+9:00 would deliver a code that expired 60 seconds later, and the user would burn
 * their remaining resends chasing it. Each individual code still lives at most CHALLENGE_TTL_MS,
 * and MAX_RESENDS bounds the whole challenge at roughly 40 minutes.
 */
export async function resendChallenge(token: string): Promise<PublicChallenge> {
  const row = await findLive(token);
  // THE bug this replaced: after five wrong codes the challenge is gone, so this returned the same
  // "incorrect or expired" as a bad code — the Resend button appeared to do nothing at all, for
  // ever, with no way forward short of reloading the page.
  if (!row) throw challengeEnded();

  if (Date.now() < resendAvailableAt(row.lastSentAt).getTime()) {
    throw new HttpError(429, "Please wait a moment before requesting another code.");
  }
  if (row.resendCount >= MAX_RESENDS) {
    throw new HttpError(429, "You've requested too many codes. Please sign in again.");
  }

  const code = generateCode();

  // SEND FIRST, commit second — the opposite order to createChallenge, deliberately.
  //
  // Here a live code the user may already be holding is at stake. Committing first overwrites
  // `codeHash`, so a send that then fails had destroyed a code that was working, and the row with
  // it: the user was told "please try again" on a screen where nothing could ever succeed again,
  // having just lost the one code in their inbox. Sending first means a failure leaves the row
  // exactly as it was — the existing code still verifies, the cooldown has not moved, and Resend
  // can simply be pressed again.
  //
  // The reverse risk, a send that succeeds and a write that then fails, costs only an email whose
  // code the row never adopted; the previous code still works, so the user is never stranded.
  //
  // The snapshotted name, so the resend greets the user exactly as the first code did.
  await sendCode(row.email, row.firstName, code);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const resendCount = row.resendCount + 1;

  await challengeRepo.update(row.id, {
    codeHash: await hashPassword(code),
    attempts: 0,
    resendCount,
    lastSentAt: now,
    expiresAt,
  });

  return toPublic({ email: row.email, expiresAt, lastSentAt: now, resendCount }, now);
}

/** Abandon a pending challenge ("Back to sign in"). Idempotent; never touches any session. */
export async function cancelChallenge(token: string): Promise<void> {
  if (!token) return;
  await challengeRepo.deleteByTokenHash(hashChallengeToken(token));
}

/**
 * Delete challenges whose lifetime has already elapsed. Returns how many went.
 *
 * NOT a retention rule: every one of these rows is already unusable, because `findLive` refuses an
 * elapsed `expiresAt`. This only stops a dead row — and the IP address on it — sitting there
 * forever because nobody happened to touch it again.
 */
export async function purgeExpiredChallenges(now = new Date()): Promise<number> {
  const { count } = await challengeRepo.deleteExpired(now);
  return count;
}
