import { beforeEach, describe, expect, it, vi } from "vitest";

// The lean supplier option list, against the real repository with only Prisma stubbed. Active-only by
// default (every create form picks from it); `includeInactive` is for HISTORY filters, where a
// deactivated supplier still owns the purchase requests raised against it.
vi.mock("../../lib/prisma.js", () => ({
  prisma: { supplier: { findMany: vi.fn().mockResolvedValue([]) } },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { prisma } from "../../lib/prisma.js";
import { listSupplierOptions } from "./supplier.service.js";

const findMany = prisma.supplier.findMany as ReturnType<typeof vi.fn>;
const lastArgs = () => findMany.mock.calls.at(-1)?.[0];

beforeEach(() => vi.clearAllMocks());

describe("listSupplierOptions", () => {
  it("offers ACTIVE suppliers only by default", async () => {
    await listSupplierOptions();
    expect(lastArgs().where).toEqual({ deletedAt: null, status: "active" });
  });

  it("with includeInactive keeps deactivated suppliers but never deleted ones", async () => {
    await listSupplierOptions({ includeInactive: true });
    expect(lastArgs().where).toEqual({ deletedAt: null });
  });

  it("reads id, code, name and the status it flags by — nothing else", async () => {
    await listSupplierOptions({ includeInactive: true });
    expect(lastArgs().select).toEqual({ id: true, code: true, name: true, status: true });
  });

  it("returns active and deactivated suppliers, flagging only the deactivated", async () => {
    findMany.mockResolvedValueOnce([
      { id: "s1", code: "SUP-1", name: "Live Ltd", status: "active" },
      { id: "s2", code: "SUP-2", name: "Gone Ltd", status: "inactive" },
    ]);
    expect(await listSupplierOptions({ includeInactive: true })).toEqual([
      { id: "s1", code: "SUP-1", name: "Live Ltd" },
      { id: "s2", code: "SUP-2", name: "Gone Ltd", inactive: true },
    ]);
  });
});
