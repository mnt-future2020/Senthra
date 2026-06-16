import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./purchase-order.repository.js", () => ({
  findById: vi.fn(),
  findByCode: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  createWithCode: vi.fn(),
  replaceItemsAndTotals: vi.fn(),
}));
vi.mock("#modules/supplier/supplier.service.js", () => ({ requireActiveSupplier: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.service.js", () => ({ requireActiveWarehouse: vi.fn() }));
vi.mock("#modules/irm/irm.service.js", () => ({ requireActiveIrmItem: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadFileToCloudinary: vi.fn() }));

import * as poRepo from "./purchase-order.repository.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as audit from "#modules/audit/audit.service.js";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  deletePurchaseOrder,
  rejectPurchaseOrder,
  sendPurchaseOrder,
  submitPurchaseOrder,
  updatePurchaseOrder,
} from "./purchase-order.service.js";

const PO_ID = "f".repeat(24);
const SUP_ID = "a".repeat(24);
const WH_ID = "b".repeat(24);
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
const mockUpdate = poRepo.update as ReturnType<typeof vi.fn>;
const mockSoftDelete = poRepo.softDelete as ReturnType<typeof vi.fn>;
const mockCreateWithCode = poRepo.createWithCode as ReturnType<typeof vi.fn>;
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
