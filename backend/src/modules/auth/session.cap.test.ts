import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, findForPrincipal, deleteManyBySids } = vi.hoisted(() => ({
  create: vi.fn(),
  findForPrincipal: vi.fn(),
  deleteManyBySids: vi.fn(),
}));
vi.mock("./session.repository.js", () => ({ create, findForPrincipal, deleteManyBySids }));

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
});

describe("device cap", () => {
  it("is 3 — the agreed business rule, not an incidental number", () => {
    // Locked deliberately: it was raised from 2 on 2026-08-27 because two devices was
    // not enough in practice. A change here is a product decision, so it must break here.
    expect(MAX_DEVICES).toBe(3);
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
    const old = Array.from({ length: MAX_DEVICES - 2 }, (_, i) => row(`old-${i}`));
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
    expect(evicted()).toEqual(old.slice(MAX_DEVICES).map((s) => s.sid));
  });

  it("does not let already-expired rows occupy a slot", async () => {
    // An expired row is dead to every other code path, so counting it toward the cap
    // would silently cost a real device its place. It is swept in the same pass.
    const dead = Array.from({ length: MAX_DEVICES }, (_, i) => row(`dead-${i}`, DEAD));
    findForPrincipal.mockImplementation(async () => [row(newSid()), ...dead, row("live-0")]);

    await startSession(PRINCIPAL, "user", {});

    expect(evicted()).toEqual(dead.map((s) => s.sid));
    expect(evicted()).not.toContain("live-0");
  });
});
