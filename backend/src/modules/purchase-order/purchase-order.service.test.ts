import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./purchase-order.repository.js", () => ({
  findById: vi.fn(),
  findByCode: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  createWithCode: vi.fn(),
  createManyWithCodes: vi.fn(),
  replaceItemsAndTotals: vi.fn(),
  // Goods In seam (tx-aware writers).
  headerForReceiptTx: vi.fn(),
  lineReceiptTotalsTx: vi.fn(),
  incrementLineReceivedTx: vi.fn(),
  setStatusTx: vi.fn(),
  // Attachments.
  addAttachment: vi.fn(),
  findAttachment: vi.fn(),
  removeAttachment: vi.fn(),
}));
vi.mock("#modules/supplier/supplier.service.js", () => ({ requireActiveSupplier: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.service.js", () => ({ requireActiveWarehouse: vi.fn() }));
vi.mock("#modules/irm/irm.service.js", () => ({ requireActiveIrmItem: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadFileToCloudinary: vi.fn() }));
// The supplier email is fire-and-forget; mock it so the transition tests stay pure and we can
// assert it's triggered + that a failure can't roll back the PO.
vi.mock("./purchase-order.email.js", () => ({
  notifySupplierPoSent: vi.fn(() => Promise.resolve()),
  notifySupplierPoCancelled: vi.fn(() => Promise.resolve()),
}));

import * as poRepo from "./purchase-order.repository.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as audit from "#modules/audit/audit.service.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { uploadFileToCloudinary } from "../../lib/cloudinary.js";
import {
  addAttachment,
  applyGoodsReceipt,
  approvePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  createPurchaseOrdersBySplit,
  deletePurchaseOrder,
  listPurchaseOrders,
  rejectPurchaseOrder,
  removeAttachment,
  sendPurchaseOrder,
  submitPurchaseOrder,
  updatePurchaseOrder,
} from "./purchase-order.service.js";
import * as poEmail from "./purchase-order.email.js";

const PO_ID = "f".repeat(24);
const SUP_ID = "a".repeat(24);
const WH_ID = "b".repeat(24);
const WH_ID_2 = "e".repeat(24);
const IRM_ID = "c".repeat(24);
const IRM_ID_2 = "d".repeat(24);

function poRow(over: Record<string, unknown> = {}) {
  return {
    id: PO_ID,
    code: "PO-0001",
    supplierId: SUP_ID,
    supplierName: "Acme",
    warehouseId: WH_ID,
    supplier: { id: SUP_ID, code: "SUP-0001", name: "Acme", contactPerson: null, contactEmail: null, contactPhone: null, paymentTerms: "30 Days", customPaymentTerms: null, currency: "GBP", leadTimeDays: 7 },
    warehouse: { id: WH_ID, code: "WH-0001", name: "Leeds", addressLine1: "1 Way", addressLine2: null, city: "Leeds", county: null, postcode: "LS1 1AB", country: "United Kingdom" },
    status: "draft",
    priority: "normal",
    referenceNumber: null,
    description: null,
    orderDate: new Date("2026-06-01T00:00:00Z"),
    expectedDeliveryDate: new Date("2026-06-10T00:00:00Z"),
    currency: "GBP",
    subtotalPence: 0,
    vatPence: 0,
    grandTotalPence: 0,
    deliveryAddress: null,
    deliveryInstructions: null,
    internalNotes: null,
    supplierNotes: null,
    items: [],
    attachments: [],
    createdBy: null,
    submittedBy: null,
    submittedAt: null,
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    closedAt: null,
    cancelledAt: null,
    cancelReason: null,
    rejectionReason: null,
    updatedBy: null,
    deletedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...over,
  };
}

const mockFindById = poRepo.findById as ReturnType<typeof vi.fn>;
const mockFindMany = poRepo.findMany as ReturnType<typeof vi.fn>;
const mockCount = poRepo.count as ReturnType<typeof vi.fn>;
const mockUpdate = poRepo.update as ReturnType<typeof vi.fn>;
const mockSoftDelete = poRepo.softDelete as ReturnType<typeof vi.fn>;
const mockCreateWithCode = poRepo.createWithCode as ReturnType<typeof vi.fn>;
const mockCreateMany = poRepo.createManyWithCodes as ReturnType<typeof vi.fn>;
const mockReqSupplier = supplierService.requireActiveSupplier as ReturnType<typeof vi.fn>;
const mockReqWarehouse = warehouseService.requireActiveWarehouse as ReturnType<typeof vi.fn>;
const mockReqIrm = irmService.requireActiveIrmItem as ReturnType<typeof vi.fn>;
const mockAudit = audit.record as ReturnType<typeof vi.fn>;
const auditActions = () => mockAudit.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) => Promise.resolve(poRow(data)));
  mockReqSupplier.mockResolvedValue({ name: "Acme" });
  mockReqWarehouse.mockResolvedValue({ id: WH_ID });
  mockReqIrm.mockImplementation((id: string) => Promise.resolve({ id, name: "CAT6", sku: "C6", baseUnit: "Each", vatRatePercent: 20 }));
});

