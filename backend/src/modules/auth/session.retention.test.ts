import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { deleteMany } = vi.hoisted(() => ({ deleteMany: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({ prisma: { session: { deleteMany } } }));
// session.service reaches for realtime to hang up on revoked devices; this suite is about the
// expiry sweep, which touches no live socket. Stubbed so it doesn't drag socket.io + env in.
vi.mock("../../lib/realtime.js", () => ({
  revokeSessionSockets: vi.fn(),
  revokePrincipalSockets: vi.fn(),
}));

import { deleteExpired } from "./session.repository.js";
import { purgeExpiredSessions } from "./session.service.js";
import { startExpiredSessionSweep } from "./session.sweep.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");

beforeEach(() => {
  deleteMany.mockReset().mockResolvedValue({ count: 0 });
});

describe("session retention — expired-row cleanup", () => {
  it("deletes ONLY rows whose expiresAt is already in the past", async () => {
    await deleteExpired(NOW);
    expect(deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: NOW } } });
  });

  it("never filters on anything but expiry — no principal, no age, no status", async () => {
    await deleteExpired(NOW);
    const where = deleteMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(Object.keys(where)).toEqual(["expiresAt"]);
    // `lt`, not `lte` or a computed cutoff: a session expiring exactly now is still live.
    expect(where.expiresAt).toEqual({ lt: NOW });
  });

  it("introduces no retention period of its own — the cutoff IS the row's own expiresAt", async () => {
    // Two passes an hour apart must use each pass's own clock and nothing else. If a period were
    // ever subtracted here, the cutoff would stop matching the clock it was handed.
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    await deleteExpired(NOW);
    await deleteExpired(later);
    expect(deleteMany.mock.calls[0][0].where.expiresAt.lt).toEqual(NOW);
    expect(deleteMany.mock.calls[1][0].where.expiresAt.lt).toEqual(later);
  });

  it("reports how many rows went", async () => {
    deleteMany.mockResolvedValue({ count: 7 });
    expect(await purgeExpiredSessions(NOW)).toBe(7);
  });

  it("is a no-op when nothing has expired", async () => {
    expect(await purgeExpiredSessions(NOW)).toBe(0);
  });
});

describe("startExpiredSessionSweep", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not sweep on start — only on the interval", () => {
    const stop = startExpiredSessionSweep(1000);
    expect(deleteMany).not.toHaveBeenCalled();
    stop();
  });

  it("sweeps once per interval and stops when told to", async () => {
    const stop = startExpiredSessionSweep(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deleteMany).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(deleteMany).toHaveBeenCalledTimes(2);
  });

  it("survives a failing pass — a dead database must not take the process down", async () => {
    deleteMany.mockRejectedValue(new Error("mongo down"));
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a));

    const stop = startExpiredSessionSweep(1000);
    await vi.advanceTimersByTimeAsync(1000);
    // Still ticking after the failure.
    deleteMany.mockResolvedValue({ count: 0 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    stop();
    spy.mockRestore();
  });
});
