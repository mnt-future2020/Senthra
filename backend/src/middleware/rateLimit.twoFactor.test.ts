import { describe, expect, it } from "vitest";

import { AUTH_RATE_LIMITS } from "./rateLimit.middleware.js";
import { MAX_RESENDS } from "#modules/auth/twoFactor.service.js";

type Budget = { readonly windowMs: number; readonly limit: number };

/** Requests an IP may make in 15 minutes, whatever window the budget itself uses. */
const per15Min = (b: Budget): number => b.limit * ((15 * 60 * 1000) / b.windowMs);

// These limiters sit in front of SHARED EGRESS — an office NAT or a mobile carrier puts many
// legitimate users behind one address. Sizing them for a single user is what turns a brute-force
// control into an outage for everyone in the building.
describe("2FA IP rate limits", () => {
  it("lets an IP finish every login it is allowed to start", () => {
    // A tighter verify budget than login meant an IP could be emailed a code and then be blocked
    // from ever submitting it — locked out by a limiter rather than by anything the user did.
    expect(per15Min(AUTH_RATE_LIMITS.twoFactorVerify)).toBeGreaterThanOrEqual(per15Min(AUTH_RATE_LIMITS.login));
  });

  it("gives more than two users' full resend allowance", () => {
    // Two colleagues on one connection must not exhaust the bucket for everyone behind it.
    expect(per15Min(AUTH_RATE_LIMITS.twoFactorResend)).toBeGreaterThan(2 * MAX_RESENDS);
  });

  it("keeps the status check generous enough to survive ordinary page refreshes", () => {
    // The login page calls it on every mount; sharing verify's budget would let refreshes burn the
    // verification allowance.
    expect(per15Min(AUTH_RATE_LIMITS.twoFactorStatus)).toBeGreaterThanOrEqual(per15Min(AUTH_RATE_LIMITS.twoFactorVerify));
  });

  // The probe fires on EVERY login-page mount, by everyone behind the address — including signed-in
  // users bouncing off /login who are not doing 2FA at all. Sized per office, not per person.
  it("survives a whole office loading the login page", () => {
    // 50 people, a handful of loads each, inside one window.
    expect(per15Min(AUTH_RATE_LIMITS.twoFactorStatus)).toBeGreaterThanOrEqual(50 * 4);
  });

  // Cancel is a DELIBERATE user action ("Back to sign in"); the status probe is automatic. Sharing
  // one bucket let automatic traffic spend the budget for the deliberate act — and a refused cancel
  // leaves the challenge alive, so the next visit to /login lands back on the OTP step.
  it("keeps cancel in its own bucket", () => {
    expect(AUTH_RATE_LIMITS.twoFactorCancel).not.toBe(AUTH_RATE_LIMITS.twoFactorStatus);
    expect(per15Min(AUTH_RATE_LIMITS.twoFactorCancel)).toBeGreaterThan(2 * MAX_RESENDS);
  });

  it("still rate-limits — none of these is uncapped", () => {
    for (const b of Object.values(AUTH_RATE_LIMITS)) {
      expect(b.limit).toBeGreaterThan(0);
      expect(Number.isFinite(b.limit)).toBe(true);
      expect(b.windowMs).toBeGreaterThan(0);
    }
  });
});
