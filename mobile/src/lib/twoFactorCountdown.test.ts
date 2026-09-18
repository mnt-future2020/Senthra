import { describe, expect, it } from "vitest";

import { deadlinesFrom, elapsedFrom, formatCountdown, secondsUntil } from "./twoFactorCountdown";

// The server sends DURATIONS, and the screen anchors them against its own clock the moment they
// arrive. Both halves matter: the duration is what survives a wrong device clock, and the anchor is
// what makes the countdown resume correctly when the app is reopened instead of restarting a fresh
// 60s. Ported from the web's twoFactorCountdown.test.ts — same rule, same expectations.

describe("deadlinesFrom", () => {
  it("anchors the server's remaining seconds to this device's clock", () => {
    const at = 1_000_000_000_000;
    const d = deadlinesFrom({ resendInSeconds: 60, expiresInSeconds: 600 }, at);
    expect(d.resendAtMs).toBe(at + 60_000);
    expect(d.expiresAtMs).toBe(at + 600_000);
  });

  // THE CLOCK-SKEW CASE, and the reason the wire format is a duration at all. A handset can be set
  // by hand and lands in a new timezone with the engineer, so this is likelier here than on a desk.
  it("counts down the same on a device whose clock is wrong", () => {
    const pending = { resendInSeconds: 60, expiresInSeconds: 600 };
    const correct = deadlinesFrom(pending, 1_000_000_000_000);
    const fourMinutesSlow = deadlinesFrom(pending, 1_000_000_000_000 - 240_000);

    // 15 seconds of elapsed time, measured on each device's own clock.
    expect(secondsUntil(correct.resendAtMs, 1_000_000_000_000 + 15_000)).toBe(45);
    expect(secondsUntil(fourMinutesSlow.resendAtMs, 1_000_000_000_000 - 240_000 + 15_000)).toBe(45);
  });

  // The resume path: the server reports what is genuinely left, not a fresh challenge.
  it("resumes the real remainder when the screen re-reads a live challenge", () => {
    const at = 5_000_000;
    const d = deadlinesFrom({ resendInSeconds: 44, expiresInSeconds: 584 }, at);
    expect(secondsUntil(d.resendAtMs, at)).toBe(44);
    expect(secondsUntil(d.expiresAtMs, at)).toBe(584);
  });
});

describe("secondsUntil", () => {
  it("never goes negative once the deadline has passed", () => {
    expect(secondsUntil(1_000, 9_999)).toBe(0);
  });

  it("rounds up, so nothing unlocks a tick early", () => {
    // 1 400ms left is still "2 seconds" — showing 1 would let Resend appear available first.
    expect(secondsUntil(1_400, 0)).toBe(2);
  });
});

describe("elapsedFrom", () => {
  // The tick and the anchor are read at different moments, so either can be the staler of the two.
  // Unclamped, a resend answered between ticks renders "Resend in 61s" for a 60s cooldown.
  it("never measures from before the anchor", () => {
    expect(elapsedFrom(900, 1_000)).toBe(1_000);
  });

  it("uses the clock once it has caught up", () => {
    expect(elapsedFrom(1_200, 1_000)).toBe(1_200);
  });

  it("keeps a fresh cooldown at exactly what the server said", () => {
    const anchor = 1_000;
    const d = deadlinesFrom({ resendInSeconds: 60, expiresInSeconds: 600 }, anchor);
    // A tick from just before the resend landed must not produce 61.
    expect(secondsUntil(d.resendAtMs, elapsedFrom(anchor - 100, anchor))).toBe(60);
  });
});

describe("formatCountdown", () => {
  it("pads the seconds so the line does not jitter as it falls", () => {
    expect(formatCountdown(605)).toBe("10:05");
    expect(formatCountdown(600)).toBe("10:00");
    expect(formatCountdown(59)).toBe("0:59");
    expect(formatCountdown(0)).toBe("0:00");
  });
});
