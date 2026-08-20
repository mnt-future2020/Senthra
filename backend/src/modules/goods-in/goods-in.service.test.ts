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
  recordReceiptStatusChange: vi.fn(),
}));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/inventory/inventory.service.js", () => ({ applyInbound: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));
vi.mock("#modules/attachment/attachment.service.js", () => ({ releaseAsset: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadFileToCloudinary: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));

import * as grnRepo from "./goods-in.repository.js";
import * as poService from "#modules/purchase-order/purchase-order.service.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as audit from "#modules/audit/audit.service.js";
import * as attachmentService from "#modules/attachment/attachment.service.js";
import { assertCanAttach, cancelGoodsReceipt, completeGoodsReceipt, createGoodsReceipt, deleteGoodsReceipt, getGoodsReceipt, removeAttachment, updateGoodsReceipt } from "./goods-in.service.js";

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
    deliveryNoteNumber: "DN-0001", // present by default so complete-path tests pass the DN guard
    vehicleRegistration: null,
    description: null,
    qualityStatus: "passed",
    qualityNotes: null,
    internalNotes: null,
    items: [],
    rentalItems: [],
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
const mockPoRepoFindById = poRepo.findById as ReturnType<typeof vi.fn>;
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

describe("getGoodsReceipt — previouslyReceived freshness", () => {
  it("recomputes a DRAFT's previouslyReceived LIVE from the PO (stale snapshot ignored)", async () => {
    // Draft created when nothing was received (snapshot 0); since then a sibling GRN received 70.
    mockFindById.mockResolvedValue(
      grnRow({ status: "draft", items: [grnItem({ orderedQuantity: 100, previouslyReceived: 0, receivedQuantity: 30 })] }),
    );
    mockPoRepoFindById.mockResolvedValue({ id: PO_ID, items: [{ id: POI_ID, quantity: 100, receivedQuantity: 70 }] });

    const grn = await getGoodsReceipt(GRN_ID);

    // The form computes remaining = ordered − previouslyReceived = 100 − 70 = 30 (not 100).
    expect(grn.items[0].previouslyReceived).toBe(70);
    expect(mockPoRepoFindById).toHaveBeenCalledWith(PO_ID);
  });

  // A completed GRN's own units are now IN the PO line's receivedQuantity, so a live read would
  // count them as "previously received" against itself. Its snapshot is the history.
  it("keeps a COMPLETED GRN's frozen snapshot (no live lookup)", async () => {
    mockFindById.mockResolvedValue(
      grnRow({ status: "completed", items: [grnItem({ orderedQuantity: 100, previouslyReceived: 70, receivedQuantity: 30 })] }),
    );

    const grn = await getGoodsReceipt(GRN_ID);

    expect(grn.items[0].previouslyReceived).toBe(70);
    expect(mockPoRepoFindById).not.toHaveBeenCalled();
  });

  // A cancelled receipt never posted, so — exactly like a draft — the PO's live figure excludes it
  // and is the honest answer. Reverting it to the creation-time snapshot made Prev. visibly CHANGE at
  // the moment of cancelling (1 → 0 in the case that surfaced this), which reads as though cancelling
  // had reversed a receipt somewhere. Cancelling moves no stock and moves no PO quantity.
  it("recomputes a CANCELLED GRN's previouslyReceived live, so cancelling never moves the number", async () => {
    const items = [grnItem({ orderedQuantity: 100, previouslyReceived: 0, receivedQuantity: 30 })];
    mockPoRepoFindById.mockResolvedValue({ id: PO_ID, items: [{ id: POI_ID, quantity: 100, receivedQuantity: 70 }] });

    mockFindById.mockResolvedValue(grnRow({ status: "draft", items }));
    const asDraft = await getGoodsReceipt(GRN_ID);

    mockFindById.mockResolvedValue(grnRow({ status: "cancelled", items }));
    const asCancelled = await getGoodsReceipt(GRN_ID);

    expect(asCancelled.items[0].previouslyReceived).toBe(70);
    expect(asCancelled.items[0].previouslyReceived).toBe(asDraft.items[0].previouslyReceived);
  });
});

describe("createGoodsReceipt — quantity maths + snapshots", () => {
  it("derives damaged = received − accepted and snapshots ordered + previouslyReceived", async () => {
    await createGoodsReceipt(
      { purchaseOrderId: PO_ID, receivedDate: "2026-06-15", items: [{ purchaseOrderItemId: POI_ID, receivedQuantity: 6, acceptedQuantity: 5 }] } as Parameters<typeof createGoodsReceipt>[0],
      { type: "admin", email: "wh@x.com" },
    );
    const [header, lines] = mockCreateWithCode.mock.calls[0];
    expect(header).toMatchObject({ purchaseOrderId: PO_ID, poCode: "PO-0001", supplierName: "Acme", warehouseId: WH_ID, status: "draft" });
    expect(lines[0]).toMatchObject({ itemName: "CAT6", orderedQuantity: 10, previouslyReceived: 0, receivedQuantity: 6, damagedQuantity: 1, acceptedQuantity: 5 });
    expect(auditActions()).toContain("goods_in.created");
  });

  it("rejects accepting more than was received", async () => {
    await expect(
      createGoodsReceipt(
        { purchaseOrderId: PO_ID, receivedDate: "2026-06-15", items: [{ purchaseOrderItemId: POI_ID, receivedQuantity: 4, acceptedQuantity: 5 }] } as Parameters<typeof createGoodsReceipt>[0],
      ),
    ).rejects.toThrow(/accepted quantity can't exceed received/i);
    expect(mockCreateWithCode).not.toHaveBeenCalled();
  });

  it("records a fully rejected line as all-damaged, none accepted", async () => {
    await createGoodsReceipt(
      { purchaseOrderId: PO_ID, receivedDate: "2026-06-15", items: [{ purchaseOrderItemId: POI_ID, receivedQuantity: 4, acceptedQuantity: 0 }] } as Parameters<typeof createGoodsReceipt>[0],
      { type: "admin", email: "wh@x.com" },
    );
    const [, lines] = mockCreateWithCode.mock.calls[0];
    expect(lines[0]).toMatchObject({ receivedQuantity: 4, damagedQuantity: 4, acceptedQuantity: 0 });
  });

  it("rejects receiving more than the remaining quantity", async () => {
    mockReqReceivable.mockResolvedValue(poForReceipt({ items: [{ id: POI_ID, irmItemId: IRM_ID, itemName: "CAT6", sku: null, baseUnit: null, quantity: 10, receivedQuantity: 8 }] }));
    await expect(
      createGoodsReceipt({ purchaseOrderId: PO_ID, receivedDate: "2026-06-15", items: [{ purchaseOrderItemId: POI_ID, receivedQuantity: 5, acceptedQuantity: 5 }] } as Parameters<typeof createGoodsReceipt>[0]),
    ).rejects.toThrow(/remaining/i);
    expect(mockCreateWithCode).not.toHaveBeenCalled();
  });

  it("requires exactly `accepted` serial numbers for a serial-tracked item", async () => {
    mockFlags.mockResolvedValue([{ id: IRM_ID, trackInventory: true, trackSerialNumbers: true, trackBatchNumbers: false }]);
    await expect(
      createGoodsReceipt(
        { purchaseOrderId: PO_ID, receivedDate: "2026-06-15", items: [{ purchaseOrderItemId: POI_ID, receivedQuantity: 5, acceptedQuantity: 5, serials: ["S1", "S2"] }] } as Parameters<typeof createGoodsReceipt>[0],
      ),
    ).rejects.toThrow(/serial/i);
  });

  it("requires batch quantities to total `accepted` for a batch-tracked item", async () => {
    mockFlags.mockResolvedValue([{ id: IRM_ID, trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: true }]);
    await expect(
      createGoodsReceipt(
        { purchaseOrderId: PO_ID, receivedDate: "2026-06-15", items: [{ purchaseOrderItemId: POI_ID, receivedQuantity: 5, acceptedQuantity: 5, batches: [{ batchNumber: "B1", quantity: 4 }] }] } as Parameters<typeof createGoodsReceipt>[0],
      ),
    ).rejects.toThrow(/total 5/i);
  });

  it("blocks a serial already received elsewhere", async () => {
    mockFlags.mockResolvedValue([{ id: IRM_ID, trackInventory: true, trackSerialNumbers: true, trackBatchNumbers: false }]);
    mockSerialConflicts.mockResolvedValue([{ serialLower: "s1" }]);
    await expect(
      createGoodsReceipt(
        { purchaseOrderId: PO_ID, receivedDate: "2026-06-15", items: [{ purchaseOrderItemId: POI_ID, receivedQuantity: 1, acceptedQuantity: 1, serials: ["S1"] }] } as Parameters<typeof createGoodsReceipt>[0],
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
    expect(mockApplyReceipt).toHaveBeenCalledWith({}, PO_ID, [{ purchaseOrderItemId: POI_ID, receivedDelta: 6 }]);
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

  it("requires a delivery note number before completing (audit anchor)", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "draft", items: [grnItem()], deliveryNoteNumber: "  " }));
    await expect(completeGoodsReceipt(GRN_ID)).rejects.toThrow(/delivery note number/i);
    expect(mockApplyInbound).not.toHaveBeenCalled();
    expect(mockApplyReceipt).not.toHaveBeenCalled();
    expect(mockCompleteTx).not.toHaveBeenCalled();
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
    expect(mockApplyReceipt).toHaveBeenCalledWith({}, PO_ID, [{ purchaseOrderItemId: POI_ID, receivedDelta: 4 }]);
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

// The rules these assert did not move when the base64 endpoint was deleted — they live in
// `assertCanAttach`, which the direct-upload path calls as its preCheck BEFORE minting a signature.
// Testing them there rather than through the old uploader keeps the coverage on the rule itself.
describe("attachments — draft-only guard", () => {
  const mockAddAtt = grnRepo.addAttachment as ReturnType<typeof vi.fn>;
  const mockFindAtt = grnRepo.findAttachment as ReturnType<typeof vi.fn>;
  const mockRemoveAtt = grnRepo.removeAttachment as ReturnType<typeof vi.fn>;

  it("blocks the 6th file (max 5 documents)", async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, fileSizeBytes: 1000 }));
    mockFindById.mockResolvedValue(grnRow({ status: "draft", attachments: five }));
    await expect(assertCanAttach(GRN_ID, 1000)).rejects.toThrow(/at most 5 documents/i);
  });

  it("blocks a file that pushes the running total over 20 MB", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "draft", attachments: [{ id: "a0", fileSizeBytes: 20 * 1024 * 1024 - 100 }] }));
    await expect(assertCanAttach(GRN_ID, 1000)).rejects.toThrow(/20 MB/i);
  });

  // Refused BEFORE a signature is minted, which is the point of running this as a preCheck: an
  // upload the receipt cannot accept never reaches Cloudinary, so there is no orphan to reap.
  it("allows a file that fits", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "draft", attachments: [] }));
    await expect(assertCanAttach(GRN_ID, 1000)).resolves.toBeUndefined();
  });

  it("blocks adding an attachment on a COMPLETED receipt", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "completed" }));
    await expect(assertCanAttach(GRN_ID, 1000)).rejects.toThrow(/only draft/i);
    expect(mockAddAtt).not.toHaveBeenCalled();
  });

  it("blocks removing an attachment on a CANCELLED receipt", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "cancelled" }));
    await expect(removeAttachment(GRN_ID, "att1")).rejects.toThrow(/only draft/i);
    expect(mockFindAtt).not.toHaveBeenCalled();
    expect(mockRemoveAtt).not.toHaveBeenCalled();
  });
});

