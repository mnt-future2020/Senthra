import { beforeEach, describe, expect, it, vi } from "vitest";

// The inventory repository is the only Prisma touch-point; mock every function the service calls so
// these stay pure unit tests (the real atomic transfer is exercised by the DB smoke script).
vi.mock("./inventory.repository.js", () => ({
  upsertBalanceTx: vi.fn(),
  insertTransactionTx: vi.fn(),
  findBalance: vi.fn(),
  listBalances: vi.fn(),
  listTransactions: vi.fn(),
  findAllBalances: vi.fn(),
  findBalances: vi.fn(),
  countBalances: vi.fn(),
  findBalanceById: vi.fn(),
  findBalancePair: vi.fn(),
  findBalancePairWithRelations: vi.fn(),
  findBalancePairTx: vi.fn(),
  findTransactions: vi.fn(),
  countTransactions: vi.fn(),
  findTransfers: vi.fn(),
  countTransfers: vi.fn(),
  findTransferById: vi.fn(),
  createTransferWithCode: vi.fn(),
}));
vi.mock("#modules/warehouse/warehouse.service.js", () => ({ requireActiveWarehouse: vi.fn() }));
vi.mock("#modules/purchase-order/purchase-order.service.js", () => ({ incomingForItemWarehouse: vi.fn() }));
vi.mock("#modules/goods-in/goods-in.repository.js", () => ({ receivedHistoryForItemWarehouse: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as inventoryRepo from "./inventory.repository.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as audit from "#modules/audit/audit.service.js";
import { applyInbound, applyOutbound, listInventory, transferStock } from "./inventory.service.js";

const IRM_ID = "c".repeat(24);
const WH_ID = "d".repeat(24);
const GRN_ID = "e".repeat(24);
const FROM_WH = "a".repeat(24);
const TO_WH = "b".repeat(24);
const tx = {} as never;

const mockUpsert = inventoryRepo.upsertBalanceTx as ReturnType<typeof vi.fn>;
const mockInsert = inventoryRepo.insertTransactionTx as ReturnType<typeof vi.fn>;
const mockFindAll = inventoryRepo.findAllBalances as ReturnType<typeof vi.fn>;
const mockFindPairRel = inventoryRepo.findBalancePairWithRelations as ReturnType<typeof vi.fn>;
const mockFindPairTx = inventoryRepo.findBalancePairTx as ReturnType<typeof vi.fn>;
const mockCreateTransfer = inventoryRepo.createTransferWithCode as ReturnType<typeof vi.fn>;
const mockReqWarehouse = warehouseService.requireActiveWarehouse as ReturnType<typeof vi.fn>;
const mockAudit = audit.record as ReturnType<typeof vi.fn>;

// An InventoryBalance row with the relations the list/transfer DTOs read.
function balRow(over: { onHand?: number; reserved?: number; item?: Record<string, unknown> } = {}) {
  return {
    id: "bal_" + (over.onHand ?? 0),
    irmItemId: IRM_ID,
    warehouseId: WH_ID,
    quantityOnHand: over.onHand ?? 0,
    quantityReserved: over.reserved ?? 0,
    updatedAt: new Date("2026-06-10T00:00:00Z"),
    createdAt: new Date("2026-06-01T00:00:00Z"),
    irmItem: {
      id: IRM_ID,
      code: "IRM-0001",
      name: "CAT6 Cable",
      sku: "C6-305",
      baseUnit: "Metre",
      status: "active",
      reorderLevel: 10,
      standardCostPence: 250,
      currency: "GBP",
      trackSerialNumbers: false,
      trackBatchNumbers: false,
      trackInventory: true,
      irmCategory: { id: "cat1", name: "Cabling" },
      ...over.item,
    },
    warehouse: { id: WH_ID, code: "WH-0001", name: "Leeds" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyInbound / applyOutbound (inventory primitives)", () => {
  it("inbound upserts +qty and appends a goods_in ledger row with the post-apply snapshot", async () => {
    mockUpsert.mockResolvedValue({ quantityOnHand: 25 });
    await applyInbound(tx, { irmItemId: IRM_ID, warehouseId: WH_ID, quantity: 5, sourceType: "goods_receipt", sourceId: GRN_ID, sourceCode: "GRN-0001", createdBy: "wh@x.com" });

    expect(mockUpsert).toHaveBeenCalledWith(tx, IRM_ID, WH_ID, 5);
    expect(mockInsert.mock.calls[0][1]).toMatchObject({
      irmItemId: IRM_ID, warehouseId: WH_ID, quantityDelta: 5, type: "goods_in",
      sourceType: "goods_receipt", sourceId: GRN_ID, sourceCode: "GRN-0001", balanceAfter: 25, createdBy: "wh@x.com",
    });
  });

  it("outbound upserts −qty and appends a goods_out ledger row (future Goods Out seam)", async () => {
    mockUpsert.mockResolvedValue({ quantityOnHand: 20 });
    await applyOutbound(tx, { irmItemId: IRM_ID, warehouseId: WH_ID, quantity: 5, sourceType: "goods_out", sourceId: GRN_ID });

    expect(mockUpsert).toHaveBeenCalledWith(tx, IRM_ID, WH_ID, -5);
    expect(mockInsert.mock.calls[0][1]).toMatchObject({ quantityDelta: -5, type: "goods_out", balanceAfter: 20 });
  });

  it("is a no-op for a zero / negative quantity", async () => {
    await applyInbound(tx, { irmItemId: IRM_ID, warehouseId: WH_ID, quantity: 0, sourceType: "goods_receipt", sourceId: GRN_ID });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("listInventory — server-authoritative status / available / value math", () => {
  it("computes available = onHand − reserved, valuePence = onHand × cost, and the total value", async () => {
    mockFindAll.mockResolvedValue([balRow({ onHand: 10, reserved: 3 }), balRow({ onHand: 4, reserved: 0 })]);
    const res = await listInventory({});
    expect(res.inventory[0]).toMatchObject({ onHand: 10, reserved: 3, available: 7, valuePence: 2500, value: 25 });
    expect(res.inventory[1]).toMatchObject({ onHand: 4, available: 4, valuePence: 1000, value: 10 });
    // 10×250 + 4×250 = 3500 pence.
    expect(res.totalValuePence).toBe(3500);
    expect(res.totalValue).toBe(35);
    expect(res.total).toBe(2);
  });

  it("derives status: 0 → out_of_stock, ≤ reorderLevel → low_stock, else in_stock", async () => {
    mockFindAll.mockResolvedValue([
      balRow({ onHand: 0 }), // out
      balRow({ onHand: 8, item: { reorderLevel: 10 } }), // low (≤10)
      balRow({ onHand: 50, item: { reorderLevel: 10 } }), // in
    ]);
    const res = await listInventory({});
    expect(res.inventory.map((r) => r.status)).toEqual(["out_of_stock", "low_stock", "in_stock"]);
  });

  it("treats a null reorderLevel as 0 (any positive on-hand is in_stock)", async () => {
    mockFindAll.mockResolvedValue([balRow({ onHand: 1, item: { reorderLevel: null } })]);
    expect((await listInventory({})).inventory[0].status).toBe("in_stock");
  });

  it("filters by computed status in-service (low_stock only)", async () => {
    mockFindAll.mockResolvedValue([
      balRow({ onHand: 0 }),
      balRow({ onHand: 8, item: { reorderLevel: 10 } }),
      balRow({ onHand: 50, item: { reorderLevel: 10 } }),
    ]);
    const res = await listInventory({ status: "low_stock" });
    expect(res.inventory).toHaveLength(1);
    expect(res.inventory[0].status).toBe("low_stock");
  });
});

describe("transferStock — guards", () => {
  const base = { irmItemId: IRM_ID, fromWarehouseId: FROM_WH, toWarehouseId: TO_WH, quantity: 5, movementDate: "2026-06-15" };

  beforeEach(() => {
    mockReqWarehouse.mockImplementation((id: string) =>
      Promise.resolve(id === FROM_WH ? { id: FROM_WH, name: "Leeds", code: "WH-0001" } : { id: TO_WH, name: "Manchester", code: "WH-0002" }),
    );
  });

  it("rejects a self-transfer (source === destination) before touching the repository", async () => {
    await expect(transferStock({ ...base, toWarehouseId: FROM_WH })).rejects.toThrow(/must be different/i);
    expect(mockReqWarehouse).not.toHaveBeenCalled();
    expect(mockCreateTransfer).not.toHaveBeenCalled();
  });

  it("rejects a non-positive quantity", async () => {
    await expect(transferStock({ ...base, quantity: 0 })).rejects.toThrow(/greater than zero/i);
    expect(mockCreateTransfer).not.toHaveBeenCalled();
  });

  it("rejects when there is no stock of the item at the source", async () => {
    mockFindPairRel.mockResolvedValue(null);
    await expect(transferStock(base)).rejects.toThrow(/no stock/i);
    expect(mockCreateTransfer).not.toHaveBeenCalled();
  });

  it("rejects a serial-tracked item", async () => {
    mockFindPairRel.mockResolvedValue(balRow({ onHand: 100, item: { trackSerialNumbers: true } }));
    await expect(transferStock(base)).rejects.toThrow(/serial-tracked|batch-tracked/i);
    expect(mockCreateTransfer).not.toHaveBeenCalled();
  });

  it("rejects a batch-tracked item", async () => {
    mockFindPairRel.mockResolvedValue(balRow({ onHand: 100, item: { trackBatchNumbers: true } }));
    await expect(transferStock(base)).rejects.toThrow(/serial-tracked|batch-tracked/i);
    expect(mockCreateTransfer).not.toHaveBeenCalled();
  });

  it("rejects when quantity exceeds available (onHand − reserved)", async () => {
    mockFindPairRel.mockResolvedValue(balRow({ onHand: 6, reserved: 3 })); // available = 3
    await expect(transferStock({ ...base, quantity: 5 })).rejects.toThrow(/only 3 available/i);
    expect(mockCreateTransfer).not.toHaveBeenCalled();
  });
});

describe("transferStock — happy path", () => {
  const base = { irmItemId: IRM_ID, fromWarehouseId: FROM_WH, toWarehouseId: TO_WH, quantity: 5, movementDate: "2026-06-15", referenceNumber: "  REF-9 " };
  const actor = { email: "ops@x.com" } as never;

  function transferRow(over: Record<string, unknown> = {}) {
    return {
      id: "trf1", code: "TRF-0001", irmItemId: IRM_ID, itemName: "CAT6 Cable", sku: "C6-305",
      fromWarehouseId: FROM_WH, fromWarehouseName: "Leeds", fromWarehouseCode: "WH-0001",
      toWarehouseId: TO_WH, toWarehouseName: "Manchester", toWarehouseCode: "WH-0002",
      quantity: 5, movementDate: new Date("2026-06-15T00:00:00Z"), status: "completed",
      referenceNumber: "REF-9", description: null, internalNotes: null, createdBy: "ops@x.com",
      deletedAt: null, createdAt: new Date("2026-06-15T10:00:00Z"), updatedAt: new Date("2026-06-15T10:00:00Z"),
      ...over,
    };
  }

  beforeEach(() => {
    mockReqWarehouse.mockImplementation((id: string) =>
      Promise.resolve(id === FROM_WH ? { id: FROM_WH, name: "Leeds", code: "WH-0001" } : { id: TO_WH, name: "Manchester", code: "WH-0002" }),
    );
    mockFindPairRel.mockResolvedValue(balRow({ onHand: 100, reserved: 0 }));
    mockCreateTransfer.mockImplementation((header: Record<string, unknown>) => Promise.resolve(transferRow(header)));
  });

  it("snapshots names + trims the reference, sets status completed, and records the audit post-commit", async () => {
    const dto = await transferStock(base, actor);

    const [header, ledger] = mockCreateTransfer.mock.calls[0];
    expect(header).toMatchObject({
      irmItemId: IRM_ID, itemName: "CAT6 Cable", sku: "C6-305",
      fromWarehouseName: "Leeds", fromWarehouseCode: "WH-0001",
      toWarehouseName: "Manchester", toWarehouseCode: "WH-0002",
      quantity: 5, status: "completed", referenceNumber: "REF-9", createdBy: "ops@x.com",
    });
    expect(ledger).toMatchObject({ irmItemId: IRM_ID, fromWarehouseId: FROM_WH, toWarehouseId: TO_WH, quantity: 5, createdBy: "ops@x.com" });
    expect(dto).toMatchObject({ code: "TRF-0001", quantity: 5, status: "completed" });

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ action: "inventory.transfer", targetType: "stock_transfer", targetId: "trf1", targetLabel: "TRF-0001" });
  });

  it("re-validates the LIVE source balance inside the transaction (concurrency backstop)", async () => {
    await transferStock(base, actor);
    const validate = mockCreateTransfer.mock.calls[0][2] as (tx: unknown) => Promise<void>;

    // Enough live stock → resolves.
    mockFindPairTx.mockResolvedValueOnce({ quantityOnHand: 100, quantityReserved: 0 });
    await expect(validate(tx)).resolves.toBeUndefined();

    // Source drained by a racing transfer → rolls the whole thing back.
    mockFindPairTx.mockResolvedValueOnce({ quantityOnHand: 1, quantityReserved: 0 });
    await expect(validate(tx)).rejects.toThrow(/source stock changed|not enough/i);
  });
});