describe("createPurchaseOrder — financials (server-calculated pence)", () => {
  it("computes subtotal / VAT / grand total from the lines + snapshots names", async () => {
    mockCreateWithCode.mockImplementation((header: Record<string, unknown>) =>
      Promise.resolve(poRow({ ...header, items: [] })),
    );
    await createPurchaseOrder({
      supplierId: SUP_ID,
      warehouseId: WH_ID,
      orderDate: "2026-06-01",
      expectedDeliveryDate: "2026-06-10",
      items: [
        { irmItemId: IRM_ID, quantity: 10, unitPricePence: 500, vatRate: 20 },
        { irmItemId: IRM_ID_2, quantity: 2, unitPricePence: 1000 }, // vat defaults from item (20)
      ],
    } as Parameters<typeof createPurchaseOrder>[0]);

    const [header, lines] = mockCreateWithCode.mock.calls[0];
    // 10*500 + 2*1000 = 7000 ex-VAT; VAT = 1000 + 400 = 1400; grand = 8400.
    expect(header.subtotalPence).toBe(7000);
    expect(header.vatPence).toBe(1400);
    expect(header.grandTotalPence).toBe(8400);
    expect(header.supplierName).toBe("Acme");
    expect(header.status).toBe("draft");
    expect(lines[0]).toMatchObject({ irmItemId: IRM_ID, itemName: "CAT6", lineTotalPence: 5000, vatRate: 20 });
    expect(auditActions()).toContain("purchase_order.created");
  });
});

