import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./purchase-request.repository.js", () => ({
  findById: vi.fn(),
  findByCode: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  createWithCode: vi.fn(),
  replaceItemsAndTotals: vi.fn(),
  countBySupplier: vi.fn(),
  countByWarehouse: vi.fn(),
  // Convert seam (tx-aware).
  findForConvertTx: vi.fn(),
  setConvertedTx: vi.fn(),
  // Attachments.
  addAttachment: vi.fn(),
  findAttachment: vi.fn(),
  removeAttachment: vi.fn(),
}));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({
  ensurePoCounter: vi.fn(() => Promise.resolve()),
  allocatePoCodeTx: vi.fn(),
  createPoTx: vi.fn(),
  fastForwardPoCounter: vi.fn(),
  isPoCodeConflict: vi.fn(() => false),
  isPoWriteConflict: vi.fn(() => false),
}));
vi.mock("#modules/job/job.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/supplier/supplier.service.js", () => ({ requireActiveSupplier: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.service.js", () => ({ requireActiveWarehouse: vi.fn() }));
vi.mock("#modules/irm/irm.service.js", () => ({ requireActiveIrmItem: vi.fn(), requireActiveIrmItems: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadFileToCloudinary: vi.fn() }));
// The convert transaction is orchestrated in the service; execute the callback with a stub tx.
vi.mock("../../lib/prisma.js", () => ({ withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})), prisma: {} }));
vi.mock("./purchase-request.email.js", () => ({
  notifyReviewersPrfSubmitted: vi.fn(() => Promise.resolve()),
  notifyRequesterPrfDecision: vi.fn(() => Promise.resolve()),
}));

import * as prfRepo from "./purchase-request.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as audit from "#modules/audit/audit.service.js";
import * as prfEmail from "./purchase-request.email.js";
import {
  approvePurchaseRequest,
  cancelPurchaseRequest,
  computeTotals,
  convertPurchaseRequest,
  createPurchaseRequest,
  deletePurchaseRequest,
  duplicatePurchaseRequest,
  rejectPurchaseRequest,
  reopenPurchaseRequest,
  submitPurchaseRequest,
  updatePurchaseRequest,
} from "./purchase-request.service.js";

const PRF_ID = "f".repeat(24);
const SUP_ID = "a".repeat(24);
const WH_ID = "b".repeat(24);
const IRM_ID = "c".repeat(24);
const IRM_ID_2 = "d".repeat(24);

function prfItem(over: Record<string, unknown> = {}) {
  return {
    id: "l1",
    irmItemId: IRM_ID,
    itemName: "CAT6",
    sku: "C6",
    baseUnit: "Each",
    quantity: 10,
    unitPricePence: 500,
    vatRate: 20,
    lineTotalPence: 5000,
    notes: null,
    sortOrder: 0,
    irmItem: { id: IRM_ID, code: "IRM-0001", name: "CAT6", status: "active" },
    ...over,
  };
}

function prfRow(over: Record<string, unknown> = {}) {
  return {
    id: PRF_ID,
    code: "PRF-0001",
    supplierId: SUP_ID,
    supplierName: "Acme",
    supplier: { id: SUP_ID, code: "SUP-0001", name: "Acme", contactPerson: null, contactEmail: null, contactPhone: null, paymentTerms: "30 Days", customPaymentTerms: null, currency: "GBP", leadTimeDays: 7 },
    warehouseId: WH_ID,
    warehouse: { id: WH_ID, code: "WH-0001", name: "Leeds", addressLine1: "1 Way", addressLine2: null, city: "Leeds", county: null, postcode: "LS1 1AB", country: "United Kingdom" },
    jobId: null,
    job: null,
    projectRef: null,
    sourceType: null,
    sourceId: null,
    status: "draft",
    quoteReference: "Q-2026-17",
    quoteDate: new Date("2026-07-01T00:00:00Z"),
    quoteValidUntil: new Date("2026-08-01T00:00:00Z"),
    justification: "Fibre rollout phase 2",
    notes: null,
    currency: "GBP",
    subtotalPence: 5000,
    vatPence: 1000,
    grandTotalPence: 6000,
    createdBy: "requester@x.co",
    submittedBy: null,
    submittedAt: null,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
    reopenReason: null,
    cancelledAt: null,
    cancelReason: null,
    convertedAt: null,
    updatedBy: null,
    revisionOfId: null,
    deletedAt: null,
    items: [prfItem()],
    attachments: [],
    purchaseOrders: [],
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...over,
  };
}

