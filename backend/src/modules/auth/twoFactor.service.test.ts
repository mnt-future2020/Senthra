import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the 2FA challenge lifecycle. The repository is mocked, so these exercise the
// service's branching and — crucially — its SECRET HANDLING: what is hashed, what is returned and
// what is never allowed to escape.

vi.mock("./twoFactor.repository.js", () => ({
  create: vi.fn(),
  findByTokenHash: vi.fn(),
  update: vi.fn(),
  claimById: vi.fn(),
  deleteById: vi.fn(),
  deleteByTokenHash: vi.fn(),
  deleteForPrincipal: vi.fn(),
  incrementAttempts: vi.fn(),
  deleteExpired: vi.fn(),
}));
vi.mock("#modules/email/email.service.js", () => ({ sendTemplatedEmail: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as repo from "./twoFactor.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
import { hashPassword } from "../../utils/password.js";
import {
  CHALLENGE_TTL_MS,
  cancelChallenge,
  createChallenge,
  generateCode,
  hashChallengeToken,
  CHALLENGE_ENDED_MESSAGE,
  INVALID_CODE_MESSAGE,
  MAX_ATTEMPTS,
  MAX_RESENDS,
  maskEmail,
  purgeExpiredChallenges,
  readChallenge,
  RESEND_COOLDOWN_MS,
  resendChallenge,
  TOO_MANY_ATTEMPTS_MESSAGE,
  verifyChallenge,
} from "./twoFactor.service.js";

const BASE = {
  principalId: "u1",
  principalType: "user" as const,
  email: "jane@acme.com",
  firstName: "Jane",
  remember: true,
};

async function liveRow(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    principalId: "u1",
    principalType: "user",
    email: "jane@acme.com",
    firstName: "Jane",
    codeHash: await hashPassword("123456"),
    attempts: 0,
    resendCount: 0,
    lastSentAt: new Date(Date.now() - 120_000),
    remember: true,
    expiresAt: new Date(Date.now() + 300_000),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(repo.deleteForPrincipal).mockResolvedValue({ count: 0 });
  vi.mocked(repo.create).mockImplementation(async (data) => ({ id: "c1", ...data }) as never);
  vi.mocked(repo.claimById).mockResolvedValue(true);
  vi.mocked(repo.incrementAttempts).mockResolvedValue(1);
  vi.mocked(sendTemplatedEmail).mockResolvedValue(undefined);
});

describe("policy constants", () => {
  it("match the approved policy exactly", () => {
    expect(CHALLENGE_TTL_MS).toBe(10 * 60 * 1000);
    expect(MAX_ATTEMPTS).toBe(5);
    expect(RESEND_COOLDOWN_MS).toBe(60 * 1000);
    expect(MAX_RESENDS).toBe(3);
    // One message for wrong / expired / consumed, so the endpoint is never an oracle.
    expect(INVALID_CODE_MESSAGE).toBe("That code is incorrect or has expired.");
  });
});

describe("generateCode", () => {
  it("always returns exactly 6 digits, including leading zeros", () => {
    for (let i = 0; i < 1000; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });
});

describe("maskEmail", () => {
  it("keeps only the first character of the local part", () => {
    expect(maskEmail("john.smith@acme.com")).toBe("j•••@acme.com");
  });
  it("uses a fixed-width mask, so it never leaks the local part's length", () => {
    expect(maskEmail("a@acme.com")).toBe("a•••@acme.com");
    expect(maskEmail("averylonglocalpart@acme.com")).toBe("a•••@acme.com");
  });
  it("fully masks a value with no @", () => {
    expect(maskEmail("nonsense")).toBe("•••");
  });
});

describe("createChallenge", () => {
  it("supersedes any existing challenge for the principal", async () => {
    await createChallenge(BASE);
    expect(repo.deleteForPrincipal).toHaveBeenCalledWith("u1", "user");
  });

  it("stores only a bcrypt hash of the code, never the code itself", async () => {
    await createChallenge(BASE);
    const data = vi.mocked(repo.create).mock.calls[0][0] as unknown as { codeHash: string };
    expect(data.codeHash).toMatch(/^\$2[aby]\$/);
    const vars = vi.mocked(sendTemplatedEmail).mock.calls[0][2] as { code: string };
    expect(data.codeHash).not.toContain(vars.code);
  });

  it("stores the SHA-256 of the challenge token, never the token", async () => {
    const result = await createChallenge(BASE);
    const data = vi.mocked(repo.create).mock.calls[0][0] as unknown as { tokenHash: string };
    expect(data.tokenHash).toBe(hashChallengeToken(result.challengeToken));
    expect(data.tokenHash).not.toBe(result.challengeToken);
  });

  it("snapshots the email and the first name onto the row", async () => {
    await createChallenge(BASE);
    const data = vi.mocked(repo.create).mock.calls[0][0] as unknown as {
      email: string;
      firstName: string;
    };
    expect(data.email).toBe("jane@acme.com");
    // Snapshotted so a RESEND greets the user with the same name the first code did.
    expect(data.firstName).toBe("Jane");
  });

  it("returns a MASKED email, never the raw address", async () => {
    const result = await createChallenge(BASE);
    expect(result.email).toBe("j•••@acme.com");
  });

  it("emails the code forced, so a disabled template cannot lock users out", async () => {
    await createChallenge(BASE);
    const [key, to, vars, opts] = vi.mocked(sendTemplatedEmail).mock.calls[0];
    expect(key).toBe("auth.two_factor_code");
    expect(to).toBe("jane@acme.com");
    expect((vars as { code: string }).code).toMatch(/^\d{6}$/);
    expect((vars as { firstName: string }).firstName).toBe("Jane");
    expect(opts).toEqual({ force: true });
  });

  it("deletes the challenge and throws 502 when the email cannot be sent", async () => {
    vi.mocked(sendTemplatedEmail).mockRejectedValue(new Error("smtp down"));
    await expect(createChallenge(BASE)).rejects.toMatchObject({ status: 502 });
    // Never leave a challenge holding a code the user never received.
    expect(repo.deleteById).toHaveBeenCalledWith("c1");
  });

  it("exposes a resend cooldown the client can trust", async () => {
    const result = await createChallenge(BASE);
    expect(result.resendInSeconds).toBeGreaterThan(0);
    expect(result.resendInSeconds).toBeLessThanOrEqual(RESEND_COOLDOWN_MS / 1000);
    expect(result.resendsRemaining).toBe(MAX_RESENDS);
  });
});

describe("readChallenge", () => {
  it("returns masked email, expiry and resend state for a live challenge", async () => {
    const row = await liveRow();
    vi.mocked(repo.findByTokenHash).mockResolvedValue(row as never);
    const result = await readChallenge("tok");
    expect(result).toEqual({
      email: "j•••@acme.com",
      // Durations, not instants — see PublicChallenge. `liveRow` sets expiresAt 300s out and
      // lastSentAt 120s ago, so the 60s cooldown has already elapsed.
      expiresInSeconds: 300,
      resendInSeconds: 0,
      resendsRemaining: 3,
    });
  });

  // A browser whose clock is wrong must still see the real remaining time, so nothing the server
  // sends may be an absolute instant the client would have to agree with.
  it("describes both clocks as durations, never as timestamps", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow()) as never);
    const result = await readChallenge("tok");
    expect(typeof result!.expiresInSeconds).toBe("number");
    expect(typeof result!.resendInSeconds).toBe("number");
    for (const v of Object.values(result!)) expect(v).not.toBeInstanceOf(Date);
  });

  // The whole point of the status endpoint: after a refresh the UI must resume the REAL cooldown.
  it("reports a cooldown derived from the server's lastSentAt, not from now", async () => {
    const lastSentAt = new Date(Date.now() - 15_000);
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow({ lastSentAt })) as never);
    const result = await readChallenge("tok");
    // ~45s left, not a fresh 60s.
    expect(result!.resendInSeconds).toBeGreaterThan(40);
    expect(result!.resendInSeconds).toBeLessThan(50);
  });

  it("never returns the code, its hash, the principal or the token", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow()) as never);
    const result = await readChallenge("tok");
    const keys = Object.keys(result!);
    expect(keys.sort()).toEqual(
      ["email", "expiresInSeconds", "resendInSeconds", "resendsRemaining"].sort(),
    );
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("codeHash");
    expect(serialised).not.toContain("u1");
    expect(serialised).not.toContain("jane@acme.com");
  });

  it("returns null and prunes the row when expired", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue(
      (await liveRow({ expiresAt: new Date(Date.now() - 1) })) as never,
    );
    await expect(readChallenge("tok")).resolves.toBeNull();
    expect(repo.deleteById).toHaveBeenCalledWith("c1");
  });

  it("returns null for an unknown token and for an empty token", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue(null);
    await expect(readChallenge("nope")).resolves.toBeNull();
    await expect(readChallenge("")).resolves.toBeNull();
    // An empty token must not even reach the database.
    expect(repo.findByTokenHash).toHaveBeenCalledTimes(1);
  });

  it("does not extend the expiry or touch attempts", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow()) as never);
    await readChallenge("tok");
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.incrementAttempts).not.toHaveBeenCalled();
  });
});