describe("createPurchaseOrdersBySplit — multi-warehouse auto-split", () => {
  // The repo multi-create returns one PO per group, echoing each group's warehouse + lines.
  const wireCreateMany = () =>
    mockCreateMany.mockImplementation((groups: { header: Record<string, unknown>; lines: unknown[] }[]) =>
      Promise.resolve(
        groups.map((g, i) => poRow({ ...g.header, id: `${"1".repeat(23)}${i}`, code: `PO-000${i + 1}`, items: g.lines })),
      ),
    );

  const splitInput = (over: Record<string, unknown> = {}) =>
    ({
      supplierId: SUP_ID,
      orderDate: "2026-06-01",
      expectedDeliveryDate: "2026-06-10",
      items: [
        { irmItemId: IRM_ID, warehouseId: WH_ID, quantity: 10, unitPricePence: 500, vatRate: 20 },
        { irmItemId: IRM_ID_2, warehouseId: WH_ID, quantity: 2, unitPricePence: 1000, vatRate: 20 },
        { irmItemId: IRM_ID, warehouseId: WH_ID_2, quantity: 5, unitPricePence: 800, vatRate: 20 },
      ],
      ...over,
    }) as Parameters<typeof createPurchaseOrdersBySplit>[0];

  it("groups lines into ONE PO per warehouse (each PO single-warehouse)", async () => {
    wireCreateMany();
    await createPurchaseOrdersBySplit(splitInput());

    const groups = mockCreateMany.mock.calls[0][0];
    expect(groups).toHaveLength(2); // WH_ID + WH_ID_2
    expect(groups[0].header.warehouseId).toBe(WH_ID);
    expect(groups[0].lines).toHaveLength(2); // both WH_ID items
    expect(groups[1].header.warehouseId).toBe(WH_ID_2);
    expect(groups[1].lines).toHaveLength(1);
    // Each group is a complete single-warehouse header (supplier snapshot + draft + totals).
    expect(groups[0].header).toMatchObject({ supplierId: SUP_ID, supplierName: "Acme", status: "draft" });
    expect(groups[0].header.subtotalPence).toBe(10 * 500 + 2 * 1000);
  });

  it("returns every created PO and audits one purchase_order.created per PO", async () => {
    wireCreateMany();
    const result = await createPurchaseOrdersBySplit(splitInput());
    expect(result).toHaveLength(2);
    expect(auditActions().filter((a) => a === "purchase_order.created")).toHaveLength(2);
  });

  it("creates a SINGLE PO when every line targets the same warehouse", async () => {
    wireCreateMany();
    const result = await createPurchaseOrdersBySplit(
      splitInput({
        items: [
          { irmItemId: IRM_ID, warehouseId: WH_ID, quantity: 1, unitPricePence: 500, vatRate: 20 },
          { irmItemId: IRM_ID_2, warehouseId: WH_ID, quantity: 1, unitPricePence: 500, vatRate: 20 },
        ],
      }),
    );
    expect(mockCreateMany.mock.calls[0][0]).toHaveLength(1);
    expect(result).toHaveLength(1);
  });

  it("blocks a warehouse-scoped actor from a warehouse they aren't assigned (403, no write)", async () => {
    wireCreateMany();
    const actor = { type: "user", email: "wm@x.com", assignedWarehouseIds: [WH_ID] } as never;
    await expect(createPurchaseOrdersBySplit(splitInput(), actor)).rejects.toThrow(/access to this warehouse/i);
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it("rejects up front when a group's warehouse is inactive (no partial creation)", async () => {
    wireCreateMany();
    mockReqWarehouse.mockRejectedValueOnce(new Error("Selected warehouse is inactive."));
    await expect(createPurchaseOrdersBySplit(splitInput())).rejects.toThrow();
    expect(mockCreateMany).not.toHaveBeenCalled();
  });
});

describe("listPurchaseOrders — warehouse-access scoping", () => {
  beforeEach(() => {
    mockCount.mockResolvedValue(0);
    mockFindMany.mockResolvedValue([]);
  });

  // A scoped actor's assigned set MUST reach the repository as `warehouseIds`, on BOTH the count
  // and the find — otherwise a warehouse-restricted user's list leaks POs from every warehouse.
  it("constrains the query to a scoped actor's assigned warehouses", async () => {
    const actor = { type: "user", email: "wm@x.com", assignedWarehouseIds: [WH_ID, WH_ID_2] } as never;
    await listPurchaseOrders({}, actor);
    expect(mockCount.mock.calls[0][0]).toMatchObject({ warehouseIds: [WH_ID, WH_ID_2] });
    expect(mockFindMany.mock.calls[0][0]).toMatchObject({ warehouseIds: [WH_ID, WH_ID_2] });
  });

  // An unrestricted principal (admin / non-scoped role) carries null → no warehouse constraint.
  it("applies no warehouse constraint for an unrestricted actor", async () => {
    const actor = { type: "admin", email: "a@x.com", assignedWarehouseIds: null } as never;
    await listPurchaseOrders({}, actor);
    expect(mockFindMany.mock.calls[0][0].warehouseIds).toBeUndefined();
  });

  // A scoped actor with NO assignments yields an empty set → matches nothing (never "everything").
  it("matches nothing for a scoped actor with an empty assigned set", async () => {
    const actor = { type: "user", email: "wm@x.com", assignedWarehouseIds: [] } as never;
    await listPurchaseOrders({}, actor);
    expect(mockFindMany.mock.calls[0][0].warehouseIds).toEqual([]);
  });
});

describe("status state machine (forward-only, enforced)", () => {
  it("submit: draft → pending_approval (with a line)", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "draft", items: [{ id: "l1", quantity: 1, receivedQuantity: 0 }] }));
    const r = await submitPurchaseOrder(PO_ID);
    expect(r.status).toBe("pending_approval");
    expect(auditActions()).toContain("purchase_order.submitted");
  });

  it("submit: rejects an empty draft (no lines)", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "draft", items: [] }));
    await expect(submitPurchaseOrder(PO_ID)).rejects.toThrow(/at least one item/i);
  });

  it("approve: rejects a draft (must be pending_approval)", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "draft" }));
    await expect(approvePurchaseOrder(PO_ID)).rejects.toThrow(/can't move/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("approve: pending_approval → approved", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "pending_approval" }));
    expect((await approvePurchaseOrder(PO_ID)).status).toBe("approved");
  });

  it("reject: pending_approval → draft (rework)", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "pending_approval" }));
    const r = await rejectPurchaseOrder(PO_ID, "Wrong supplier");
    expect(r.status).toBe("draft");
    expect(mockUpdate.mock.calls[0][1].rejectionReason).toBe("Wrong supplier");
    expect(auditActions()).toContain("purchase_order.rejected");
  });

  it("send: approved → sent; but rejects sending a draft", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    expect((await sendPurchaseOrder(PO_ID)).status).toBe("sent");
    vi.clearAllMocks();
    mockUpdate.mockImplementation((_id, data) => Promise.resolve(poRow(data)));
    mockFindById.mockResolvedValue(poRow({ status: "draft" }));
    await expect(sendPurchaseOrder(PO_ID)).rejects.toThrow(/can't move/i);
  });

  it("cancel: allowed from sent, blocked once closed", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    expect((await cancelPurchaseOrder(PO_ID, "No longer needed")).status).toBe("cancelled");
    vi.clearAllMocks();
    mockUpdate.mockImplementation((_id, data) => Promise.resolve(poRow(data)));
    mockFindById.mockResolvedValue(poRow({ status: "closed" }));
    await expect(cancelPurchaseOrder(PO_ID, undefined)).rejects.toThrow(/can't move/i);
  });

  it("close: fully_received → closed; rejects closing a sent PO", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "fully_received" }));
    expect((await closePurchaseOrder(PO_ID)).status).toBe("closed");
    vi.clearAllMocks();
    mockUpdate.mockImplementation((_id, data) => Promise.resolve(poRow(data)));
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    await expect(closePurchaseOrder(PO_ID)).rejects.toThrow(/can't move/i);
  });
});