const mockFindById = prfRepo.findById as ReturnType<typeof vi.fn>;
const mockUpdate = prfRepo.update as ReturnType<typeof vi.fn>;
const mockSoftDelete = prfRepo.softDelete as ReturnType<typeof vi.fn>;
const mockCreateWithCode = prfRepo.createWithCode as ReturnType<typeof vi.fn>;
const mockFindForConvertTx = prfRepo.findForConvertTx as ReturnType<typeof vi.fn>;
const mockSetConvertedTx = prfRepo.setConvertedTx as ReturnType<typeof vi.fn>;
const mockAllocateCode = poRepo.allocatePoCodeTx as ReturnType<typeof vi.fn>;
const mockCreatePoTx = poRepo.createPoTx as ReturnType<typeof vi.fn>;
const mockReqSupplier = supplierService.requireActiveSupplier as ReturnType<typeof vi.fn>;
const mockReqWarehouse = warehouseService.requireActiveWarehouse as ReturnType<typeof vi.fn>;
const mockReqIrm = irmService.requireActiveIrmItem as ReturnType<typeof vi.fn>;
const mockReqIrms = irmService.requireActiveIrmItems as ReturnType<typeof vi.fn>;
const irmRow = (id: string) => ({ id, name: "CAT6", sku: "C6", baseUnit: "Each", vatRatePercent: 20 });
const mockAudit = audit.record as ReturnType<typeof vi.fn>;
const auditActions = () => mockAudit.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) => Promise.resolve(prfRow(data)));
  mockReqSupplier.mockResolvedValue({ name: "Acme" });
  mockReqWarehouse.mockResolvedValue({ id: WH_ID });
  mockReqIrm.mockImplementation((id: string) => Promise.resolve(irmRow(id)));
  mockReqIrms.mockImplementation((ids: string[]) => Promise.resolve(new Map(ids.map((id) => [id, irmRow(id)]))));
});

describe("computeTotals (pure — identical maths to the PO module)", () => {
  it("sums line totals + VAT in integer pence", () => {
    expect(
      computeTotals([
        { quantity: 10, unitPricePence: 500, vatRate: 20 },
        { quantity: 2, unitPricePence: 1000, vatRate: 20 },
      ]),
    ).toEqual({ subtotalPence: 7000, vatPence: 1400, grandTotalPence: 8400 });
  });
});

describe("createPurchaseRequest — financials + snapshots", () => {
  it("computes totals from the quoted lines and snapshots supplier/item names", async () => {
    mockCreateWithCode.mockImplementation((header: Record<string, unknown>) => Promise.resolve(prfRow({ ...header, items: [] })));
    await createPurchaseRequest({
      supplierId: SUP_ID,
      warehouseId: WH_ID,
      quoteReference: "Q-1",
      items: [
        { irmItemId: IRM_ID, quantity: 10, unitPricePence: 500, vatRate: 20 },
        { irmItemId: IRM_ID_2, quantity: 2, unitPricePence: 1000 }, // vat defaults from the item (20)
      ],
    } as Parameters<typeof createPurchaseRequest>[0]);
    const [header, lines] = mockCreateWithCode.mock.calls[0];
    expect(header.subtotalPence).toBe(7000);
    expect(header.vatPence).toBe(1400);
    expect(header.grandTotalPence).toBe(8400);
    expect(header.supplierName).toBe("Acme");
    expect(header.status).toBe("draft");
    expect(lines[0]).toMatchObject({ irmItemId: IRM_ID, itemName: "CAT6", lineTotalPence: 5000 });
    expect(auditActions()).toContain("purchase_request.created");
  });
});

