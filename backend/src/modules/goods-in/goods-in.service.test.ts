import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./goods-in.repository.js", () => ({
  findById: vi.fn(),
  findByCode: vi.fn(),
  findByIdTx: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  createWithCode: vi.fn(),
  replaceItemsAndChildren: vi.fn(),
  completeTx: vi.fn(),
  findIrmTrackFlags: vi.fn(),
  findSerialConflicts: vi.fn(),
  addAttachment: vi.fn(),
  findAttachment: vi.fn(),
  removeAttachment: vi.fn(),
}));
vi.mock("#modules/purchase-order/purchase-order.service.js", () => ({
  requireReceivablePurchaseOrder: vi.fn(),
  applyGoodsReceipt: vi.fn(),
}));
vi.mock("#modules/inventory/inventory.service.js", () => ({ applyInbound: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadFileToCloudinary: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));

import * as grnRepo from "./goods-in.repository.js";
import * as poService from "#modules/purchase-order/purchase-order.service.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as audit from "#modules/audit/audit.service.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { uploadFileToCloudinary } from "../../lib/cloudinary.js";
import { addAttachment, cancelGoodsReceipt, completeGoodsReceipt, createGoodsReceipt, deleteGoodsReceipt, removeAttachment, updateGoodsReceipt } from "./goods-in.service.js";

const GRN_ID = "e".repeat(24);
const PO_ID = "f".repeat(24);
const POI_ID = "a".repeat(24);
const SUP_ID = "b".repeat(24);
const IRM_ID = "c".repeat(24);
const WH_ID = "d".repeat(24);

function poForReceipt(over: Record<string, unknown> = {}) {
  return {
    id: PO_ID,
    code: "PO-0001",
    status: "sent",
    supplierId: SUP_ID,
    supplierName: "Acme",
    warehouseId: WH_ID,
    items: [{ id: POI_ID, irmItemId: IRM_ID, itemName: "CAT6", sku: "C6", baseUnit: "Each", quantity: 10, receivedQuantity: 0 }],
    ...over,
  };
}

function grnItem(over: Record<string, unknown> = {}) {
  return {
    id: "gi1",
    purchaseOrderItemId: POI_ID,
    irmItemId: IRM_ID,
    itemName: "CAT6",
    sku: "C6",
    baseUnit: "Each",
    orderedQuantity: 10,
    previouslyReceived: 0,
    receivedQuantity: 6,
    damagedQuantity: 1,
    acceptedQuantity: 5,
    notes: null,
    serials: [],
    batches: [],
    irmItem: { id: IRM_ID, code: "IRM-0001", name: "CAT6", status: "active", trackSerialNumbers: false, trackBatchNumbers: false, trackInventory: true },
    ...over,
  };
}

function grnRow(over: Record<string, unknown> = {}) {
  return {
    id: GRN_ID,
    code: "GRN-0001",
    purchaseOrderId: PO_ID,
    poCode: "PO-0001",
    purchaseOrder: { id: PO_ID, code: "PO-0001", status: "sent", supplier: { id: SUP_ID, code: "SUP-0001", name: "Acme", contactPerson: null, contactEmail: null, contactPhone: null } },
    supplierId: SUP_ID,
    supplierName: "Acme",
    warehouseId: WH_ID,
    warehouse: { id: WH_ID, code: "WH-0001", name: "Leeds", addressLine1: null, addressLine2: null, city: null, county: null, postcode: null, country: null },
    status: "draft",
    receivedDate: new Date("2026-06-15T00:00:00Z"),
    referenceNumber: null,
    carrier: null,
    deliveryNoteNumber: null,
    vehicleRegistration: null,
    description: null,
    qualityStatus: "passed",
    qualityNotes: null,
    internalNotes: null,
    items: [],
    attachments: [],
    createdBy: null,
    completedBy: null,
    completedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    updatedBy: null,
    deletedAt: null,
    createdAt: new Date("2026-06-15T00:00:00Z"),
    updatedAt: new Date("2026-06-15T00:00:00Z"),
    ...over,
  };
}

const mockFindById = grnRepo.findById as ReturnType<typeof vi.fn>;
const mockFindByIdTx = grnRepo.findByIdTx as ReturnType<typeof vi.fn>;
const mockUpdate = grnRepo.update as ReturnType<typeof vi.fn>;
const mockSoftDelete = grnRepo.softDelete as ReturnType<typeof vi.fn>;
const mockCreateWithCode = grnRepo.createWithCode as ReturnType<typeof vi.fn>;
const mockCompleteTx = grnRepo.completeTx as ReturnType<typeof vi.fn>;
const mockFlags = grnRepo.findIrmTrackFlags as ReturnType<typeof vi.fn>;
const mockSerialConflicts = grnRepo.findSerialConflicts as ReturnType<typeof vi.fn>;
const mockReqReceivable = poService.requireReceivablePurchaseOrder as ReturnType<typeof vi.fn>;
const mockApplyReceipt = poService.applyGoodsReceipt as ReturnType<typeof vi.fn>;
const mockApplyInbound = inventoryService.applyInbound as ReturnType<typeof vi.fn>;
const mockAudit = audit.record as ReturnType<typeof vi.fn>;
const auditActions = () => mockAudit.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) => Promise.resolve(grnRow(data)));
  mockReqReceivable.mockResolvedValue(poForReceipt());
  mockFlags.mockResolvedValue([{ id: IRM_ID, trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: false }]);
  mockSerialConflicts.mockResolvedValue([]);
  mockCreateWithCode.mockImplementation((header: Record<string, unknown>) => Promise.resolve(grnRow({ ...header, items: [] })));
});

