import { beforeEach, describe, expect, it, vi } from "vitest";

// Run the dispatch transaction callback synchronously with a fake tx client.
vi.mock("../../lib/prisma.js", () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("./goods-out.repository.js", () => ({
  createWithCode: vi.fn(),
  findById: vi.fn(),
  findByCode: vi.fn(),
  findByIdTx: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  replaceItemsAndChildren: vi.fn(),
  dispatchTx: vi.fn(),
  upsertEngineerBalanceTx: vi.fn(),
  insertEngineerTxnTx: vi.fn(),
  findEngineerBalanceTx: vi.fn(),
  findEngineerBalances: vi.fn(),
  count: vi.fn(),
  findMany: vi.fn(),
  countByWarehouse: vi.fn(),
  countEngineerStockWithStockByIrmItem: vi.fn(),
}));
vi.mock("#modules/warehouse/warehouse.service.js", () => ({ requireActiveWarehouse: vi.fn() }));
vi.mock("#modules/irm/irm.service.js", () => ({ requireActiveIrmItem: vi.fn() }));
vi.mock("#modules/user/user.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/inventory/inventory.service.js", () => ({ applyOutbound: vi.fn() }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findBalancePair: vi.fn(), findBalancePairTx: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as goodsOutRepo from "./goods-out.repository.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import { cancelGoodsOut, createGoodsOut, deleteGoodsOut, dispatchGoodsOut } from "./goods-out.service.js";

const GDN_ID = "a".repeat(24);
const WH_ID = "b".repeat(24);
const ENG_ID = "c".repeat(24);
const IRM_ID = "d".repeat(24);

const mockCreate = goodsOutRepo.createWithCode as ReturnType<typeof vi.fn>;
const mockFindById = goodsOutRepo.findById as ReturnType<typeof vi.fn>;
const mockFindByIdTx = goodsOutRepo.findByIdTx as ReturnType<typeof vi.fn>;
const mockUpdate = goodsOutRepo.update as ReturnType<typeof vi.fn>;
const mockSoftDelete = goodsOutRepo.softDelete as ReturnType<typeof vi.fn>;
const mockDispatchTx = goodsOutRepo.dispatchTx as ReturnType<typeof vi.fn>;
const mockUpsertEng = goodsOutRepo.upsertEngineerBalanceTx as ReturnType<typeof vi.fn>;
const mockInsertEngTxn = goodsOutRepo.insertEngineerTxnTx as ReturnType<typeof vi.fn>;
const mockReqWarehouse = warehouseService.requireActiveWarehouse as ReturnType<typeof vi.fn>;
const mockReqIrm = irmService.requireActiveIrmItem as ReturnType<typeof vi.fn>;
const mockUser = userRepo.findById as ReturnType<typeof vi.fn>;
const mockApplyOutbound = inventoryService.applyOutbound as ReturnType<typeof vi.fn>;
const mockFindBalance = inventoryRepo.findBalancePair as ReturnType<typeof vi.fn>;
const mockFindBalanceTx = inventoryRepo.findBalancePairTx as ReturnType<typeof vi.fn>;
const mockAudit = audit.record as ReturnType<typeof vi.fn>;
const auditActions = () => mockAudit.mock.calls.map((c) => c[0].action);

const T1 = new Date("2026-06-16T10:00:00Z");

function itemRow(over: Record<string, unknown> = {}) {
  return {
    id: "li1",
    goodsOutId: GDN_ID,
    irmItemId: IRM_ID,
    itemName: "CAT6 Cable",
    sku: "C6",
    baseUnit: "Metre",
    quantity: 5,
    notes: null,
    createdAt: T1,
    irmItem: { id: IRM_ID, code: "IRM-0001", name: "CAT6 Cable", status: "active", baseUnit: "Metre", trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: false },
    ...over,
  };
}

function gdnRow(over: Record<string, unknown> = {}) {
  return {
    id: GDN_ID,
    code: "GDN-0001",
    warehouseId: WH_ID,
    warehouseName: "Leeds",
    warehouseCode: "WH-0001",
    engineerId: ENG_ID,
    engineerName: "Karthik R",
    engineerEmail: "karthik@x.com",
    engineerEmployeeId: "SNT-0007",
    status: "draft",
    dispatchDate: T1,
    dispatchReason: "installation",
    expectedReturnDate: null,
    authorizedById: null,
    authorizedByName: null,
    jobId: null,
    projectId: null,
    customerStockRequestId: null,
    referenceNumber: null,
    description: null,
    internalNotes: null,
    createdBy: null,
    dispatchedBy: null,
    dispatchedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    updatedBy: null,
    deletedAt: null,
    createdAt: T1,
    updatedAt: T1,
    warehouse: { id: WH_ID, code: "WH-0001", name: "Leeds" },
    engineer: { id: ENG_ID, firstName: "Karthik", lastName: "R", email: "karthik@x.com", employeeId: "SNT-0007" },
    items: [itemRow()],
    ...over,
  };
}

const baseInput = { warehouseId: WH_ID, engineerId: ENG_ID, dispatchDate: "2026-06-16", dispatchReason: "installation", items: [{ irmItemId: IRM_ID, quantity: 5 }] } as Parameters<typeof createGoodsOut>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mockReqWarehouse.mockResolvedValue({ id: WH_ID, name: "Leeds", code: "WH-0001" });
  mockUser.mockResolvedValue({ id: ENG_ID, firstName: "Karthik", lastName: "R", email: "karthik@x.com", employeeId: "SNT-0007", status: "active", role: { canHoldStock: true } });
  mockReqIrm.mockResolvedValue({ id: IRM_ID, name: "CAT6 Cable", sku: "C6", baseUnit: "Metre", trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: false });
  mockFindBalance.mockResolvedValue({ quantityOnHand: 100, quantityReserved: 0 });
  mockCreate.mockResolvedValue(gdnRow());
});

describe("createGoodsOut", () => {
  it("snapshots the engineer (name/email/employeeId) + warehouse and creates a draft", async () => {
    await createGoodsOut(baseInput, { email: "ops@x.com" } as never);
    const [header, rows] = mockCreate.mock.calls[0];
    expect(header).toMatchObject({
      warehouseId: WH_ID, warehouseName: "Leeds", warehouseCode: "WH-0001",
      engineerId: ENG_ID, engineerName: "Karthik R", engineerEmail: "karthik@x.com", engineerEmployeeId: "SNT-0007",
      status: "draft", dispatchReason: "installation", createdBy: "ops@x.com",
    });
    expect(rows[0]).toMatchObject({ irmItemId: IRM_ID, itemName: "CAT6 Cable", quantity: 5 });
    expect(auditActions()).toContain("goods_out.created");
  });

  it("rejects a serial-tracked item", async () => {
    mockReqIrm.mockResolvedValue({ id: IRM_ID, name: "SFP", trackInventory: true, trackSerialNumbers: true, trackBatchNumbers: false });
    await expect(createGoodsOut(baseInput)).rejects.toThrow(/serial|batch/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a batch-tracked item", async () => {
    mockReqIrm.mockResolvedValue({ id: IRM_ID, name: "Glue", trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: true });
    await expect(createGoodsOut(baseInput)).rejects.toThrow(/serial|batch/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-inventory-tracked item", async () => {
    mockReqIrm.mockResolvedValue({ id: IRM_ID, name: "Service", trackInventory: false, trackSerialNumbers: false, trackBatchNumbers: false });
    await expect(createGoodsOut(baseInput)).rejects.toThrow(/isn't inventory-tracked/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects when warehouse stock is insufficient", async () => {
    mockFindBalance.mockResolvedValue({ quantityOnHand: 3, quantityReserved: 0 });
    await expect(createGoodsOut(baseInput)).rejects.toThrow(/only 3 available/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects an inactive engineer", async () => {
    mockUser.mockResolvedValue({ id: ENG_ID, firstName: "X", lastName: "Y", email: null, employeeId: null, status: "inactive", role: { canHoldStock: true } });
    await expect(createGoodsOut(baseInput)).rejects.toThrow(/inactive/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a recipient whose role can't hold stock (not field-operations)", async () => {
    mockUser.mockResolvedValue({ id: ENG_ID, firstName: "Adam", lastName: "Min", email: "admin@x.com", employeeId: null, status: "active", role: { canHoldStock: false } });
    await expect(createGoodsOut(baseInput)).rejects.toThrow(/isn't authorised to hold stock/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a recipient with no role at all", async () => {
    mockUser.mockResolvedValue({ id: ENG_ID, firstName: "No", lastName: "Role", email: null, employeeId: null, status: "active", role: null });
    await expect(createGoodsOut(baseInput)).rejects.toThrow(/isn't authorised to hold stock/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("dispatchGoodsOut", () => {
  beforeEach(() => {
    mockFindById.mockResolvedValue(gdnRow());
    mockFindByIdTx.mockResolvedValue(gdnRow());
    mockFindBalanceTx.mockResolvedValue({ quantityOnHand: 100, quantityReserved: 0 });
    mockUpsertEng.mockResolvedValue({ quantityOnHand: 5 });
  });

  it("decrements the warehouse, increments the engineer, writes the engineer ledger, and stamps dispatched", async () => {
    await dispatchGoodsOut(GDN_ID, { email: "ops@x.com" } as never);

    expect(mockApplyOutbound).toHaveBeenCalledTimes(1);
    expect(mockApplyOutbound.mock.calls[0][1]).toMatchObject({ irmItemId: IRM_ID, warehouseId: WH_ID, quantity: 5, sourceType: "goods_out", sourceCode: "GDN-0001" });
    expect(mockUpsertEng).toHaveBeenCalledWith({}, IRM_ID, ENG_ID, 5);
    expect(mockInsertEngTxn.mock.calls[0][1]).toMatchObject({ irmItemId: IRM_ID, engineerId: ENG_ID, quantityDelta: 5, type: "goods_out", balanceAfter: 5 });
    expect(mockDispatchTx).toHaveBeenCalledWith({}, GDN_ID, "ops@x.com");
    expect(auditActions()).toContain("goods_out.dispatched");
  });

  it("rejects (and writes nothing) when live warehouse stock is short", async () => {
    mockFindBalanceTx.mockResolvedValue({ quantityOnHand: 1, quantityReserved: 0 });
    await expect(dispatchGoodsOut(GDN_ID)).rejects.toThrow(/only 1 available|stock changed/i);
    expect(mockApplyOutbound).not.toHaveBeenCalled();
    expect(mockUpsertEng).not.toHaveBeenCalled();
    expect(mockDispatchTx).not.toHaveBeenCalled();
  });

  it("rejects a non-draft dispatch", async () => {
    mockFindById.mockResolvedValue(gdnRow({ status: "dispatched" }));
    await expect(dispatchGoodsOut(GDN_ID)).rejects.toThrow(/can't move/i);
    expect(mockApplyOutbound).not.toHaveBeenCalled();
  });

  it("aborts when the dispatch was modified concurrently (updatedAt moved)", async () => {
    mockFindByIdTx.mockResolvedValue(gdnRow({ updatedAt: new Date("2026-06-16T11:00:00Z") }));
    await expect(dispatchGoodsOut(GDN_ID)).rejects.toThrow(/modified elsewhere/i);
    expect(mockApplyOutbound).not.toHaveBeenCalled();
    expect(mockDispatchTx).not.toHaveBeenCalled();
  });

  it("aborts (writes nothing) when the engineer was suspended after the draft was created", async () => {
    mockUser.mockResolvedValue({ id: ENG_ID, firstName: "Karthik", lastName: "R", email: "karthik@x.com", employeeId: "SNT-0007", status: "suspended", role: { canHoldStock: true } });
    await expect(dispatchGoodsOut(GDN_ID)).rejects.toThrow(/inactive/i);
    expect(mockApplyOutbound).not.toHaveBeenCalled();
    expect(mockUpsertEng).not.toHaveBeenCalled();
    expect(mockDispatchTx).not.toHaveBeenCalled();
  });

  it("aborts (writes nothing) when the engineer lost the stock-holding capability after drafting", async () => {
    mockUser.mockResolvedValue({ id: ENG_ID, firstName: "Karthik", lastName: "R", email: "karthik@x.com", employeeId: "SNT-0007", status: "active", role: { canHoldStock: false } });
    await expect(dispatchGoodsOut(GDN_ID)).rejects.toThrow(/isn't authorised to hold stock/i);
    expect(mockApplyOutbound).not.toHaveBeenCalled();
    expect(mockDispatchTx).not.toHaveBeenCalled();
  });

  it("aborts (writes nothing) when the warehouse was deactivated after the draft was created", async () => {
    mockReqWarehouse.mockRejectedValue(new Error("Selected warehouse is inactive and can't be used for stock movements."));
    await expect(dispatchGoodsOut(GDN_ID)).rejects.toThrow(/inactive/i);
    expect(mockApplyOutbound).not.toHaveBeenCalled();
    expect(mockUpsertEng).not.toHaveBeenCalled();
    expect(mockDispatchTx).not.toHaveBeenCalled();
  });
});

describe("warehouse-scope enforcement (loadOrThrow guards every workflow action)", () => {
  // A warehouse-scoped principal carries assignedWarehouseIds; assertWarehouseAccess (real, not
  // mocked here) 403s when the GDN's warehouse isn't in that set. The guard now lives inside
  // loadOrThrow, so dispatch/cancel/delete are all covered by construction.
  const outsider = { type: "user", email: "wm@x.com", assignedWarehouseIds: ["f".repeat(24)] } as never; // no WH_ID
  const insider = { type: "user", email: "wm@x.com", assignedWarehouseIds: [WH_ID] } as never;

  beforeEach(() => {
    mockFindById.mockResolvedValue(gdnRow({ status: "draft" }));
  });

  it("blocks a scoped actor without access from dispatching (before any inventory move)", async () => {
    await expect(dispatchGoodsOut(GDN_ID, outsider)).rejects.toThrow(/access to this warehouse/i);
    expect(mockApplyOutbound).not.toHaveBeenCalled();
    expect(mockDispatchTx).not.toHaveBeenCalled();
  });

  it("blocks a scoped actor without access from cancelling", async () => {
    await expect(cancelGoodsOut(GDN_ID, undefined, outsider)).rejects.toThrow(/access to this warehouse/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("blocks a scoped actor without access from deleting", async () => {
    await expect(deleteGoodsOut(GDN_ID, outsider)).rejects.toThrow(/access to this warehouse/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("allows a scoped actor WITH access to act on the GDN", async () => {
    await expect(deleteGoodsOut(GDN_ID, insider)).resolves.toBeUndefined();
    expect(mockSoftDelete).toHaveBeenCalledWith(GDN_ID);
  });
});

describe("cancel + delete (draft-only)", () => {
  it("cancels a draft", async () => {
    mockFindById.mockResolvedValue(gdnRow({ status: "draft" }));
    mockUpdate.mockResolvedValue(gdnRow({ status: "cancelled" }));
    const r = await cancelGoodsOut(GDN_ID, "No longer needed");
    expect(r.status).toBe("cancelled");
    expect(auditActions()).toContain("goods_out.cancelled");
  });

  it("blocks cancelling a dispatched GDN", async () => {
    mockFindById.mockResolvedValue(gdnRow({ status: "dispatched" }));
    await expect(cancelGoodsOut(GDN_ID, undefined)).rejects.toThrow(/can't move/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("soft-deletes a draft but blocks deleting a dispatched GDN", async () => {
    mockFindById.mockResolvedValue(gdnRow({ status: "draft" }));
    await expect(deleteGoodsOut(GDN_ID)).resolves.toBeUndefined();
    expect(mockSoftDelete).toHaveBeenCalledWith(GDN_ID);

    vi.clearAllMocks();
    mockFindById.mockResolvedValue(gdnRow({ status: "dispatched" }));
    await expect(deleteGoodsOut(GDN_ID)).rejects.toThrow(/only draft/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });
});