describe("verifyChallenge", () => {
  it("returns the principal and consumes the challenge on the correct code", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow()) as never);
    await expect(verifyChallenge("tok", "123456")).resolves.toEqual({
      principalId: "u1",
      principalType: "user",
      remember: true,
    });
    // Single-use: claimed (deleted) so the same code can never be replayed.
    expect(repo.claimById).toHaveBeenCalledWith("c1");
  });

  it("increments attempts and throws the generic message on a wrong code", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow()) as never);
    await expect(verifyChallenge("tok", "999999")).rejects.toMatchObject({
      status: 401,
      message: INVALID_CODE_MESSAGE,
    });
    expect(repo.incrementAttempts).toHaveBeenCalledWith("c1");
    expect(repo.deleteById).not.toHaveBeenCalled();
    expect(repo.claimById).not.toHaveBeenCalled();
  });

  // REGRESSION: the cap used to throw the same generic 401 as a wrong code, so the UI stayed on the
  // OTP step with a dead challenge — Verify kept failing and Resend silently did nothing, for ever.
  it("destroys the challenge at the cap and tells the caller to start over (410)", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow({ attempts: 4 })) as never);
    vi.mocked(repo.incrementAttempts).mockResolvedValue(MAX_ATTEMPTS);
    await expect(verifyChallenge("tok", "999999")).rejects.toMatchObject({
      status: 410,
      message: TOO_MANY_ATTEMPTS_MESSAGE,
    });
    expect(repo.deleteById).toHaveBeenCalledWith("c1");
  });

  it("410s a missing, unknown or expired challenge — there is nothing left to retry", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue(null);
    await expect(verifyChallenge("tok", "123456")).rejects.toMatchObject({
      status: 410,
      message: CHALLENGE_ENDED_MESSAGE,
    });

    vi.mocked(repo.findByTokenHash).mockResolvedValue(
      (await liveRow({ expiresAt: new Date(Date.now() - 1) })) as never,
    );
    await expect(verifyChallenge("tok", "123456")).rejects.toMatchObject({ status: 410 });
  });

  // The no-oracle rule still holds where it matters: while the challenge is ALIVE, a wrong code is
  // indistinguishable from an expired one.
  it("keeps a wrong code on a live challenge at the generic 401", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow()) as never);
    vi.mocked(repo.incrementAttempts).mockResolvedValue(2);
    await expect(verifyChallenge("tok", "999999")).rejects.toMatchObject({
      status: 401,
      message: INVALID_CODE_MESSAGE,
    });
  });

  it("audits a failure and a lockout, and never records the submitted code", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow()) as never);
    await expect(verifyChallenge("tok", "999999")).rejects.toThrow();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.2fa_failed", metadata: { attempts: 1 } }),
    );

    vi.mocked(repo.incrementAttempts).mockResolvedValue(MAX_ATTEMPTS);
    await expect(verifyChallenge("tok", "999999")).rejects.toThrow();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.2fa_blocked" }),
    );

    const serialised = JSON.stringify(vi.mocked(audit.record).mock.calls);
    expect(serialised).not.toContain("999999");
    expect(serialised).not.toContain("codeHash");
  });

  // The row can vanish between the read and the increment — a concurrent verify consumed it, or the
  // sweep removed an expired one. `update` threw Prisma P2025 there, which the error middleware maps
  // to a 404 "Not Found": a database-shaped answer out of a login endpoint, on a step whose client
  // only understands 401 and 410. It must be indistinguishable from any other ended challenge.
  it("normalises a challenge that disappears mid-increment to the generic ended answer", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow()) as never);
    vi.mocked(repo.incrementAttempts).mockResolvedValue(null);

    await expect(verifyChallenge("tok", "999999")).rejects.toMatchObject({
      status: 410,
      message: CHALLENGE_ENDED_MESSAGE,
    });

    // Says nothing about WHY it is gone, and never reaches the lockout audit.
    const serialised = JSON.stringify(vi.mocked(audit.record).mock.calls);
    expect(serialised).not.toContain("auth.2fa_blocked");
    expect(serialised).not.toContain("P2025");
  });

  // ---- THE CONCURRENCY INVARIANT -------------------------------------------------------------
  // Two requests carrying the SAME correct code must not both authenticate. The claim (an atomic
  // single-document delete) is what decides the winner; without it both would pass the bcrypt
  // comparison before either delete landed, and both would go on to open a session.
  describe("concurrent verification with the same correct code", () => {
    it("lets exactly one succeed and rejects the other", async () => {
      vi.mocked(repo.findByTokenHash).mockImplementation(async () => (await liveRow()) as never);

      // Model the database: the first deleteMany removes the row and reports 1; the second matches
      // nothing and reports 0.
      let claimed = false;
      vi.mocked(repo.claimById).mockImplementation(async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      });

      const results = await Promise.allSettled([
        verifyChallenge("tok", "123456"),
        verifyChallenge("tok", "123456"),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // The loser gets the ordinary generic message — it must not reveal that it lost a race.
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 410 });
      // Exactly one caller was authorised to open a session.
      expect(repo.claimById).toHaveBeenCalledTimes(2);
    });

    it("rejects a replay after the challenge has already been consumed", async () => {
      vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow()) as never);
      vi.mocked(repo.claimById).mockResolvedValue(false);
      await expect(verifyChallenge("tok", "123456")).rejects.toMatchObject({ status: 410 });
    });
  });
});

