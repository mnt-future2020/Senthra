import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, findForPrincipal, deleteManyBySids } = vi.hoisted(() => ({
  create: vi.fn(),
  findForPrincipal: vi.fn(),
  deleteManyBySids: vi.fn(),
}));
vi.mock("./session.repository.js", () => ({ create, findForPrincipal, deleteManyBySids }));

const { revokeSessionSockets, revokePrincipalSockets } = vi.hoisted(() => ({
  revokeSessionSockets: vi.fn(),
  revokePrincipalSockets: vi.fn(),
}));
vi.mock("../../lib/realtime.js", () => ({ revokeSessionSockets, revokePrincipalSockets }));

import { MAX_DEVICES, startSession } from "./session.service.js";

const PRINCIPAL = "user-1";
const LIVE = new Date(Date.now() + 60 * 60 * 1000);
const DEAD = new Date(Date.now() - 1);

// A row as `findForPrincipal` returns it — that query is ordered lastUsedAt desc, so the
// order of this array IS the most-recently-used order the cap acts on.
function row(sid: string, expiresAt = LIVE) {
  return { sid, expiresAt };
}

// startSession mints its own sid; read it back off the create call.
function newSid(): string {
  return (create.mock.calls[0][0] as { sid: string }).sid;
}

function evicted(): string[] {
  return deleteManyBySids.mock.calls.length
    ? (deleteManyBySids.mock.calls[0][0] as string[])
    : [];
}

beforeEach(() => {
  create.mockReset().mockResolvedValue(undefined);
  findForPrincipal.mockReset();
  deleteManyBySids.mockReset().mockResolvedValue({ count: 0 });
  revokeSessionSockets.mockReset();
});

describe("device cap", () => {
  it("is 1 — the agreed business rule, not an incidental number", () => {
    // Locked deliberately: the client asked on 2026-09-02 for one device per account, so
    // signing in anywhere signs the previous device out. (It was 2, then 3 on 2026-08-27.)
    // A change here is a product decision, so it must break here.
    expect(MAX_DEVICES).toBe(1);
  });

  it("leaves the newly signed-in device as the only live session", async () => {
    // The whole point of a one-device cap, stated as the property the client asked for
    // rather than as an eviction list.
    const old = Array.from({ length: 4 }, (_, i) => row(`old-${i}`));
    findForPrincipal.mockImplementation(async () => [row(newSid()), ...old]);

    const sid = await startSession(PRINCIPAL, "user", {});

    const survivors = [sid, ...old.map((s) => s.sid)].filter((x) => !evicted().includes(x));
    expect(survivors).toEqual([sid]);
  });

  it("leaves the account at exactly MAX_DEVICES live sessions after an over-cap sign-in", async () => {
    const old = Array.from({ length: MAX_DEVICES }, (_, i) => row(`old-${i}`));
    // The new row sorts first — its lastUsedAt is the moment it was created.
    findForPrincipal.mockImplementation(async () => [row(newSid()), ...old]);

    const sid = await startSession(PRINCIPAL, "user", {});

    // The oldest is the only casualty; everything else survives.
    expect(evicted()).toEqual([`old-${MAX_DEVICES - 1}`]);
    expect(evicted()).not.toContain(sid);
  });

  it("does not evict anything while the account is still under the cap", async () => {
    // One slot short of full, so nothing has to give — at a cap of 1 that is the very
    // first sign-in, with no prior rows at all.
    const old = Array.from({ length: Math.max(MAX_DEVICES - 2, 0) }, (_, i) => row(`old-${i}`));
    findForPrincipal.mockImplementation(async () => [row(newSid()), ...old]);

    await startSession(PRINCIPAL, "user", {});

    expect(deleteManyBySids).not.toHaveBeenCalled();
  });

  it("never evicts the device that just signed in, even when it sorts last", async () => {
    // The race this guards: concurrent sign-ins, or two rows sharing a lastUsedAt
    // millisecond, can put the brand-new session anywhere in the ordering. Pinning its
    // sid means the user who just typed their password is never the one thrown out.
    const old = Array.from({ length: MAX_DEVICES + 2 }, (_, i) => row(`old-${i}`));
    findForPrincipal.mockImplementation(async () => [...old, row(newSid())]);

    const sid = await startSession(PRINCIPAL, "user", {});

    expect(evicted()).not.toContain(sid);
    // The new sid is pinned OUT of the ranking, so the survivors are the
    // (MAX_DEVICES - 1) most-recent others — never one slot too many.
    expect(evicted()).toEqual(old.slice(MAX_DEVICES - 1).map((s) => s.sid));
  });

  it("sweeps already-expired rows in the same pass", async () => {
    // An expired row is dead to every other code path — findActive rejects it, the device
    // list hides it — so it must not be left behind holding a stale IP + user-agent, and it
    // must never be counted as one of the (MAX_DEVICES - 1) retained others.
    const dead = Array.from({ length: 3 }, (_, i) => row(`dead-${i}`, DEAD));
    findForPrincipal.mockImplementation(async () => [row(newSid()), ...dead]);

    const sid = await startSession(PRINCIPAL, "user", {});

    expect(evicted()).toEqual(dead.map((s) => s.sid));
    expect(evicted()).not.toContain(sid);
  });

  it("pushes the evicted devices off their sockets, with the reason, after the rows are gone", async () => {
    // The row delete alone only stops the old device at its NEXT request — it would sit there
    // rendering a stale screen until then. This push is what turns a 1-device cap into a visible
    // sign-out, so it must name exactly the evicted sids (never the new one) and say why.
    const old = Array.from({ length: 2 }, (_, i) => row(`old-${i}`));
    findForPrincipal.mockImplementation(async () => [row(newSid()), ...old]);

    const sid = await startSession(PRINCIPAL, "user", {});

    expect(revokeSessionSockets).toHaveBeenCalledWith(evicted(), "signed_in_elsewhere");
    expect(evicted()).not.toContain(sid);
  });

  it("does not push anything when nothing was evicted", async () => {
    // A first sign-in must not broadcast a sign-out to an account that has no other device.
    findForPrincipal.mockImplementation(async () => [row(newSid())]);

    await startSession(PRINCIPAL, "user", {});

    expect(revokeSessionSockets).not.toHaveBeenCalled();
  });
});
