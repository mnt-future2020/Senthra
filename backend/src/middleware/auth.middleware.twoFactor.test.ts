import { describe, expect, it, vi } from "vitest";

/**
 * The single most important boundary in the 2FA feature: a pending challenge is NOT a session.
 *
 * The challenge cookie is scoped to /auth/2fa, so a correctly-behaving browser never even sends it
 * elsewhere. This locks the server side of that: even if the cookie is replayed by hand onto a
 * protected route, requireAuth must refuse it, because it reads the ACCESS cookie and nothing else.
 */

vi.mock("#modules/auth/admin.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/user/user.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/user/user-warehouse.repository.js", () => ({ listWarehouseIds: vi.fn() }));
vi.mock("#modules/customer/customer.repository.js", () => ({ findLoginById: vi.fn() }));
vi.mock("#modules/auth/session.service.js", () => ({
  findActive: vi.fn(),
  sessionMatchesPrincipal: vi.fn(),
}));

import { requireAuth } from "./auth.middleware.js";
import { ACCESS_COOKIE, TWO_FACTOR_COOKIE } from "../utils/cookies.js";
import * as sessionService from "#modules/auth/session.service.js";

type Res = {
  statusCode?: number;
  body?: unknown;
  status: (c: number) => Res;
  json: (b: unknown) => Res;
};

function mockRes(): Res {
  const res: Res = {
    status(c) {
      res.statusCode = c;
      return res;
    },
    json(b) {
      res.body = b;
      return res;
    },
  };
  return res;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (cookies: Record<string, string>): Promise<{ res: Res; next: any }> => {
  const res = mockRes();
  const next = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await requireAuth({ cookies, headers: {} } as any, res as any, next);
  return { res, next };
};

describe("a 2FA challenge cookie grants no access", () => {
  it("is rejected with 401 on a protected route", async () => {
    const { res, next } = await run({ [TWO_FACTOR_COOKIE]: "a-valid-looking-challenge-token" });

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    // It never even reaches a session lookup — there is no token to verify.
    expect(sessionService.findActive).not.toHaveBeenCalled();
  });

  it("is still rejected when paired with an empty access cookie", async () => {
    const { res, next } = await run({
      [ACCESS_COOKIE]: "",
      [TWO_FACTOR_COOKIE]: "a-valid-looking-challenge-token",
    });

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("is not accepted as a bearer token either", async () => {
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { cookies: {}, headers: { authorization: "Bearer a-challenge-token" } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
      next,
    );

    // It reaches token verification and fails there — a challenge token is not a signed JWT.
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