describe("createGoodsReceipt — quantity maths + snapshots", () => {
  it("computes accepted = received − damaged and snapshots ordered + previouslyReceived", async () => {
    await createGoodsReceipt(
      { purchaseOrderId: PO_ID, receivedDate: "2026-06-15", items: [{ purchaseOrderItemId: POI_ID, receivedQuantity: 6, damagedQuantity: 1 }] } as Parameters<typeof createGoodsReceipt>[0],
      { type: "admin", email: "wh@x.com" },
    );
    const [header, lines] = mockCreateWithCode.mock.calls[0];
    expect(header).toMatchObject({ purchaseOrderId: PO_ID, poCode: "PO-0001", supplierName: "Acme", warehouseId: WH_ID, status: "draft" });
    expect(lines[0]).toMatchObject({ itemName: "CAT6", orderedQuantity: 10, previouslyReceived: 0, receivedQuantity: 6, damagedQuantity: 1, acceptedQuantity: 5 });
    expect(auditActions()).toContain("goods_in.created");
  });

  it("rejects receiving more than the remaining quantity", async () => {
    mockReqReceivable.mockResolvedValue(poForReceipt({ items: [{ id: POI_ID, irmItemId: IRM_ID, itemName: "CAT6", sku: null, baseUnit: null, quantity: 10, receivedQuantity: 8 }] }));
    await expect(
      createGoodsReceipt({ purchaseOrderId: PO_ID, receivedDate: "2026-06-15", items: [{ purchaseOrderItemId: POI_ID, receivedQuantity: 5 }] } as Parameters<typeof createGoodsReceipt>[0]),
    ).rejects.toThrow(/remaining/i);
    expect(mockCreateWithCode).not.toHaveBeenCalled();
  });

  it("requires exactly `accepted` serial numbers for a serial-tracked item", async () => {
    mockFlags.mockResolvedValue([{ id: IRM_ID, trackInventory: true, trackSerialNumbers: true, trackBatchNumbers: false }]);
    await expect(
      createGoodsReceipt(
        { purchaseOrderId: PO_ID, receivedDate: "2026-06-15", items: [{ purchaseOrderItemId: POI_ID, receivedQuantity: 5, damagedQuantity: 0, serials: ["S1", "S2"] }] } as Parameters<typeof createGoodsReceipt>[0],
      ),
    ).rejects.toThrow(/serial/i);
  });

  it("requires batch quantities to total `accepted` for a batch-tracked item", async () => {
    mockFlags.mockResolvedValue([{ id: IRM_ID, trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: true }]);
    await expect(
      createGoodsReceipt(
        { purchaseOrderId: PO_ID, receivedDate: "2026-06-15", items: [{ purchaseOrderItemId: POI_ID, receivedQuantity: 5, damagedQuantity: 0, batches: [{ batchNumber: "B1", quantity: 4 }] }] } as Parameters<typeof createGoodsReceipt>[0],
      ),
    ).rejects.toThrow(/total 5/i);
  });

  it("blocks a serial already received elsewhere", async () => {
    mockFlags.mockResolvedValue([{ id: IRM_ID, trackInventory: true, trackSerialNumbers: true, trackBatchNumbers: false }]);
    mockSerialConflicts.mockResolvedValue([{ serialLower: "s1" }]);
    await expect(
      createGoodsReceipt(
        { purchaseOrderId: PO_ID, receivedDate: "2026-06-15", items: [{ purchaseOrderItemId: POI_ID, receivedQuantity: 1, damagedQuantity: 0, serials: ["S1"] }] } as Parameters<typeof createGoodsReceipt>[0],
      ),
    ).rejects.toThrow(/already received/i);
  });
});

