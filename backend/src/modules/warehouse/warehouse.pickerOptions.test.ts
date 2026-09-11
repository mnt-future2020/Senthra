import { beforeEach, describe, expect, it, vi } from "vitest";

// The purchase request / order DELIVERY-warehouse list (#30), and the option list every widened
// warehouse filter now reads (#2, #18, #20, #28, #31). Both are opened to more permissions than
// `warehouse.view`, which is only safe because both are SCOPED to the caller — pinned here against the
// real repository, with only Prisma stubbed.
vi.mock("../../lib/prisma.js", () => ({
  prisma: { warehouse: { findMany: vi.fn().mockResolvedValue([]) } },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { prisma } from "../../lib/prisma.js";
import { listWarehouseDeliveryOptions, listWarehouseOptions } from "./warehouse.service.js";

const findMany = prisma.warehouse.findMany as ReturnType<typeof vi.fn>;
const lastArgs = () => findMany.mock.calls.at(-1)?.[0];
const scoped = (ids: string[]) => ({ type: "user", assignedWarehouseIds: ids }) as never;
const unscoped = { type: "user", assignedWarehouseIds: null } as never;

beforeEach(() => vi.clearAllMocks());

describe("listWarehouseDeliveryOptions", () => {
  it("selects the option, the default flag and the address — nothing about contacts, managers or notes", async () => {
    await listWarehouseDeliveryOptions(unscoped);
    expect(Object.keys(lastArgs().select).sort()).toEqual(
      ["addressLine1", "addressLine2", "city", "code", "country", "county", "id", "isDefault", "name", "postcode"].sort(),
    );
  });

  it("gives a warehouse-scoped user ONLY their assigned warehouses", async () => {
    await listWarehouseDeliveryOptions(scoped(["w1", "w2"]));
    expect(lastArgs().where).toEqual({ status: "active", deletedAt: null, id: { in: ["w1", "w2"] } });
  });

  it("gives an unscoped user every active warehouse", async () => {
    await listWarehouseDeliveryOptions(unscoped);
    expect(lastArgs().where).toEqual({ status: "active", deletedAt: null });
  });

  // P4: the forms paged 100 full warehouse records. This is the complete active set.
  it("is not paged", async () => {
    const many = Array.from({ length: 140 }, (_, i) => ({ id: `w${i}`, code: `WH-${i}`, name: `W${i}` }));
    findMany.mockResolvedValueOnce(many);
    const out = await listWarehouseDeliveryOptions(unscoped);
    expect(out).toHaveLength(140);
    expect(lastArgs().take).toBeUndefined();
  });
});

describe("listWarehouseOptions (the list the widened filters read)", () => {
  it("stays scoped to a warehouse-scoped caller", async () => {
    await listWarehouseOptions(scoped(["w9"]));
    expect(lastArgs().where.id).toEqual({ in: ["w9"] });
  });

  it("stays lean: id, code, name — plus the status it flags a deactivated row by", async () => {
    await listWarehouseOptions(unscoped);
    expect(lastArgs().select).toEqual({ id: true, code: true, name: true, status: true });
  });

  it("offers ACTIVE warehouses only by default", async () => {
    await listWarehouseOptions(unscoped);
    expect(lastArgs().where).toEqual({ status: "active", deletedAt: null });
  });
});

// History filters (the purchase request list): a deactivated warehouse still owns its requests.
describe("listWarehouseOptions with includeInactive", () => {
  it("keeps deactivated warehouses but STILL scopes a warehouse-scoped caller", async () => {
    await listWarehouseOptions(scoped(["w9"]), { includeInactive: true });
    expect(lastArgs().where).toEqual({ deletedAt: null, id: { in: ["w9"] } });
  });

  it("returns active and deactivated warehouses, flagging only the deactivated", async () => {
    findMany.mockResolvedValueOnce([
      { id: "w1", code: "WH-1", name: "Alpha", status: "active" },
      { id: "w2", code: "WH-2", name: "Beta", status: "inactive" },
    ]);
    expect(await listWarehouseOptions(unscoped, { includeInactive: true })).toEqual([
      { id: "w1", code: "WH-1", name: "Alpha" },
      { id: "w2", code: "WH-2", name: "Beta", inactive: true },
    ]);
  });
});