describe("draft-only editability + delete", () => {
  it("blocks editing a non-draft PO", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    await expect(updatePurchaseOrder(PO_ID, { description: "x" })).rejects.toThrow(/only draft/i);
  });

  it("blocks deleting a non-draft PO", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    await expect(deletePurchaseOrder(PO_ID)).rejects.toThrow(/only draft/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("soft-deletes a draft PO", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "draft" }));
    await expect(deletePurchaseOrder(PO_ID)).resolves.toBeUndefined();
    expect(mockSoftDelete).toHaveBeenCalledWith(PO_ID);
    expect(auditActions()).toContain("purchase_order.deleted");
  });
});

// The Goods In → PO seam. `closed` and `cancelled` are terminal & immutable: a receipt must never
// reopen or mutate such a PO (the bug this guards: completing a stale draft GRN silently un-closed
// the PO and wrote inventory). All writes must be skipped and the tx rolled back. fully_received →
// closed is covered by the closePurchaseOrder state-machine tests above.
describe("applyGoodsReceipt — terminal-state guard (Goods In seam)", () => {
  const LINE_ID = "e".repeat(24);
  const tx = {} as unknown as Parameters<typeof applyGoodsReceipt>[0];
  const mockHeader = poRepo.headerForReceiptTx as ReturnType<typeof vi.fn>;
  const mockLineTotals = poRepo.lineReceiptTotalsTx as ReturnType<typeof vi.fn>;
  const mockIncrement = poRepo.incrementLineReceivedTx as ReturnType<typeof vi.fn>;
  const mockSetStatus = poRepo.setStatusTx as ReturnType<typeof vi.fn>;

  it("rejects receiving against a CLOSED purchase order — no PO/inventory writes", async () => {
    mockHeader.mockResolvedValue({ id: PO_ID, code: "PO-0001", status: "closed" });
    await expect(applyGoodsReceipt(tx, PO_ID, [{ purchaseOrderItemId: LINE_ID, receivedDelta: 5 }])).rejects.toThrow(
      /closed|can no longer receive/i,
    );
    expect(mockIncrement).not.toHaveBeenCalled();
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it("rejects receiving against a CANCELLED purchase order — no PO/inventory writes", async () => {
    mockHeader.mockResolvedValue({ id: PO_ID, code: "PO-0001", status: "cancelled" });
    await expect(applyGoodsReceipt(tx, PO_ID, [{ purchaseOrderItemId: LINE_ID, receivedDelta: 5 }])).rejects.toThrow(
      /cancelled|can no longer receive/i,
    );
    expect(mockIncrement).not.toHaveBeenCalled();
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it("sent → partially_received: applies a partial delivery", async () => {
    mockHeader.mockResolvedValue({ id: PO_ID, code: "PO-0001", status: "sent" });
    mockLineTotals
      .mockResolvedValueOnce([{ id: LINE_ID, quantity: 10, receivedQuantity: 0 }]) // before
      .mockResolvedValueOnce([{ id: LINE_ID, quantity: 10, receivedQuantity: 5 }]); // after
    await applyGoodsReceipt(tx, PO_ID, [{ purchaseOrderItemId: LINE_ID, receivedDelta: 5 }]);
    expect(mockIncrement).toHaveBeenCalledWith(tx, LINE_ID, 5);
    expect(mockSetStatus).toHaveBeenCalledWith(tx, PO_ID, "partially_received");
    expect(auditActions()).toContain("purchase_order.partially_received");
  });

  it("partially_received → fully_received: applies the remainder", async () => {
    mockHeader.mockResolvedValue({ id: PO_ID, code: "PO-0001", status: "partially_received" });
    mockLineTotals
      .mockResolvedValueOnce([{ id: LINE_ID, quantity: 10, receivedQuantity: 5 }]) // before
      .mockResolvedValueOnce([{ id: LINE_ID, quantity: 10, receivedQuantity: 10 }]); // after
    await applyGoodsReceipt(tx, PO_ID, [{ purchaseOrderItemId: LINE_ID, receivedDelta: 5 }]);
    expect(mockSetStatus).toHaveBeenCalledWith(tx, PO_ID, "fully_received");
    expect(auditActions()).toContain("purchase_order.fully_received");
  });
});

describe("attachments — terminal-state guard", () => {
  const mockAddAtt = poRepo.addAttachment as ReturnType<typeof vi.fn>;
  const mockFindAtt = poRepo.findAttachment as ReturnType<typeof vi.fn>;
  const mockRemoveAtt = poRepo.removeAttachment as ReturnType<typeof vi.fn>;
  const mockCreds = getCloudinaryCreds as ReturnType<typeof vi.fn>;
  const mockUpload = uploadFileToCloudinary as ReturnType<typeof vi.fn>;
  const att = { label: "Quote", fileName: "q.pdf", fileType: "pdf", fileSizeBytes: 1000, data: "data:application/pdf;base64,AAAA" } as Parameters<typeof addAttachment>[1];

  it("adds an attachment on a SENT (non-terminal) PO", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    mockCreds.mockResolvedValue({ cloudName: "c", apiKey: "k", apiSecret: "s" });
    mockUpload.mockResolvedValue("https://cdn/q.pdf");
    await addAttachment(PO_ID, att, { type: "admin", email: "x@x.com" });
    expect(mockAddAtt).toHaveBeenCalledTimes(1);
    expect(auditActions()).toContain("purchase_order.attachment_added");
  });

  it("blocks adding an attachment on a CLOSED PO", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "closed" }));
    await expect(addAttachment(PO_ID, att)).rejects.toThrow(/closed or cancelled/i);
    expect(mockAddAtt).not.toHaveBeenCalled();
  });

  it("blocks removing an attachment on a CANCELLED PO", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "cancelled" }));
    await expect(removeAttachment(PO_ID, "att1")).rejects.toThrow(/closed or cancelled/i);
    expect(mockFindAtt).not.toHaveBeenCalled();
    expect(mockRemoveAtt).not.toHaveBeenCalled();
  });
});

// The supplier email is fire-and-forget: it's triggered on send/cancel, but a failure must never
// roll back the workflow transition (the PO stays sent/cancelled).
describe("supplier email hooks (fire-and-forget)", () => {
  const mockSent = poEmail.notifySupplierPoSent as ReturnType<typeof vi.fn>;
  const mockCancelled = poEmail.notifySupplierPoCancelled as ReturnType<typeof vi.fn>;

  it("send triggers the supplier PO-sent notification with the now-sent PO", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    await sendPurchaseOrder(PO_ID, { type: "user", id: "u", email: "buyer@x.co", permissions: [] });
    expect(mockSent).toHaveBeenCalledTimes(1);
    expect(mockSent.mock.calls[0][0]).toMatchObject({ status: "sent" });
  });

  it("a failing supplier email never rolls back the send (still resolves to sent)", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    mockSent.mockRejectedValueOnce(new Error("SMTP down"));
    expect((await sendPurchaseOrder(PO_ID)).status).toBe("sent");
  });

  it("cancel triggers the supplier cancellation notification", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "sent", sentAt: new Date() }));
    await cancelPurchaseOrder(PO_ID, "No longer needed");
    expect(mockCancelled).toHaveBeenCalledTimes(1);
  });
});