describe("completeGoodsReceipt — the only inventory-writing action", () => {
  it("posts inventory by ACCEPTED, advances the PO, and stamps completed", async () => {
    mockFindById
      .mockResolvedValueOnce(grnRow({ status: "draft", items: [grnItem()] })) // loadOrThrow (pre-tx)
      .mockResolvedValueOnce(grnRow({ status: "completed", items: [grnItem()] })); // final getGoodsReceipt
    mockFindByIdTx.mockResolvedValue(grnRow({ status: "draft", items: [grnItem()] })); // in-tx revalidation
    const r = await completeGoodsReceipt(GRN_ID, { type: "admin", email: "wh@x.com" });

    // inventory increases by accepted (5), not received (6); damaged excluded.
    expect(mockApplyInbound).toHaveBeenCalledTimes(1);
    expect(mockApplyInbound.mock.calls[0][1]).toMatchObject({ irmItemId: IRM_ID, warehouseId: WH_ID, quantity: 5, sourceType: "goods_receipt", sourceCode: "GRN-0001" });
    // PO advanced with the received delta (6).
    expect(mockApplyReceipt).toHaveBeenCalledWith({}, PO_ID, [{ purchaseOrderItemId: POI_ID, receivedDelta: 6 }], { type: "admin", email: "wh@x.com" });
    expect(mockCompleteTx).toHaveBeenCalledWith({}, GRN_ID, "wh@x.com");
    expect(auditActions()).toContain("goods_in.completed");
    expect(r.status).toBe("completed");
  });

  it("does NOT write inventory for an item that doesn't track inventory", async () => {
    mockFindById
      .mockResolvedValueOnce(grnRow({ status: "draft", items: [grnItem({ irmItem: { ...grnItem().irmItem, trackInventory: false } })] }))
      .mockResolvedValueOnce(grnRow({ status: "completed", items: [] }));
    mockFindByIdTx.mockResolvedValue(grnRow({ status: "draft", items: [grnItem({ irmItem: { ...grnItem().irmItem, trackInventory: false } })] }));
    await completeGoodsReceipt(GRN_ID);
    expect(mockApplyInbound).not.toHaveBeenCalled();
    expect(mockApplyReceipt).toHaveBeenCalled(); // PO still advances
  });

  it("rejects completing an already-completed receipt", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "completed", items: [grnItem()] }));
    await expect(completeGoodsReceipt(GRN_ID)).rejects.toThrow(/can't move/i);
    expect(mockApplyInbound).not.toHaveBeenCalled();
  });
});

// In-transaction revalidation: completion must re-read the GRN inside the tx and refuse to act on a
// stale snapshot — closing the double-complete and edit-vs-complete races. No inventory/PO writes
// may happen when the in-tx check fails.
describe("completeGoodsReceipt — in-transaction revalidation (race guards)", () => {
  it("double-complete: rejects when another request already completed it inside the tx (no writes)", async () => {
    mockFindById.mockResolvedValueOnce(grnRow({ status: "draft", items: [grnItem()] })); // pre-tx sees draft
    mockFindByIdTx.mockResolvedValue(grnRow({ status: "completed", items: [grnItem()] })); // concurrent winner won
    await expect(completeGoodsReceipt(GRN_ID)).rejects.toThrow(/just completed or cancelled|refresh/i);
    expect(mockApplyReceipt).not.toHaveBeenCalled();
    expect(mockApplyInbound).not.toHaveBeenCalled();
    expect(mockCompleteTx).not.toHaveBeenCalled();
  });

  it("edit-vs-complete: rejects when the GRN was modified (updatedAt moved) inside the tx (no writes)", async () => {
    mockFindById.mockResolvedValueOnce(grnRow({ status: "draft", items: [grnItem()], updatedAt: new Date("2026-06-15T00:00:00Z") }));
    mockFindByIdTx.mockResolvedValue(
      grnRow({ status: "draft", items: [grnItem({ receivedQuantity: 9, acceptedQuantity: 9 })], updatedAt: new Date("2026-06-15T10:00:00Z") }),
    );
    await expect(completeGoodsReceipt(GRN_ID)).rejects.toThrow(/modified|refresh/i);
    expect(mockApplyReceipt).not.toHaveBeenCalled();
    expect(mockApplyInbound).not.toHaveBeenCalled();
    expect(mockCompleteTx).not.toHaveBeenCalled();
  });

  it("uses the FRESH in-tx items, not the pre-tx snapshot", async () => {
    // pre-tx snapshot says received 6 / accepted 5; fresh (same updatedAt) says received 4 / accepted 4.
    mockFindById
      .mockResolvedValueOnce(grnRow({ status: "draft", items: [grnItem()] }))
      .mockResolvedValueOnce(grnRow({ status: "completed", items: [] }));
    mockFindByIdTx.mockResolvedValue(grnRow({ status: "draft", items: [grnItem({ receivedQuantity: 4, damagedQuantity: 0, acceptedQuantity: 4 })] }));
    await completeGoodsReceipt(GRN_ID);
    expect(mockApplyReceipt).toHaveBeenCalledWith({}, PO_ID, [{ purchaseOrderItemId: POI_ID, receivedDelta: 4 }], undefined);
    expect(mockApplyInbound.mock.calls[0][1]).toMatchObject({ quantity: 4 });
  });
});

