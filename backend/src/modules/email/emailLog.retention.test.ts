import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { db } = vi.hoisted(() => ({
  db: { deleteMany: vi.fn(), create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
}));
vi.mock("../../lib/prisma.js", () => ({ prisma: { emailLog: db } }));

import { deleteOlderThan } from "./emailLog.repository.js";

const CUTOFF = new Date("2026-05-21T00:00:00.000Z");

const src = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8");

beforeEach(() => {
  db.deleteMany.mockReset().mockResolvedValue({ count: 0 });
});

describe("EmailLog purge", () => {
  it("deletes rows created strictly before the cutoff it is given", async () => {
    await deleteOlderThan(CUTOFF);
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { createdAt: { lt: CUTOFF } } });
  });

  it("filters on age alone — never on recipient, status or template", async () => {
    await deleteOlderThan(CUTOFF);
    const where = db.deleteMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(Object.keys(where)).toEqual(["createdAt"]);
  });

  it("uses the caller's cutoff verbatim, so no period is baked in here", async () => {
    const other = new Date("2020-01-01T00:00:00.000Z");
    await deleteOlderThan(CUTOFF);
    await deleteOlderThan(other);
    expect(db.deleteMany.mock.calls[0][0].where.createdAt.lt).toEqual(CUTOFF);
    expect(db.deleteMany.mock.calls[1][0].where.createdAt.lt).toEqual(other);
  });

  it("reports how many rows went", async () => {
    db.deleteMany.mockResolvedValue({ count: 12 });
    const { count } = await deleteOlderThan(CUTOFF);
    expect(count).toBe(12);
  });
});

/**
 * The purge is written but must not RUN until a retention period is agreed. These tests fail the
 * moment something starts calling it, which is the point — enabling it is meant to be a decision,
 * not a merge.
 */
describe("the purge is deliberately not wired up", () => {
  it("takes a required cutoff, so it cannot be called with an invented default period", () => {
    expect(src("modules/email/emailLog.repository.ts")).toContain("deleteOlderThan(cutoff: Date)");
    expect(src("modules/email/emailLog.repository.ts")).not.toMatch(/deleteOlderThan\(cutoff: Date = /);
    expect(src("modules/email/email.service.ts")).toContain("purgeEmailLogsOlderThan(cutoff: Date)");
    expect(src("modules/email/email.service.ts")).not.toMatch(/purgeEmailLogsOlderThan\(cutoff: Date = /);
  });

  it("is not started from the server bootstrap", () => {
    const server = src("server.ts");
    expect(server).not.toContain("purgeEmailLogsOlderThan");
    expect(server).not.toContain("emailLog");
  });

  it("no sweep or reaper calls it", () => {
    for (const f of [
      "modules/upload/upload.reaper.ts",
      "modules/purchase-order/rentalHire.sweep.ts",
      "modules/auth/session.sweep.ts",
    ]) {
      expect(src(f)).not.toContain("purgeEmailLogsOlderThan");
      expect(src(f)).not.toContain("deleteOlderThan");
    }
  });
});

describe("send-path behaviour is untouched", () => {
  it("the log is still written, and still never read back by the application", () => {
    const service = src("modules/email/email.service.ts");
    // The send path writes.
    expect(service).toContain("emailLogRepo.create");
    // …and the read helpers remain uncalled, which is what makes the purge safe.
    expect(service).not.toContain("emailLogRepo.findRecent");
    expect(service).not.toContain("emailLogRepo.countByStatus");
  });
});
