import { beforeEach, describe, expect, it, vi } from "vitest";

// The ASSIGN step — where the authoritative destination is chosen. The reviewer's dropdown is
// filled with the warehouses that were active when the modal OPENED, so everything it shows is a
// snapshot: by the time Assign is clicked a warehouse may have been deactivated or deleted. These
// tests pin the server-side re-checks, because an assignment written to an unusable warehouse
// strands the customer's stock in an Incoming queue nobody can receive or close.
vi.mock("./customer.repository.js", () => ({
  findById: vi.fn(),
  findStockRequestById: vi.fn(),
  createWarehouseAssignments: vi.fn(),
  updateStockRequestStatus: vi.fn(),
  findStockRequestWithAssignments: vi.fn(),
  isUniqueConflictError: vi.fn(() => false),
}));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as customerRepo from "./customer.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import { assignStockRequestWarehouses } from "./customer.service.js";

const CUST_ID = "c".repeat(24);
const REQ_ID = "r".repeat(24);
const WH_ACTIVE = "a".repeat(24);
const WH_INACTIVE = "b".repeat(24);

const repo = vi.mocked(customerRepo);
const whRepo = vi.mocked(warehouseRepo);

const warehouse = (id: string, name: string, status: string) => ({ id, name, status }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  repo.findById.mockResolvedValue({ id: CUST_ID, name: "LOBBI" } as never);
  repo.findStockRequestById.mockResolvedValue({
    id: REQ_ID, customerId: CUST_ID, name: "CAT6 Cable", editedName: null, quantity: 10, status: "approved",
  } as never);
  repo.findStockRequestWithAssignments.mockResolvedValue({
    id: REQ_ID, name: "CAT6 Cable", quantity: 10, status: "assigned", createdAt: new Date(), warehouseAssignments: [],
  } as never);
  whRepo.findById.mockImplementation(async (id: string) =>
    id === WH_ACTIVE ? warehouse(WH_ACTIVE, "London Logistics Hub", "active")
    : id === WH_INACTIVE ? warehouse(WH_INACTIVE, "Old Depot", "inactive")
    : null,
  );
});

const assign = (assignments: { warehouseId: string; quantity: number }[]) =>
  assignStockRequestWarehouses(CUST_ID, REQ_ID, { assignments });

describe("assignStockRequestWarehouses — destination must be usable", () => {
  it("assigns to an active warehouse", async () => {
    await assign([{ warehouseId: WH_ACTIVE, quantity: 10 }]);
    expect(repo.createWarehouseAssignments).toHaveBeenCalledWith([
      { customerStockRequestId: REQ_ID, warehouseId: WH_ACTIVE, quantity: 10 },
    ]);
    expect(repo.updateStockRequestStatus).toHaveBeenCalledWith(REQ_ID, "assigned");
  });

  it("REJECTS a warehouse deactivated since the modal opened — and NAMES it", async () => {
    // The stale-tab race: the dropdown offered it, the server refuses it. Named so the reviewer
    // knows which row of a split to change.
    await expect(assign([{ warehouseId: WH_INACTIVE, quantity: 10 }])).rejects.toThrow(/Old Depot/);
    expect(repo.createWarehouseAssignments).not.toHaveBeenCalled();
    expect(repo.updateStockRequestStatus).not.toHaveBeenCalled();
  });

  it("rejects the WHOLE split when only one leg is inactive — never a half-written assignment", async () => {
    await expect(
      assign([
        { warehouseId: WH_ACTIVE, quantity: 6 },
        { warehouseId: WH_INACTIVE, quantity: 4 },
      ]),
    ).rejects.toThrow(/No longer active: Old Depot/);
    expect(repo.createWarehouseAssignments).not.toHaveBeenCalled();
  });

  it("still rejects a warehouse that no longer exists (soft-deleted rows read as absent)", async () => {
    await expect(assign([{ warehouseId: "f".repeat(24), quantity: 10 }])).rejects.toThrow(/no longer exist/i);
    expect(repo.createWarehouseAssignments).not.toHaveBeenCalled();
  });
});

describe("assignStockRequestWarehouses — existing guards still hold", () => {
  it("requires the split to sum to the request quantity", async () => {
    await expect(
      assign([
        { warehouseId: WH_ACTIVE, quantity: 6 },
        { warehouseId: WH_INACTIVE, quantity: 3 },
      ]),
    ).rejects.toThrow(/must equal request quantity/);
  });

  it("rejects the same warehouse twice", async () => {
    await expect(
      assign([
        { warehouseId: WH_ACTIVE, quantity: 6 },
        { warehouseId: WH_ACTIVE, quantity: 4 },
      ]),
    ).rejects.toThrow(/only appear once/);
  });

  it("only an APPROVED request can be assigned", async () => {
    repo.findStockRequestById.mockResolvedValue({
      id: REQ_ID, customerId: CUST_ID, name: "CAT6 Cable", quantity: 10, status: "pending",
    } as never);
    await expect(assign([{ warehouseId: WH_ACTIVE, quantity: 10 }])).rejects.toThrow(/Only approved requests/);
  });

  it("refuses a request belonging to another customer", async () => {
    repo.findStockRequestById.mockResolvedValue({
      id: REQ_ID, customerId: "9".repeat(24), name: "CAT6 Cable", quantity: 10, status: "approved",
    } as never);
    await expect(assign([{ warehouseId: WH_ACTIVE, quantity: 10 }])).rejects.toThrow(/not found/i);
  });
});
