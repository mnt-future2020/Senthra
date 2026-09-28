import { describe, expect, it } from "vitest";

import {
  STORAGE_PROBE_MESSAGE,
  STORAGE_PROBE_RATE_LIMIT,
  storageProbeLimiter,
  testEmailLimiter,
} from "./rateLimit.middleware.js";

// "Test connection" and "Set up upload presets" once shared the test-email bucket (5 per 10 min),
// so a first-time storage setup — test, save, test again, set up presets, test the other provider —
// ran into "Too many test emails" on a storage button. Same reason to limit, own bucket, own words.
describe("storage probe rate limit", () => {
  it("has its own bucket, separate from the test email", () => {
    expect(storageProbeLimiter).not.toBe(testEmailLimiter);
  });

  it("covers a first-time setup session with room to retry", () => {
    const per10Min = STORAGE_PROBE_RATE_LIMIT.limit * ((10 * 60 * 1000) / STORAGE_PROBE_RATE_LIMIT.windowMs);
    expect(per10Min).toBeGreaterThanOrEqual(15);
  });

  it("speaks about storage checks, not emails, when it refuses", () => {
    expect(STORAGE_PROBE_MESSAGE).toMatch(/storage/i);
    expect(STORAGE_PROBE_MESSAGE).not.toMatch(/email/i);
  });
});
