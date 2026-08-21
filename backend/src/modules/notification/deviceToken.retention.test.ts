import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({
  db: { deleteMany: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
}));
vi.mock("../../lib/prisma.js", () => ({ prisma: { deviceToken: db } }));
vi.mock("../../lib/push.js", () => ({ sendToTokens: vi.fn().mockResolvedValue([]) }));

import { removeAllForUser, remove, tokensForUser, upsert } from "./deviceToken.repository.js";
import { clearDevicesForUser, registerToken, unregisterToken } from "./notification.service.js";

const USER_ID = "u".repeat(24);

beforeEach(() => {
  db.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  db.findMany.mockReset().mockResolvedValue([]);
  db.upsert.mockReset().mockResolvedValue({});
});

describe("device-token cleanup for an account that can no longer sign in", () => {
  it("removes every token for that user and nothing else", async () => {
    await removeAllForUser(USER_ID);
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    // Scoped to the user alone — no age cutoff, so no invented retention period.
    const where = db.deleteMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(Object.keys(where)).toEqual(["userId"]);
  });

  it("reports how many devices went", async () => {
    db.deleteMany.mockResolvedValue({ count: 3 });
    expect(await clearDevicesForUser(USER_ID)).toBe(3);
  });

  it("is a no-op for a user with no registered devices", async () => {
    expect(await clearDevicesForUser(USER_ID)).toBe(0);
  });

  it("touches one user's devices only — another user's rows are never in the filter", async () => {
    const other = "z".repeat(24);
    await clearDevicesForUser(other);
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { userId: other } });
  });
});

describe("normal notification behaviour is unchanged", () => {
  it("registering still upserts on the token, moving a device between users", async () => {
    await registerToken(USER_ID, "fcm-abc", "android");
    expect(db.upsert).toHaveBeenCalledWith({
      where: { token: "fcm-abc" },
      create: { token: "fcm-abc", userId: USER_ID, platform: "android" },
      update: { userId: USER_ID, platform: "android", lastSeenAt: expect.any(Date) },
    });
  });

  it("unregistering still removes by token, not by user", async () => {
    await unregisterToken("fcm-abc");
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { token: "fcm-abc" } });
  });

  it("the fan-out lookup is unchanged", async () => {
    db.findMany.mockResolvedValue([{ token: "a" }, { token: "b" }]);
    expect(await tokensForUser(USER_ID)).toEqual(["a", "b"]);
    expect(db.findMany).toHaveBeenCalledWith({ where: { userId: USER_ID }, select: { token: true } });
  });

  it("upsert and remove still address a single token", async () => {
    await upsert("t1", USER_ID, "ios");
    await remove("t1");
    expect(db.upsert.mock.calls[0][0].where).toEqual({ token: "t1" });
    expect(db.deleteMany.mock.calls[0][0].where).toEqual({ token: "t1" });
  });
});