describe("resendChallenge", () => {
  it("issues a new code, resets attempts and RE-BASES the expiry from now", async () => {
    const row = await liveRow({ attempts: 3, resendCount: 1 });
    vi.mocked(repo.findByTokenHash).mockResolvedValue(row as never);
    const before = Date.now();

    await resendChallenge("tok");

    const [, data] = vi.mocked(repo.update).mock.calls[0] as unknown as [
      string,
      Record<string, never>,
    ];
    expect(data.attempts).toBe(0);
    expect(data.resendCount).toBe(2);
    // lastSentAt and expiresAt MUST move together. Writing only lastSentAt would hand the user a
    // code that inherits the OLD deadline — a resend at T+9min would expire 60s later.
    expect((data.lastSentAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((data.expiresAt as Date).getTime()).toBeGreaterThanOrEqual(before + CHALLENGE_TTL_MS - 5);
    // The previous code dies immediately.
    expect(data.codeHash).not.toBe(row.codeHash);
  });

  it("greets the user with the snapshotted name, not a generic fallback", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow()) as never);
    await resendChallenge("tok");
    const vars = vi.mocked(sendTemplatedEmail).mock.calls[0][2] as { firstName: string };
    expect(vars.firstName).toBe("Jane");
  });

  it("returns a cooldown and remaining count reflecting the new send", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow({ resendCount: 1 })) as never);
    const result = await resendChallenge("tok");
    expect(result.resendsRemaining).toBe(MAX_RESENDS - 2);
    expect(result.resendInSeconds).toBeGreaterThan(0);
    expect(result.resendInSeconds).toBeLessThanOrEqual(RESEND_COOLDOWN_MS / 1000);
    // The fresh code carries a full lifetime, not the old row's leftover deadline.
    expect(result.expiresInSeconds).toBeGreaterThan(CHALLENGE_TTL_MS / 1000 - 5);
  });

  it("refuses inside the 60s cooldown", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue(
      (await liveRow({ lastSentAt: new Date(Date.now() - 5_000) })) as never,
    );
    await expect(resendChallenge("tok")).rejects.toMatchObject({ status: 429 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("refuses past the resend cap", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue(
      (await liveRow({ resendCount: MAX_RESENDS })) as never,
    );
    await expect(resendChallenge("tok")).rejects.toMatchObject({ status: 429 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  // A resend is NOT a create: the user may already be holding a code that works. Writing the new
  // codeHash before the send meant a failed send had killed that code AND deleted the row, leaving
  // "please try again" on a screen where nothing could succeed. A failed resend must cost nothing.
  it("leaves the existing code and the challenge intact when the resend email fails", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow()) as never);
    vi.mocked(sendTemplatedEmail).mockRejectedValue(new Error("smtp down"));

    await expect(resendChallenge("tok")).rejects.toMatchObject({ status: 502 });

    // The code the user already has still verifies...
    expect(repo.update).not.toHaveBeenCalled();
    // ...and the challenge is still there to verify it against, or to resend from again.
    expect(repo.deleteById).not.toHaveBeenCalled();
    expect(repo.deleteByTokenHash).not.toHaveBeenCalled();
  });

  // The ordering that guarantees the above, asserted directly: nothing is written until the mail
  // server has accepted the message.
  it("sends before it writes, so a failure cannot half-apply", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue((await liveRow()) as never);
    const order: string[] = [];
    vi.mocked(sendTemplatedEmail).mockImplementation(async () => {
      order.push("send");
      return undefined as never;
    });
    vi.mocked(repo.update).mockImplementation(async () => {
      order.push("update");
      return undefined as never;
    });

    await resendChallenge("tok");

    expect(order).toEqual(["send", "update"]);
  });

  // THE reported bug: with the challenge already burned, Resend returned the same "incorrect or
  // expired" as a bad code, so the button looked broken and there was no way forward.
  it("410s instead of pretending a dead challenge can be resent", async () => {
    vi.mocked(repo.findByTokenHash).mockResolvedValue(null);
    await expect(resendChallenge("tok")).rejects.toMatchObject({
      status: 410,
      message: CHALLENGE_ENDED_MESSAGE,
    });
    expect(sendTemplatedEmail).not.toHaveBeenCalled();
  });
});

describe("cancelChallenge", () => {
  it("deletes by token hash", async () => {
    await cancelChallenge("tok");
    expect(repo.deleteByTokenHash).toHaveBeenCalledWith(hashChallengeToken("tok"));
  });

  it("is a harmless no-op for an empty token", async () => {
    await expect(cancelChallenge("")).resolves.toBeUndefined();
    expect(repo.deleteByTokenHash).not.toHaveBeenCalled();
  });
});

describe("purgeExpiredChallenges", () => {
  it("returns how many rows went", async () => {
    vi.mocked(repo.deleteExpired).mockResolvedValue({ count: 4 });
    await expect(purgeExpiredChallenges()).resolves.toBe(4);
  });
});
