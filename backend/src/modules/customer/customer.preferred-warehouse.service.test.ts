import { beforeEach, describe, expect, it, vi } from "vitest";

// The customer's PREFERRED warehouse on a stock submission.
//
// ELIGIBILITY RULE (business decision): a customer may name ANY active, non-deleted warehouse.
// There is deliberately NO customer-history filter — an earlier build scoped the list to
// warehouses already used for that customer, and that restriction was removed. Do not
// reintroduce it; these tests pin its absence.
//
// Two things stay load-bearing:
//   1. SECURITY — the id arrives from a portal client, so the server re-applies the active +
//      non-deleted rule itself. An inactive, soft-deleted or unknown id must be REJECTED, not
//      silently dropped (a silent drop tells the customer their preference was recorded when it
//      wasn't, and hides a probe).
//   2. AUTHORITY — storing a preference must not create an assignment, touch inventory, or become
//      the destination. It is written to the request row and read nowhere downstream.
vi.mock("./customer.repository.js", () => ({
  findById: vi.fn(),
  findStockEntryById: vi.fn(),
  createStockRequest: vi.fn(),
  createWarehouseAssignments: vi.fn(),
}));
// findOptions() = the app's unrestricted active-warehouse picker query; findActiveByIds() applies
// the SAME rule to one id. Both live in the warehouse module — the customer module owns no
// warehouse query, which is what stops a second, drifting definition of "selectable".
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({
  findOptions: vi.fn(),
  findActiveByIds: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as customerRepo from "./customer.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import {
  submitStockRequest,
  createStockRequestForCustomer,
  listSelectableWarehouses,
} from "./customer.service.js";

const CUST_ID = "c".repeat(24);
const WH_ACTIVE = "a".repeat(24);
const WH_NEVER_USED = "e".repeat(24); // active, but this customer has never used it
const WH_INACTIVE = "b".repeat(24);
const WH_DELETED = "d".repeat(24);
const WH_UNKNOWN = "f".repeat(24);

const repo = vi.mocked(customerRepo);
const whRepo = vi.mocked(warehouseRepo);
const portalUser = { userId: "u".repeat(24), name: "Pat", email: "pat@bt-test.com" };

// The only ids the warehouse repo treats as selectable. Inactive / soft-deleted / unknown ids are
// absent from BOTH helpers, exactly as the real queries behave (status: active, deletedAt: null).
const SELECTABLE = [
  { id: WH_ACTIVE, code: "WH-0005", name: "London Logistics Hub" },
  { id: WH_NEVER_USED, code: "WH-0011", name: "Nezuko Warehouse" },
];

function createdRow(over: Record<string, unknown> = {}) {
  return {
    id: "r".repeat(24),
    name: "CAT6 Cable",
    editedName: null,
    catalogueItemId: null,
    linkedStockEntryId: null,
    quantity: 10,
    reason: null,
    notes: null,
    status: "pending",
    requestedByName: null,
    reviewedBy: null,
    adminResponse: null,
    reviewedAt: null,
    preferredWarehouseId: null,
    preferredWarehouse: null,
    createdAt: new Date("2026-08-31T00:00:00Z"),
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.findById.mockResolvedValue({ id: CUST_ID, name: "LOBBI" } as never);
  repo.createStockRequest.mockResolvedValue(createdRow());
  whRepo.findOptions.mockResolvedValue(SELECTABLE);
  whRepo.findActiveByIds.mockImplementation(async (ids: string[]) =>
    SELECTABLE.filter((w) => ids.includes(w.id)).map((w) => ({ id: w.id })),
  );
});

const submit = (over: Record<string, unknown> = {}) =>
  submitStockRequest(CUST_ID, portalUser, { name: "CAT6 Cable", quantity: 10, ...over });

describe("listSelectableWarehouses — every active, non-deleted warehouse", () => {
  it("returns the unrestricted active-warehouse list", async () => {
    expect(await listSelectableWarehouses()).toEqual(SELECTABLE);
  });

  it("asks for the UNRESTRICTED list — no customer-history scoping", async () => {
    // findOptions(undefined) is the unrestricted form; passing an id set would scope it. If this
    // ever starts receiving ids, someone has reintroduced a customer-specific filter.
    await listSelectableWarehouses();
    expect(whRepo.findOptions).toHaveBeenCalledWith();
    expect(whRepo.findOptions).toHaveBeenCalledTimes(1);
  });

  it("includes an active warehouse this customer has NEVER used", async () => {
    const list = await listSelectableWarehouses();
    expect(list.map((w) => w.id)).toContain(WH_NEVER_USED);
  });

  it("never reads the customer's stock or assignment history to build the list", async () => {
    await listSelectableWarehouses();
    // The customer repository is not consulted at all — there is no history query left to make.
    for (const fn of Object.values(repo)) {
      if (typeof fn === "function" && "mock" in fn) expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe("preferred warehouse — submission guard", () => {
  it("stores an active warehouse as the preference", async () => {
    await submit({ preferredWarehouseId: WH_ACTIVE });
    expect(repo.createStockRequest).toHaveBeenCalledWith(
      CUST_ID,
      portalUser.userId,
      portalUser.name,
      expect.objectContaining({ preferredWarehouseId: WH_ACTIVE }),
    );
  });

  it("accepts an active warehouse the customer has never used before", async () => {
    await submit({ preferredWarehouseId: WH_NEVER_USED });
    expect(repo.createStockRequest).toHaveBeenCalledWith(
      CUST_ID,
      portalUser.userId,
      portalUser.name,
      expect.objectContaining({ preferredWarehouseId: WH_NEVER_USED }),
    );
  });

  it("submits fine with NO preference — the field is optional", async () => {
    await submit();
    expect(repo.createStockRequest).toHaveBeenCalledWith(
      CUST_ID,
      portalUser.userId,
      portalUser.name,
      expect.objectContaining({ preferredWarehouseId: null }),
    );
    // No lookup at all when no preference was expressed.
    expect(whRepo.findActiveByIds).not.toHaveBeenCalled();
  });

  it.each([
    ["an INACTIVE warehouse", WH_INACTIVE],
    ["a SOFT-DELETED warehouse", WH_DELETED],
    ["an unknown / forged id", WH_UNKNOWN],
  ])("REJECTS %s", async (_label, id) => {
    await expect(submit({ preferredWarehouseId: id })).rejects.toThrow(/available/i);
    expect(repo.createStockRequest).not.toHaveBeenCalled();
  });

  it("re-checks the id server-side rather than trusting the dropdown", async () => {
    await submit({ preferredWarehouseId: WH_ACTIVE });
    expect(whRepo.findActiveByIds).toHaveBeenCalledWith([WH_ACTIVE]);
  });

  it("checks ONLY the submitted id — never loads the whole warehouse list to validate one", async () => {
    await submit({ preferredWarehouseId: WH_ACTIVE });
    expect(whRepo.findOptions).not.toHaveBeenCalled();
  });

  it("applies the SAME guard to an admin submitting on the customer's behalf", async () => {
    await expect(
      createStockRequestForCustomer(CUST_ID, "Phone contact", {
        name: "CAT6 Cable",
        quantity: 10,
        preferredWarehouseId: WH_INACTIVE,
      }),
    ).rejects.toThrow(/available/i);
  });

  it("a preference NEVER creates a warehouse assignment at submission time", async () => {
    await submit({ preferredWarehouseId: WH_ACTIVE });
    expect(repo.createWarehouseAssignments).not.toHaveBeenCalled();
  });
});

describe("preferred warehouse — response shape", () => {
  it("echoes the warehouse NAME (not internal metadata) to the portal", async () => {
    repo.createStockRequest.mockResolvedValue(
      createdRow({
        preferredWarehouseId: WH_ACTIVE,
        preferredWarehouse: { id: WH_ACTIVE, name: "London Logistics Hub", code: "WH-0005", status: "active", deletedAt: null },
      }),
    );
    const r = await submit({ preferredWarehouseId: WH_ACTIVE });
    expect(r.preferredWarehouseName).toBe("London Logistics Hub");
    // The portal shape carries the name only — no id, no code, no status.
    expect(r).not.toHaveProperty("preferredWarehouseId");
    expect(r).not.toHaveProperty("preferredWarehouseActive");
  });

  it("gives staff the id, name and whether the warehouse is still usable", async () => {
    repo.createStockRequest.mockResolvedValue(
      createdRow({
        preferredWarehouseId: WH_ACTIVE,
        preferredWarehouse: { id: WH_ACTIVE, name: "London Logistics Hub", code: "WH-0005", status: "inactive", deletedAt: null },
      }),
    );
    const r = await createStockRequestForCustomer(CUST_ID, null, { name: "CAT6 Cable", quantity: 10 });
    expect(r.preferredWarehouseId).toBe(WH_ACTIVE);
    expect(r.preferredWarehouseName).toBe("London Logistics Hub");
    // Deactivated since submission → still shown to the reviewer, but flagged as unusable.
    expect(r.preferredWarehouseActive).toBe(false);
  });

  it("flags a SOFT-DELETED warehouse as unusable even though its status is still 'active'", async () => {
    // warehouseRepo.softDelete stamps deletedAt and leaves status alone, so status on its own says
    // "active" for a warehouse that no query will return. Judging usability on status alone showed
    // the reviewer no "(no longer available)" warning while the assign modal silently refused to
    // pre-fill it — two contradictory signals about the same warehouse.
    repo.createStockRequest.mockResolvedValue(
      createdRow({
        preferredWarehouseId: WH_ACTIVE,
        preferredWarehouse: {
          id: WH_ACTIVE, name: "London Logistics Hub", code: "WH-0005",
          status: "active", deletedAt: new Date("2026-08-30T00:00:00Z"),
        },
      }),
    );
    const r = await createStockRequestForCustomer(CUST_ID, null, { name: "CAT6 Cable", quantity: 10 });
    expect(r.preferredWarehouseName).toBe("London Logistics Hub");
    expect(r.preferredWarehouseActive).toBe(false);
  });

  it("flags a live warehouse as usable", async () => {
    repo.createStockRequest.mockResolvedValue(
      createdRow({
        preferredWarehouseId: WH_ACTIVE,
        preferredWarehouse: { id: WH_ACTIVE, name: "London Logistics Hub", code: "WH-0005", status: "active", deletedAt: null },
      }),
    );
    const r = await createStockRequestForCustomer(CUST_ID, null, { name: "CAT6 Cable", quantity: 10 });
    expect(r.preferredWarehouseActive).toBe(true);
  });

  it("a row created BEFORE the field existed reads as no preference, not a crash", async () => {
    // Prisma+Mongo hands back a row whose optional field is simply absent. Both shapes map.
    const legacy = createdRow();
    delete (legacy as Record<string, unknown>).preferredWarehouseId;
    delete (legacy as Record<string, unknown>).preferredWarehouse;
    repo.createStockRequest.mockResolvedValue(legacy);
    expect((await submit()).preferredWarehouseName).toBeNull();
  });
});