// GRN attachments are always uploaded fresh, so in practice each row owns its file outright. The
// cleanup still goes through the same reference-counted path rather than deleting directly — the
// next module that copies an attachment would otherwise inherit a silent bug here.
describe("GRN attachments — Cloudinary cleanup", () => {
  const mockFindAtt = grnRepo.findAttachment as ReturnType<typeof vi.fn>;
  const mockRemoveAtt = grnRepo.removeAttachment as ReturnType<typeof vi.fn>;
  const release = attachmentService.releaseAsset as ReturnType<typeof vi.fn>;
  const ATT = { id: "att1", goodsReceiptId: GRN_ID, publicId: "senthra/goods-in/inv.pdf", resourceType: "raw" };

  beforeEach(() => {
    mockFindById.mockResolvedValue(grnRow({ status: "draft" }));
    mockFindAtt.mockResolvedValue(ATT);
  });

  it("hands the removed row's identity to the cleanup", async () => {
    await removeAttachment(GRN_ID, "att1");
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toMatchObject({ publicId: ATT.publicId, resourceType: ATT.resourceType });
    expect(release.mock.calls[0][1]).toContain("GRN-0001");
  });

  it("releases only AFTER the DB row is deleted", async () => {
    const order: string[] = [];
    mockRemoveAtt.mockImplementation(() => { order.push("db"); return Promise.resolve({}); });
    release.mockImplementation(() => { order.push("cleanup"); return Promise.resolve(); });
    await removeAttachment(GRN_ID, "att1");
    expect(order).toEqual(["db", "cleanup"]);
  });

  it("never releases when the draft-only guard rejects the removal", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "completed" }));
    await expect(removeAttachment(GRN_ID, "att1")).rejects.toThrow(/only draft/i);
    expect(release).not.toHaveBeenCalled();
  });

  // Soft delete keeps the attachment rows, so the references — and the files — must survive.
  it("soft-deleting the GRN destroys nothing", async () => {
    mockFindById.mockResolvedValue(grnRow({ status: "draft", attachments: [ATT] }));
    await deleteGoodsReceipt(GRN_ID);
    expect(release).not.toHaveBeenCalled();
  });
});