describe("status state machine (forward-only, enforced)", () => {
  it("submit: draft → submitted (with a line) + finance-reviewer notification", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "draft" }));
    const r = await submitPurchaseRequest(PRF_ID);
    expect(r.status).toBe("submitted");
    expect(auditActions()).toContain("purchase_request.submitted");
    expect(prfEmail.notifyReviewersPrfSubmitted).toHaveBeenCalledTimes(1);
  });

  it("submit: rejects an empty draft (no lines)", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "draft", items: [] }));
    await expect(submitPurchaseRequest(PRF_ID)).rejects.toThrow(/at least one item/i);
  });

  it("approve: submitted → approved (Finance Approved); rejects approving a draft", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "submitted" }));
    expect((await approvePurchaseRequest(PRF_ID)).status).toBe("approved");
    vi.clearAllMocks();
    mockUpdate.mockImplementation((_id, data) => Promise.resolve(prfRow(data)));
    mockFindById.mockResolvedValue(prfRow({ status: "draft" }));
    await expect(approvePurchaseRequest(PRF_ID)).rejects.toThrow(/can't move/i);
  });

  it("reject: submitted → draft with the reason on record", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "submitted" }));
    const r = await rejectPurchaseRequest(PRF_ID, "Price above budget");
    expect(r.status).toBe("draft");
    expect(mockUpdate.mock.calls[0][1].rejectionReason).toBe("Price above budget");
    // Any prior reopenReason is cleared so the detail never shows a stale contradictory reason.
    expect(mockUpdate.mock.calls[0][1].reopenReason).toBeNull();
    expect(auditActions()).toContain("purchase_request.rejected");
  });

  it("reject: only a submitted request can be rejected", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "approved" }));
    await expect(rejectPurchaseRequest(PRF_ID, "x")).rejects.toThrow(/only a submitted/i);
  });

  it("reopen: approved → draft, approval stamps cleared, reason mandatory on record", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "approved", approvedBy: "fin@x.co", approvedAt: new Date() }));
    const r = await reopenPurchaseRequest(PRF_ID, "Supplier revised the quote");
    expect(r.status).toBe("draft");
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({ approvedBy: null, approvedAt: null, reopenReason: "Supplier revised the quote", rejectionReason: null });
    expect(auditActions()).toContain("purchase_request.reopened");
  });

  it("reopen: refused unless finance-approved", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "submitted" }));
    await expect(reopenPurchaseRequest(PRF_ID, "x")).rejects.toThrow(/only a finance-approved/i);
  });

  it.each(["draft", "submitted", "approved"])("cancel: allowed from %s", async (status) => {
    mockFindById.mockResolvedValue(prfRow({ status }));
    expect((await cancelPurchaseRequest(PRF_ID, "No longer needed")).status).toBe("cancelled");
  });

  it.each(["converted", "cancelled"])("cancel: refused from %s (terminal)", async (status) => {
    mockFindById.mockResolvedValue(prfRow({ status }));
    await expect(cancelPurchaseRequest(PRF_ID, "x")).rejects.toThrow(/can't move/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe("read-only lock (draft-only edits; converted is read-only forever)", () => {
  it.each(["submitted", "approved", "converted", "cancelled"])("blocks editing a %s request", async (status) => {
    mockFindById.mockResolvedValue(prfRow({ status }));
    await expect(updatePurchaseRequest(PRF_ID, { notes: "x" })).rejects.toThrow(/only draft/i);
  });

  it("blocks deleting a non-draft request; soft-deletes a draft", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "submitted" }));
    await expect(deletePurchaseRequest(PRF_ID)).rejects.toThrow(/only draft/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
    mockFindById.mockResolvedValue(prfRow({ status: "draft" }));
    await expect(deletePurchaseRequest(PRF_ID)).resolves.toBeUndefined();
    expect(mockSoftDelete).toHaveBeenCalledWith(PRF_ID);
  });
});

