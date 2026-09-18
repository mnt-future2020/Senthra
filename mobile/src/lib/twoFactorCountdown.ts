// The two-factor countdowns, as pure functions — ported from the web's TwoFactorStep.tsx so the
// phone and the browser count the same challenge down the same way.
//
// Pure, and its own module, for the reason every ported rule in this folder is: the screen around it
// is JSX, and this is the part that decides whether an engineer can get a working code at all.

export interface TwoFactorDurations {
  /** Seconds until Resend unlocks, as the SERVER measured them. */
  resendInSeconds: number;
  /** Seconds until the challenge itself dies, as the SERVER measured them. */
  expiresInSeconds: number;
}

/**
 * The server's remaining-seconds, re-expressed as instants on THIS DEVICE's clock.
 *
 * Anchoring at the moment the server answered is the whole point. The server sends durations
 * precisely so the two clocks never have to agree: everything is then measured as time elapsed here
 * since `atMs`, so a handset running minutes fast or slow still counts down the cooldown and the
 * expiry the server is actually enforcing. A phone's clock is if anything likelier to be wrong than
 * a desktop's — it can be set by hand, and it lands in a new timezone with the engineer.
 *
 * Re-anchored on every fresh description of the challenge (mount, resume, resend), so returning to
 * this screen resumes the real remainder rather than restarting a fresh 60s.
 */
export function deadlinesFrom(
  pending: TwoFactorDurations,
  atMs: number,
): { resendAtMs: number; expiresAtMs: number } {
  return {
    resendAtMs: atMs + pending.resendInSeconds * 1000,
    expiresAtMs: atMs + pending.expiresInSeconds * 1000,
  };
}

/** Whole seconds from now to a deadline, never negative. Rounded UP so nothing unlocks a tick early. */
export function secondsUntil(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

/** 605 -> "10:05". Seconds always two digits, so the line doesn't jitter as it counts down. */
export function formatCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The instant to measure elapsed time from: the later of the ticking clock and the anchor.
 *
 * The tick and the anchor are read from the clock at different moments, so either can be the staler
 * of the two, and `secondsUntil` rounds any leftover fraction UP. Unclamped, a resend answered
 * between ticks leaves `now` BEHIND the fresh anchor and renders "Resend in 61s" for a cooldown the
 * server capped at 60. Clamping makes the countdown start at exactly what the server said and only
 * ever fall.
 */
export function elapsedFrom(nowMs: number, receivedAtMs: number): number {
  return Math.max(nowMs, receivedAtMs);
}
