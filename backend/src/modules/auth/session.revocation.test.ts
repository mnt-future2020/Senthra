import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Ending a session ends its realtime access ──────────────────────────────────────────────────
//
// The invariant the top of session.service.ts states: revocation lives beside the delete, so a call
// site that ends a session cannot forget to hang up on the device. `endSession` — ordinary logout —
// was the one path that did not honour it, which left a logged-out tab holding a socket that was
// still in the broadcast rooms it joined at connect: still receiving job, purchase-order and rental
// payloads it could no longer fetch over REST.
//
// These pin all THREE deleting paths together, because the bug was not that one of them was wrong —
// it was that they disagreed, and nothing said they had to match.

const { deleteBySid, deleteAllForPrincipal, deleteOthersForPrincipal } = vi.hoisted(() => ({
  deleteBySid: vi.fn(),
  deleteAllForPrincipal: vi.fn(),
  deleteOthersForPrincipal: vi.fn(),
}));
vi.mock("./session.repository.js", () => ({
  deleteBySid,
  deleteAllForPrincipal,
  deleteOthersForPrincipal,
}));

const { revokeSessionSockets, revokePrincipalSockets } = vi.hoisted(() => ({
  revokeSessionSockets: vi.fn(),
  revokePrincipalSockets: vi.fn(),
}));
vi.mock("../../lib/realtime.js", () => ({ revokeSessionSockets, revokePrincipalSockets }));

import { endAll, endOthers, endSession } from "./session.service.js";

const SID = "sid-abc";
const PRINCIPAL = "user-1";

beforeEach(() => {
  deleteBySid.mockReset().mockResolvedValue(undefined);
  deleteAllForPrincipal.mockReset().mockResolvedValue({ count: 1 });
  deleteOthersForPrincipal.mockReset().mockResolvedValue({ count: 1 });
  revokeSessionSockets.mockReset();
  revokePrincipalSockets.mockReset();
});

describe("endSession (ordinary logout)", () => {
  it("deletes the session row", async () => {
    await endSession(SID);
    expect(deleteBySid).toHaveBeenCalledWith(SID);
  });

  // THE regression. Without this the tab keeps a live socket in every room it joined.
  it("revokes the session's socket", async () => {
    await endSession(SID);
    expect(revokeSessionSockets).toHaveBeenCalledWith([SID], "signed_out_remotely");
  });

  // Only this device. Logging out of one tab must not sign the account out everywhere — the account
  // room would reach every other device this principal has, which is what `endAll` is for.
  it("revokes only this sid, never the whole principal", async () => {
    await endSession(SID);
    expect(revokeSessionSockets).toHaveBeenCalledTimes(1);
    expect(revokePrincipalSockets).not.toHaveBeenCalled();
  });

  // Ordering: the row goes first, so a device that races a request in between finds no session. The
  // sid is the caller's own argument, so the delete cannot take the identifier the revoke needs with
  // it — which is the trap a "read the row, then delete, then revoke" shape would have set.
  it("deletes before it revokes, and does not read the sid back off the deleted row", async () => {
    const order: string[] = [];
    deleteBySid.mockImplementation(async () => void order.push("delete"));
    revokeSessionSockets.mockImplementation(() => void order.push("revoke"));

    await endSession(SID);

    expect(order).toEqual(["delete", "revoke"]);
  });
});

// Unchanged behaviour, pinned here so a future edit to the shared revocation helpers cannot quietly
// alter them while only `endSession` is under test.
describe("endAll", () => {
  it("deletes every session and revokes every socket for the principal", async () => {
    await endAll(PRINCIPAL, "user");
    expect(deleteAllForPrincipal).toHaveBeenCalledWith(PRINCIPAL, "user");
    expect(revokePrincipalSockets).toHaveBeenCalledWith(PRINCIPAL, "signed_out_remotely");
  });

  it("spares nothing — no keepSid is passed", async () => {
    await endAll(PRINCIPAL, "user");
    expect(revokePrincipalSockets.mock.calls[0]).toHaveLength(2);
  });
});

describe("endOthers", () => {
  it("deletes the other sessions and spares the caller's own socket", async () => {
    await endOthers(PRINCIPAL, "user", SID);
    expect(deleteOthersForPrincipal).toHaveBeenCalledWith(PRINCIPAL, "user", SID);
    expect(revokePrincipalSockets).toHaveBeenCalledWith(PRINCIPAL, "signed_out_remotely", SID);
  });
});
