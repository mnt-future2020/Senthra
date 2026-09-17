import { describe, expect, it } from "vitest";

import { deadlinesFrom, formatCountdown, secondsUntil } from "./TwoFactorStep";

// The server sends DURATIONS, and the page anchors them against its own clock the moment they
// arrive. Both halves matter: the duration is what survives a wrong device clock, and the anchor is
// what makes the countdown resume correctly after a refresh instead of restarting a fresh 60s.

describe("deadlinesFrom", () => {
  it("anchors the server's remaining seconds to this browser's clock", () => {
    const at = 1_000_000_000_000;
    const d = deadlinesFrom({ resendInSeconds: 60, expiresInSeconds: 600 }, at);
    expect(d.resendAtMs).toBe(at + 60_000);
    expect(d.expiresAtMs).toBe(at + 600_000);
  });

  // THE CLOCK-SKEW CASE, and the reason the wire format is a duration at all.
  //
  // A device running four minutes slow used to read the server's absolute resendAvailableAt as
  // already long past — or, running slow the other way, as unreachable: Resend stayed locked past
  // the challenge's own 10-minute expiry, so there was no way left to get a code that worked.
  // Anchoring to whatever this clock says "now" is makes the absolute offset irrelevant.
  it("counts down the same on a device whose clock is wrong", () => {
    const pending = { resendInSeconds: 60, expiresInSeconds: 600 };
    const correct = deadlinesFrom(pending, 1_000_000_000_000);
    const fourMinutesSlow = deadlinesFrom(pending, 1_000_000_000_000 - 240_000);

    // 15 seconds of elapsed time, measured on each device's own clock.
    expect(secondsUntil(correct.resendAtMs, 1_000_000_000_000 + 15_000)).toBe(45);
    expect(secondsUntil(fourMinutesSlow.resendAtMs, 1_000_000_000_000 - 240_000 + 15_000)).toBe(45);
  });

  // THE REFRESH CASE: the server reports what is really left, so a reload resumes it.
  it("resumes the real remaining cooldown after a page refresh", () => {
    const at = 1_000_000_000_000;
    const d = deadlinesFrom({ resendInSeconds: 45, expiresInSeconds: 585 }, at);
    expect(secondsUntil(d.resendAtMs, at)).toBe(45);
  });
});

// The anchor is taken where the response LANDED, so it is always a shade earlier than the first
// render's clock reading. That ordering matters: elapsed time only grows, so a cooldown the server
// reports as finished reads as 0 and never as one more second. (Anchoring after the render instead
// put the deadline a fraction of a millisecond ahead, and secondsUntil rounds any fraction UP — a
// ready Resend button spent its first second labelled "Resend in 1s".)
describe("an anchor taken before the first render", () => {
  const receivedAt = 1_000_000_000_000;
  const firstRender = receivedAt + 1; // a hair later, as it always is in practice

  it("reports an elapsed cooldown as ready, not as one more second", () => {
    const d = deadlinesFrom({ resendInSeconds: 0, expiresInSeconds: 540 }, receivedAt);
    expect(secondsUntil(d.resendAtMs, firstRender)).toBe(0);
  });

  it("reports a live cooldown at its remaining value", () => {
    const d = deadlinesFrom({ resendInSeconds: 45, expiresInSeconds: 585 }, receivedAt);
    expect(secondsUntil(d.resendAtMs, firstRender)).toBe(45);
    expect(secondsUntil(d.expiresAtMs, firstRender)).toBe(585);
  });
});

// The ticking "now" and the anchor are read from the clock at different moments, so either can be
// the staler of the two. The component clamps with Math.max(now, receivedAtMs); these pin what that
// clamp is for, in both orderings.
describe("a tick that lags a fresh anchor", () => {
  it("never shows more time than the server granted", () => {
    // A resend answered between ticks: `now` is a second BEHIND the new anchor. Unclamped this
    // rounded up to 61s — a cooldown the server had capped at 60.
    const staleNow = 1_000_000_000_000;
    const receivedAt = staleNow + 900;
    const d = deadlinesFrom({ resendInSeconds: 60, expiresInSeconds: 600 }, receivedAt);

    expect(secondsUntil(d.resendAtMs, Math.max(staleNow, receivedAt))).toBe(60);
    expect(secondsUntil(d.expiresAtMs, Math.max(staleNow, receivedAt))).toBe(600);
  });

  it("still counts down normally once the clock catches up", () => {
    const receivedAt = 1_000_000_000_000;
    const d = deadlinesFrom({ resendInSeconds: 60, expiresInSeconds: 600 }, receivedAt);
    const later = receivedAt + 15_000;
    expect(secondsUntil(d.resendAtMs, Math.max(later, receivedAt))).toBe(45);
  });
});

describe("secondsUntil", () => {
  it("rounds up, so nothing unlocks a tick early", () => {
    const now = 1_000_000_000_000;
    expect(secondsUntil(now + 59_500, now)).toBe(60);
    expect(secondsUntil(now + 1, now)).toBe(1);
  });

  it("is 0 once the deadline has passed, and never negative", () => {
    const now = 1_000_000_000_000;
    expect(secondsUntil(now, now)).toBe(0);
    expect(secondsUntil(now - 60_000, now)).toBe(0);
    expect(secondsUntil(now - 86_400_000, now)).toBe(0);
  });
});

describe("formatCountdown", () => {
  it("pads the seconds so the line doesn't jitter as it ticks", () => {
    expect(formatCountdown(600)).toBe("10:00");
    expect(formatCountdown(605)).toBe("10:05");
    expect(formatCountdown(59)).toBe("0:59");
    expect(formatCountdown(0)).toBe("0:00");
  });
});