describe("convert — generate the PO from an approved PRF (one per PRF, transactional)", () => {
  const liveApproved = (over: Record<string, unknown> = {}) => ({
    id: PRF_ID,
    code: "PRF-0001",
    status: "approved",
    supplierId: SUP_ID,
    warehouseId: WH_ID,
    jobId: null,
    projectRef: "Fibre P2",
    quoteReference: "Q-2026-17",
    justification: "Fibre rollout phase 2",
    notes: null,
    items: [
      { irmItemId: IRM_ID, itemName: "CAT6", sku: "C6", baseUnit: "Each", quantity: 10, unitPricePence: 500, vatRate: 20, lineTotalPence: 5000, notes: null, sortOrder: 0 },
    ],
    attachments: [
      { label: "Quote", fileName: "q.pdf", fileType: "pdf", fileSizeBytes: 111, url: "https://cdn/q.pdf", uploadedBy: "requester@x.co" },
    ],
    ...over,
  });

  beforeEach(() => {
    mockFindById.mockResolvedValue(prfRow({ status: "approved", projectRef: "Fibre P2" }));
    mockFindForConvertTx.mockResolvedValue(liveApproved());
    mockAllocateCode.mockResolvedValue("PO-0042");
    mockCreatePoTx.mockResolvedValue("6".repeat(24));
  });

  it("creates the PO in draft carrying supplier/warehouse/project/lines/quote-ref/attachments + flips the PRF to converted", async () => {
    const result = await convertPurchaseRequest(PRF_ID, { type: "user", id: "u1", email: "fin@x.co", permissions: [] });
    expect(result.purchaseOrderCode).toBe("PO-0042");

    const [, header, code, lines, attachments] = mockCreatePoTx.mock.calls[0];
    expect(code).toBe("PO-0042");
    expect(header).toMatchObject({
      supplierId: SUP_ID,
      supplierName: "Acme",
      warehouseId: WH_ID,
      purchaseRequestId: PRF_ID,
      projectRef: "Fibre P2",
      status: "draft",
      referenceNumber: "Q-2026-17",
      subtotalPence: 5000,
      vatPence: 1000,
      grandTotalPence: 6000,
    });
    expect(String(header.internalNotes)).toContain("PRF PRF-0001 justification");
    // Lines copied VERBATIM from the reviewed PRF (snapshots + quoted prices).
    expect(lines[0]).toMatchObject({ irmItemId: IRM_ID, itemName: "CAT6", quantity: 10, unitPricePence: 500 });
    // The quotation evidence travels with the PO.
    expect(attachments[0]).toMatchObject({ fileName: "q.pdf", url: "https://cdn/q.pdf" });
    expect(mockSetConvertedTx).toHaveBeenCalledWith({}, PRF_ID, "fin@x.co");
    expect(auditActions()).toEqual(expect.arrayContaining(["purchase_request.converted", "purchase_order.created"]));
  });

  it("a concurrent second convert fails inside the transaction (already converted) — no PO created", async () => {
    mockFindForConvertTx.mockResolvedValue(liveApproved({ status: "converted" }));
    await expect(convertPurchaseRequest(PRF_ID)).rejects.toThrow(/converted and can no longer/i);
    expect(mockCreatePoTx).not.toHaveBeenCalled();
    expect(mockSetConvertedTx).not.toHaveBeenCalled();
  });

  it("refuses to convert when the supplier has gone inactive", async () => {
    mockReqSupplier.mockRejectedValueOnce(new Error("Selected supplier is inactive."));
    await expect(convertPurchaseRequest(PRF_ID)).rejects.toThrow(/inactive/i);
    expect(mockCreatePoTx).not.toHaveBeenCalled();
  });

  it("refuses to convert when a line's item has been retired", async () => {
    mockReqIrms.mockRejectedValueOnce(new Error("Selected item is inactive."));
    await expect(convertPurchaseRequest(PRF_ID)).rejects.toThrow(/inactive/i);
    expect(mockCreatePoTx).not.toHaveBeenCalled();
  });

  it("refuses to convert a non-approved PRF up front", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "submitted" }));
    await expect(convertPurchaseRequest(PRF_ID)).rejects.toThrow(/can't move/i);
    expect(mockFindForConvertTx).not.toHaveBeenCalled();
  });
});

describe("duplicate-as-revision (price-revision workflow, post-conversion)", () => {
  it("copies a CONVERTED request into a new draft linked via revisionOfId", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "converted", projectRef: "Fibre P2" }));
    mockCreateWithCode.mockImplementation((header: Record<string, unknown>, lines: unknown[]) =>
      Promise.resolve(prfRow({ ...header, code: "PRF-0002", items: lines })),
    );
    const r = await duplicatePurchaseRequest(PRF_ID);
    expect(r.status).toBe("draft");
    const [header, lines] = mockCreateWithCode.mock.calls[0];
    expect(header).toMatchObject({ revisionOfId: PRF_ID, status: "draft", supplierId: SUP_ID, projectRef: "Fibre P2" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ irmItemId: IRM_ID, quantity: 10, unitPricePence: 500 });
  });

  it("refuses duplicating anything not converted (pre-conversion → reopen instead)", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "approved" }));
    await expect(duplicatePurchaseRequest(PRF_ID)).rejects.toThrow(/only a converted/i);
    expect(mockCreateWithCode).not.toHaveBeenCalled();
  });
});