describe("cancel + draft-only guards", () => {
  it("cancels a draft receipt", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "draft" }));
    const r = await cancelGoodsReceipt(GRN_ID, "Wrong delivery", { type: "admin", email: "x@x.com" });
    expect(r.status).toBe("cancelled");
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({ status: "cancelled", cancelReason: "Wrong delivery" });
    expect(auditActions()).toContain("goods_in.cancelled");
  });

  it("blocks cancelling a completed receipt", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "completed" }));
    await expect(cancelGoodsReceipt(GRN_ID, undefined)).rejects.toThrow(/can't move/i);
  });

  it("blocks editing a non-draft receipt", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "completed" }));
    await expect(updateGoodsReceipt(GRN_ID, { description: "x" })).rejects.toThrow(/only draft/i);
  });

  it("blocks deleting a non-draft receipt", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "completed" }));
    await expect(deleteGoodsReceipt(GRN_ID)).rejects.toThrow(/only draft/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("soft-deletes a draft receipt", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "draft" }));
    await expect(deleteGoodsReceipt(GRN_ID)).resolves.toBeUndefined();
    expect(mockSoftDelete).toHaveBeenCalledWith(GRN_ID);
    expect(auditActions()).toContain("goods_in.deleted");
  });
});

describe("attachments — draft-only guard", () => {
  const mockAddAtt = grnRepo.addAttachment as ReturnType<typeof vi.fn>;
  const mockFindAtt = grnRepo.findAttachment as ReturnType<typeof vi.fn>;
  const mockRemoveAtt = grnRepo.removeAttachment as ReturnType<typeof vi.fn>;
  const mockCreds = getCloudinaryCreds as ReturnType<typeof vi.fn>;
  const mockUpload = uploadFileToCloudinary as ReturnType<typeof vi.fn>;
  const att = { label: "Invoice", fileName: "inv.pdf", fileType: "pdf", fileSizeBytes: 1000, data: "data:application/pdf;base64,AAAA" } as Parameters<typeof addAttachment>[1];

  it("adds an attachment on a DRAFT receipt", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "draft" }));
    mockCreds.mockResolvedValue({ cloudName: "c", apiKey: "k", apiSecret: "s" });
    mockUpload.mockResolvedValue("https://cdn/inv.pdf");
    await addAttachment(GRN_ID, att, { type: "admin", email: "x@x.com" });
    expect(mockAddAtt).toHaveBeenCalledTimes(1);
    expect(auditActions()).toContain("goods_in.attachment_added");
  });

  it("blocks adding an attachment on a COMPLETED receipt", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "completed" }));
    await expect(addAttachment(GRN_ID, att)).rejects.toThrow(/only draft/i);
    expect(mockAddAtt).not.toHaveBeenCalled();
  });

  it("blocks removing an attachment on a CANCELLED receipt", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "cancelled" }));
    await expect(removeAttachment(GRN_ID, "att1")).rejects.toThrow(/only draft/i);
    expect(mockFindAtt).not.toHaveBeenCalled();
    expect(mockRemoveAtt).not.toHaveBeenCalled();
  });
});
