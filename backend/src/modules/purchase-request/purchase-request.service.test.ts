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
vi.mock("#modules/rental-item/rental-item.service.js", () => ({
  requireActiveRentalItems: vi.fn(),
  getRentalItemsByIds: vi.fn(),
}));
// The reorder generation revalidates against the LIVE workbench read; mocking it also cuts the
// heavy inventory-service import graph out of this unit-test module.
vi.mock("#modules/inventory/inventory.service.js", () => ({ getReorderSuggestions: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/attachment/attachment.service.js", () => ({ releaseAsset: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadFileToCloudinary: vi.fn() }));
// Realtime is fire-and-forget; mock it so we can assert every transition fans a refetch signal out
// to the watchers (a stale detail page is what lets a user act on an already-moved request).
vi.mock("../../lib/realtime.js", () => ({
  emitAttentionChanged: vi.fn(),
  emitToRoom: vi.fn(),
  emitToUser: vi.fn(),
  PURCHASE_REQUEST_WATCHERS_ROOM: "purchase_requests:watchers",
  PURCHASE_ORDER_WATCHERS_ROOM: "purchase_orders:watchers",
}));
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
import * as rentalItemService from "#modules/rental-item/rental-item.service.js";
import * as audit from "#modules/audit/audit.service.js";
import { emitToRoom, PURCHASE_ORDER_WATCHERS_ROOM, PURCHASE_REQUEST_WATCHERS_ROOM } from "../../lib/realtime.js";
import * as prfEmail from "./purchase-request.email.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as attachmentService from "#modules/attachment/attachment.service.js";
import {
  approvePurchaseRequest,
  cancelPurchaseRequest,
  computeTotals,
  convertPurchaseRequest,
  createPurchaseRequest,
  deletePurchaseRequest,
  duplicatePurchaseRequest,
  generateReorderPrfs,
  getPurchaseRequest,
  rejectPurchaseRequest,
  reopenPurchaseRequest,
  submitPurchaseRequest,
  updatePurchaseRequest,
  assertCanAttach,
  attachUploadedAsset,
  removeAttachment,
} from "./purchase-request.service.js";
import { createPurchaseRequestSchema, updatePurchaseRequestSchema } from "./purchase-request.validation.js";

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

// Convert refuses a PRF whose required-by date has already passed, so fixtures feeding that path
// must stay in the future RELATIVE TO NOW — a hardcoded calendar date would silently turn these
// tests red the day it went by.
const FUTURE_REQUIRED_BY = new Date(Date.now() + 30 * 86_400_000);

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
    requiredByDate: FUTURE_REQUIRED_BY,
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
    // Present and empty by default: the repository's include always supplies the array, so a
    // fixture omitting it would be testing a shape production never produces.
    rentalItems: [],
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
const auditEntries = () => mockAudit.mock.calls.map((c) => c[0] as { action: string; metadata?: Record<string, unknown> });
const mockSuggestions = inventoryService.getReorderSuggestions as ReturnType<typeof vi.fn>;

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
      requiredByDate: "2026-08-20",
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

  // The PRF's required-by date is the ONLY source of the generated PO's expected delivery date
  // (nothing derives one from supplier lead time), so it must persist as a real Date.
  it("stores the required-by date that the PO will inherit", async () => {
    mockCreateWithCode.mockImplementation((header: Record<string, unknown>) => Promise.resolve(prfRow({ ...header, items: [] })));
    await createPurchaseRequest({
      supplierId: SUP_ID,
      warehouseId: WH_ID,
      requiredByDate: "2026-08-20",
      items: [{ irmItemId: IRM_ID, quantity: 1, unitPricePence: 500, vatRate: 20 }],
    } as Parameters<typeof createPurchaseRequest>[0]);
    const [header] = mockCreateWithCode.mock.calls[0];
    expect(header.requiredByDate).toEqual(new Date("2026-08-20"));
  });
});

// The date is enforced by the zod schema at the route boundary, not the service — assert it there
// so a future refactor can't quietly relax it back to optional.
describe("createPurchaseRequestSchema — required-by date", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    supplierId: SUP_ID,
    warehouseId: WH_ID,
    requiredByDate: "2026-08-20",
    items: [{ irmItemId: IRM_ID, quantity: 1, unitPricePence: 500, vatRate: 20 }],
    ...over,
  });

  it("rejects a request with no required-by date", () => {
    expect(createPurchaseRequestSchema.safeParse(body({ requiredByDate: undefined })).success).toBe(false);
    expect(createPurchaseRequestSchema.safeParse(body({ requiredByDate: "" })).success).toBe(false);
  });

  it("rejects an unparseable date", () => {
    expect(createPurchaseRequestSchema.safeParse(body({ requiredByDate: "not-a-date" })).success).toBe(false);
  });

  it("accepts a valid date", () => {
    expect(createPurchaseRequestSchema.safeParse(body()).success).toBe(true);
  });

  // An EDIT is a partial patch: omitting the field means "leave unchanged", not "clear it".
  // NOTE the asymmetry with jobId/quoteDate/deliveryTerms, which ARE nullable — the edit form must
  // send `undefined` (omit) for this one, never `null`, or it gets a raw zod 400 naming no field.
  it("lets an edit omit the date, but never blank it", () => {
    expect(updatePurchaseRequestSchema.safeParse({ requiredByDate: undefined }).success).toBe(true);
    expect(updatePurchaseRequestSchema.safeParse({ requiredByDate: "2026-09-01" }).success).toBe(true);
    expect(updatePurchaseRequestSchema.safeParse({ requiredByDate: null }).success).toBe(false);
    expect(updatePurchaseRequestSchema.safeParse({ requiredByDate: "" }).success).toBe(true); // treated as omitted
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

// A PRF is raised by one person, approved/rejected by finance, then converted by procurement — so a
// screen left open on one desk goes stale as soon as the next person acts, which is how a user ends
// up clicking "Approve" on a request finance already approved elsewhere.
describe("realtime: transitions notify purchase-request watchers", () => {
  const mockEmitRoom = emitToRoom as ReturnType<typeof vi.fn>;
  const emitsTo = (room: string, event: string) =>
    mockEmitRoom.mock.calls
      .filter((c) => c[0] === room && c[1] === event)
      .map((c) => c[2] as { id: string; code: string; status: string });
  const prfEmits = () => emitsTo(PURCHASE_REQUEST_WATCHERS_ROOM, "purchase_request:updated");

  it("notifies on every status transition", async () => {
    // submit refuses an empty request, so that row needs a line; the rest turn on status alone.
    const aLine = [{ id: "l1", irmItemId: IRM_ID, quantity: 1, unitPricePence: 100, vatRate: 20 }];
    const cases: [string, () => Promise<unknown>, string, Record<string, unknown>?][] = [
      ["draft", () => submitPurchaseRequest(PRF_ID), "submitted", { items: aLine }],
      ["submitted", () => approvePurchaseRequest(PRF_ID), "approved"],
      ["submitted", () => rejectPurchaseRequest(PRF_ID, "Too expensive"), "draft"],
      ["approved", () => reopenPurchaseRequest(PRF_ID, "Supplier revised the quote"), "draft"],
      ["draft", () => cancelPurchaseRequest(PRF_ID, "No longer needed"), "cancelled"],
    ];
    for (const [from, act, to, extra] of cases) {
      vi.clearAllMocks();
      mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) => Promise.resolve(prfRow(data)));
      mockFindById.mockResolvedValue(prfRow({ status: from, ...extra }));
      await act();
      expect(prfEmits(), `${from} → ${to}`).toEqual([{ id: PRF_ID, code: "PRF-0001", status: to }]);
    }
  });

  it("does NOT notify when the transition is REJECTED (nothing changed)", async () => {
    // The stale-state 409 is precisely where a spurious "go refetch" would be most confusing.
    mockFindById.mockResolvedValue(prfRow({ status: "converted" }));
    await expect(approvePurchaseRequest(PRF_ID)).rejects.toThrow(/can't move/i);
    expect(prfEmits()).toEqual([]);
  });

  it("does NOT notify on a pure READ", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "approved" }));
    await getPurchaseRequest(PRF_ID);
    expect(prfEmits()).toEqual([]);
  });

  it("notifies on DELETE so a watcher's list drops the row", async () => {
    // Without this a watcher keeps seeing a row that no longer exists; acting on it 404s.
    mockFindById.mockResolvedValue(prfRow({ status: "draft" }));
    await deletePurchaseRequest(PRF_ID);
    expect(prfEmits()).toEqual([{ id: PRF_ID, code: "PRF-0001", status: "deleted" }]);
  });

  it("does NOT notify when a delete is REFUSED", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "approved" }));
    await expect(deletePurchaseRequest(PRF_ID)).rejects.toThrow(/only draft/i);
    expect(prfEmits()).toEqual([]);
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
    requiredByDate: FUTURE_REQUIRED_BY, // required on the PRF; becomes the PO's date
    justification: "Fibre rollout phase 2",
    notes: null,
    items: [
      { irmItemId: IRM_ID, itemName: "CAT6", sku: "C6", baseUnit: "Each", quantity: 10, unitPricePence: 500, vatRate: 20, lineTotalPence: 5000, notes: null, sortOrder: 0 },
    ],
    // The convert seam's include always supplies this array. Rental-specific conversion behaviour
    // has its own tests below; these existing ones prove an IRM-only PRF converts exactly as before.
    rentalItems: [],
    attachments: [
      {
        documentType: "quote",
        label: "Quote",
        fileName: "q.pdf",
        fileType: "pdf",
        fileSizeBytes: 111,
        url: "https://cdn/q.pdf",
        // Conversion does NOT re-upload the file, so the PO's row must end up naming the very same
        // Cloudinary asset. That shared identity is what the delete path counts.
        publicId: "senthra/purchase-orders/quote-abc.pdf",
        resourceType: "raw",
        uploadedBy: "requester@x.co",
      },
      // A SUPPORTING document, so the conversion is exercised on a request that holds both groups —
      // which is the only shape where flattening them would show up.
      {
        documentType: "other",
        label: null,
        fileName: "spec.pdf",
        fileType: "pdf",
        fileSizeBytes: 222,
        url: "https://cdn/spec.pdf",
        publicId: "senthra/purchase-orders/spec-def.pdf",
        resourceType: "raw",
        uploadedBy: "requester@x.co",
      },
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
    // The quotation evidence travels with the PO — as a second REFERENCE to one file, not a copy
    // of it. Both halves of the identity come across verbatim; nothing is re-derived from the URL.
    expect(attachments[0]).toMatchObject({
      fileName: "q.pdf",
      url: "https://cdn/q.pdf",
      publicId: "senthra/purchase-orders/quote-abc.pdf",
      resourceType: "raw",
    });
    expect(mockSetConvertedTx).toHaveBeenCalledWith({}, PRF_ID, "fin@x.co");
    expect(auditActions()).toEqual(expect.arrayContaining(["purchase_request.converted", "purchase_order.created"]));
  });

  // THE CONCURRENCY PROOF DEPENDS ON THIS. Removing a PRF attachment destroys its Cloudinary file
  // only after re-reading the PRF and finding it still `draft`. That is safe because a Reopen
  // (approved → draft) — the one transition that could make the re-read say `draft` while a
  // conversion is mid-flight holding the attachment in its snapshot — writes the PurchaseRequest
  // document, which is the SAME document setConvertedTx writes inside this transaction. MongoDB
  // aborts a transaction whose write target changed under it, so the conversion loses and its PO
  // attachment rows roll back with it.
  //
  // Move setConvertedTx out of this transaction and the PO rows would survive a Reopen that the
  // removal then reads as `draft` — and the file would be destroyed with a PO still naming it.
  // Do not weaken this test.
  it("writes the PRF in the same transaction as the PO attachments", async () => {
    await convertPurchaseRequest(PRF_ID, { type: "user", id: "u1", email: "fin@x.co", permissions: [] });
    const poTxClient = mockCreatePoTx.mock.calls[0][0];
    const prfTxClient = mockSetConvertedTx.mock.calls[0][0];
    expect(prfTxClient).toBe(poTxClient); // same object identity, not merely equal
  });

  // GUARD. The conversion hand-writes its attachment mapping against a GENERATED Prisma input type,
  // so a new column is optional there: forget to carry it and the code compiles, the tests pass, and
  // the PO row silently loses it. `publicId`/`resourceType` are exactly the columns where that is
  // unsafe — a PO attachment with no identity is a file nobody can delete, and one with the WRONG
  // identity is worse. If a field is added to the attachment record, add it here deliberately.
  const CARRIED_TO_PO = [
    // The document group. Dropping it would silently flatten a request's quotation package and its
    // supporting evidence into one list on the order — the exact distinction the two groups exist
    // to keep, lost at the one moment nobody is looking.
    "documentType",
    "label",
    "fileName",
    "fileType",
    "fileSizeBytes",
    "url",
    "publicId",
    "resourceType",
    "uploadedBy",
  ] as const;

  it("carries every attachment field the PRF row holds onto the PO row", async () => {
    await convertPurchaseRequest(PRF_ID, { type: "user", id: "u1", email: "fin@x.co", permissions: [] });
    const [, , , , attachments] = mockCreatePoTx.mock.calls[0];
    const source = liveApproved().attachments[0]!;

    // Nothing dropped…
    for (const field of CARRIED_TO_PO) {
      expect(attachments[0], field).toHaveProperty(field, source[field as keyof typeof source]);
    }
    // …and nothing extra invented, so this list stays an honest description of the mapping.
    expect(Object.keys(attachments[0] as object).sort()).toEqual([...CARRIED_TO_PO].sort());
  });

  // BOTH groups travel. Which one is not this module's call to make: the conversion has always
  // copied every attachment onto the order, and the buyer working the PO needs the spec the
  // reviewer approved against just as much as the quote. What changes is that they arrive still
  // told apart, rather than as one undifferentiated list.
  it("carries BOTH document groups onto the PO, each keeping its own group", async () => {
    await convertPurchaseRequest(PRF_ID, { type: "user", id: "u1", email: "fin@x.co", permissions: [] });
    const [, , , , attachments] = mockCreatePoTx.mock.calls[0];
    expect(attachments).toHaveLength(2);
    expect(attachments.map((a: { fileName: string; documentType: string }) => [a.fileName, a.documentType])).toEqual([
      ["q.pdf", "quote"],
      ["spec.pdf", "other"],
    ]);
  });

  // A LEGACY request's attachment has no stored group, and the request itself displays it under
  // Quotation. Copying the raw null across would put that same file on the order wearing no label,
  // so one document would answer the same question differently on two screens. Conversion is the
  // last point that knows the row came from a request — after it, null is indistinguishable from an
  // order's own uncategorised upload, which is a real and different thing.
  it("resolves a legacy attachment's absent group to `quote` on the way to the PO", async () => {
    mockFindForConvertTx.mockResolvedValue(
      liveApproved({
        attachments: [
          { documentType: null, label: null, fileName: "old-quote.pdf", fileType: "pdf", fileSizeBytes: 1, url: "https://cdn/old.pdf", publicId: "p/old", resourceType: "raw", uploadedBy: null },
        ],
      }),
    );
    await convertPurchaseRequest(PRF_ID, { type: "user", id: "u1", email: "fin@x.co", permissions: [] });
    const [, , , , attachments] = mockCreatePoTx.mock.calls[0];
    expect(attachments[0]).toMatchObject({ fileName: "old-quote.pdf", documentType: "quote" });
  });

  // Conversion is the one action that changes BOTH surfaces, so it must notify BOTH rooms: an open
  // PRF detail sees it become `converted`, and an open PO list sees the new draft order appear.
  it("notifies the PRF watchers AND the PO watchers (a new PO appears)", async () => {
    const mockEmitRoom = emitToRoom as ReturnType<typeof vi.fn>;
    const poId = "6".repeat(24);
    await convertPurchaseRequest(PRF_ID, { type: "user", id: "u1", email: "fin@x.co", permissions: [] });

    const sentTo = (room: string, event: string) =>
      mockEmitRoom.mock.calls.filter((c) => c[0] === room && c[1] === event).map((c) => c[2]);
    expect(sentTo(PURCHASE_REQUEST_WATCHERS_ROOM, "purchase_request:updated")).toEqual([
      { id: PRF_ID, code: "PRF-0001", status: "approved" }, // findById stub's status (post-convert refetch)
    ]);
    expect(sentTo(PURCHASE_ORDER_WATCHERS_ROOM, "purchase_order:updated")).toEqual([
      { id: poId, code: "PO-0042", status: "draft" },
    ]);
  });

  it("a failed convert notifies NOBODY (no PO was created)", async () => {
    const mockEmitRoom = emitToRoom as ReturnType<typeof vi.fn>;
    mockFindForConvertTx.mockResolvedValue(liveApproved({ status: "converted" }));
    await expect(convertPurchaseRequest(PRF_ID)).rejects.toThrow(/converted and can no longer/i);
    expect(mockEmitRoom).not.toHaveBeenCalled();
  });

  it("a concurrent second convert fails inside the transaction (already converted) — no PO created", async () => {
    mockFindForConvertTx.mockResolvedValue(liveApproved({ status: "converted" }));
    await expect(convertPurchaseRequest(PRF_ID)).rejects.toThrow(/converted and can no longer/i);
    expect(mockCreatePoTx).not.toHaveBeenCalled();
    expect(mockSetConvertedTx).not.toHaveBeenCalled();
  });

  // The PO's delivery date is the date the REQUESTER asked for — carried across verbatim.
  it("carries the PRF's required-by date onto the PO as its expected delivery date", async () => {
    const requiredBy = new Date(Date.now() + 60 * 86_400_000);
    mockFindForConvertTx.mockResolvedValue(liveApproved({ requiredByDate: requiredBy }));
    await convertPurchaseRequest(PRF_ID);

    const [, header] = mockCreatePoTx.mock.calls[0];
    expect(header.expectedDeliveryDate).toEqual(requiredBy);
  });

  // A date computed from the supplier's standing lead time looks like a commitment nobody made,
  // and would sit on screen contradicting whatever the supplier later confirms.
  it("does NOT derive a date from the supplier's lead time", async () => {
    const requiredBy = new Date(Date.now() + 60 * 86_400_000);
    mockFindForConvertTx.mockResolvedValue(liveApproved({ requiredByDate: requiredBy }));
    mockReqSupplier.mockResolvedValue({ name: "Acme", leadTimeDays: 14 });
    await convertPurchaseRequest(PRF_ID);

    const [, header] = mockCreatePoTx.mock.calls[0];
    expect(header.expectedDeliveryDate).toEqual(requiredBy); // NOT orderDate + 14 days
  });

  // The field is nullable in the schema (PRFs raised before it existed have none), so convert must
  // refuse rather than mint a PO with no delivery date — that PO would be blocked at approval with
  // nothing on screen explaining why.
  it("refuses to convert a legacy PRF that has no required-by date", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "approved", requiredByDate: null }));
    await expect(convertPurchaseRequest(PRF_ID)).rejects.toThrow(/no required-by date/i);
    expect(mockCreatePoTx).not.toHaveBeenCalled();
    expect(mockAllocateCode).not.toHaveBeenCalled(); // fails BEFORE burning a PO code
  });

  it("refuses inside the transaction too, if the date vanished after the pre-check", async () => {
    mockFindForConvertTx.mockResolvedValue(liveApproved({ requiredByDate: null }));
    await expect(convertPurchaseRequest(PRF_ID)).rejects.toThrow(/no required-by date/i);
    expect(mockCreatePoTx).not.toHaveBeenCalled();
  });

  // The required-by date is captured when the PRF is RAISED, but approval is a human step — so by
  // conversion time it can already have passed. Every manual PO path enforces
  // expectedDeliveryDate >= orderDate; this one builds the row directly, so without an explicit
  // guard it is the single way to mint a PO whose delivery date precedes its own order date.
  // Dates are relative to "now" so these can never rot into false failures on a fixed calendar day.
  const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);

  it("refuses to convert when the required-by date has already passed", async () => {
    const stale = daysFromNow(-1);
    mockFindById.mockResolvedValue(prfRow({ status: "approved", requiredByDate: stale }));
    await expect(convertPurchaseRequest(PRF_ID)).rejects.toThrow(/required-by date has passed/i);
    expect(mockCreatePoTx).not.toHaveBeenCalled();
    expect(mockAllocateCode).not.toHaveBeenCalled(); // fails BEFORE burning a PO code
  });

  it("refuses inside the transaction too, if the live PRF's date has passed", async () => {
    mockFindForConvertTx.mockResolvedValue(liveApproved({ requiredByDate: daysFromNow(-1) }));
    await expect(convertPurchaseRequest(PRF_ID)).rejects.toThrow(/required-by date has passed/i);
    expect(mockCreatePoTx).not.toHaveBeenCalled();
  });

  // Date-only comparison: goods due TODAY are still legitimately convertible, whatever the time of
  // day. A raw timestamp comparison would reject this the moment the clock passed midnight.
  it("allows converting when the goods are required TODAY", async () => {
    const today = new Date();
    mockFindById.mockResolvedValue(prfRow({ status: "approved", requiredByDate: today }));
    mockFindForConvertTx.mockResolvedValue(liveApproved({ requiredByDate: today }));
    await convertPurchaseRequest(PRF_ID);
    expect(mockCreatePoTx).toHaveBeenCalled();
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

describe("generateReorderPrfs — Reorder-workbench generation", () => {
  const WH_ID_2 = "e".repeat(24);

  // A live workbench suggestion row, as getReorderSuggestions returns it.
  const suggestion = (over: Record<string, unknown> = {}) => ({
    irmItemId: IRM_ID,
    itemCode: "IRM-0001",
    itemName: "CAT6",
    sku: "C6",
    baseUnit: "Each",
    warehouseId: WH_ID,
    warehouseName: "Leeds",
    warehouseCode: "WH-0001",
    onHand: 5,
    reserved: 0,
    available: 5,
    incoming: 0,
    openPrf: 0,
    projected: 5,
    reorderLevel: 20,
    target: 100,
    packSize: null,
    suggestedQty: 95,
    reason: "below_reorder",
    unitCostPence: 500,
    primarySupplier: { id: SUP_ID, name: "Acme", status: "active", leadTimeDays: 7 },
    ...over,
  });
  const live = (rows: unknown[]) => mockSuggestions.mockResolvedValue({ suggestions: rows, calculatedAt: new Date().toISOString() });
  const row = (over: Record<string, unknown> = {}) => ({ irmItemId: IRM_ID, warehouseId: WH_ID, supplierId: SUP_ID, quantity: 95, ...over });

  beforeEach(() => {
    mockCreateWithCode.mockImplementation((header: Record<string, unknown>) => Promise.resolve(prfRow({ ...header, items: [] })));
  });

  it("groups rows for the same supplier × warehouse into ONE draft PRF with reorder provenance", async () => {
    live([suggestion(), suggestion({ irmItemId: IRM_ID_2, itemName: "Patch Panel", suggestedQty: 20, unitCostPence: 1000 })]);
    const result = await generateReorderPrfs({
      rows: [row(), row({ irmItemId: IRM_ID_2, quantity: 20 })],
    } as Parameters<typeof generateReorderPrfs>[0]);

    expect(mockCreateWithCode).toHaveBeenCalledTimes(1);
    const [header, lines] = mockCreateWithCode.mock.calls[0];
    expect(header).toMatchObject({ supplierId: SUP_ID, warehouseId: WH_ID, status: "draft", sourceType: "reorder" });
    expect(header.justification).toMatch(/reorder workbench/i);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ irmItemId: IRM_ID, quantity: 95, unitPricePence: 500 });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ code: "PRF-0001", supplierName: "Acme", warehouseName: "Leeds", lineCount: 2 });
    expect(result.skipped).toHaveLength(0);
    expect(result.adjusted).toHaveLength(0);
    expect(auditActions()).toContain("purchase_request.created");
  });

  it("creates one PRF per warehouse — a PRF never spans warehouses", async () => {
    live([suggestion(), suggestion({ irmItemId: IRM_ID_2, warehouseId: WH_ID_2, warehouseName: "Manchester", suggestedQty: 20 })]);
    const result = await generateReorderPrfs({
      rows: [row(), row({ irmItemId: IRM_ID_2, warehouseId: WH_ID_2, quantity: 20 })],
    } as Parameters<typeof generateReorderPrfs>[0]);
    expect(mockCreateWithCode).toHaveBeenCalledTimes(2);
    expect(result.created).toHaveLength(2);
    const warehouses = mockCreateWithCode.mock.calls.map((c) => c[0].warehouseId);
    expect(warehouses).toEqual(expect.arrayContaining([WH_ID, WH_ID_2]));
  });

  it("SKIPS a row the live revalidation no longer triggers (stale list / concurrent generate)", async () => {
    live([]); // nothing needs reordering any more
    const result = await generateReorderPrfs({
      rows: [row({ itemName: "CAT6", warehouseName: "Leeds" })],
    } as Parameters<typeof generateReorderPrfs>[0]);
    expect(mockCreateWithCode).not.toHaveBeenCalled();
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ irmItemId: IRM_ID, itemName: "CAT6" });
    expect(result.skipped[0].reason).toMatch(/no longer requires reordering/i);
  });

  it("CAPS a quantity above the live need and reports it in `adjusted` — never silently", async () => {
    live([suggestion({ suggestedQty: 40 })]);
    const result = await generateReorderPrfs({
      rows: [row({ quantity: 100 })],
    } as Parameters<typeof generateReorderPrfs>[0]);
    const [, lines] = mockCreateWithCode.mock.calls[0];
    expect(lines[0].quantity).toBe(40);
    expect(result.adjusted).toHaveLength(1);
    expect(result.adjusted[0]).toMatchObject({ requestedQty: 100, finalQty: 40, itemName: "CAT6" });
  });

  it("defaults required-by to today + the group's longest supplier lead time (fallback 14 days)", async () => {
    live([suggestion({ primarySupplier: { id: SUP_ID, name: "Acme", status: "active", leadTimeDays: 7 } })]);
    await generateReorderPrfs({ rows: [row()] } as Parameters<typeof generateReorderPrfs>[0]);
    const requiredBy = mockCreateWithCode.mock.calls[0][0].requiredByDate as Date;
    const days = (requiredBy.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    vi.clearAllMocks();
    mockReqSupplier.mockResolvedValue({ name: "Acme" });
    mockReqWarehouse.mockResolvedValue({ id: WH_ID });
    mockReqIrms.mockImplementation((ids: string[]) => Promise.resolve(new Map(ids.map((id) => [id, irmRow(id)]))));
    mockCreateWithCode.mockImplementation((header: Record<string, unknown>) => Promise.resolve(prfRow({ ...header, items: [] })));
    live([suggestion({ primarySupplier: null })]);
    await generateReorderPrfs({ rows: [row()] } as Parameters<typeof generateReorderPrfs>[0]);
    const fallback = mockCreateWithCode.mock.calls[0][0].requiredByDate as Date;
    const fallbackDays = (fallback.getTime() - Date.now()) / 86_400_000;
    expect(fallbackDays).toBeGreaterThan(13.9);
    expect(fallbackDays).toBeLessThan(14.1);
  });

  it("SKIPS a group whose supplier/warehouse went inactive without aborting the other groups", async () => {
    live([
      suggestion(),
      suggestion({ irmItemId: IRM_ID_2, warehouseId: WH_ID_2, warehouseName: "Manchester", suggestedQty: 20 }),
    ]);
    // First group's supplier lookup fails (deactivated since the list was calculated); second succeeds.
    mockReqSupplier
      .mockRejectedValueOnce(new Error("Selected supplier is inactive and can't be used."))
      .mockResolvedValue({ name: "Acme" });
    const result = await generateReorderPrfs({
      rows: [
        row({ itemName: "CAT6", warehouseName: "Leeds" }),
        row({ irmItemId: IRM_ID_2, warehouseId: WH_ID_2, quantity: 20 }),
      ],
    } as Parameters<typeof generateReorderPrfs>[0]);
    expect(mockCreateWithCode).toHaveBeenCalledTimes(1); // only the healthy group
    expect(result.created).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ irmItemId: IRM_ID });
    expect(result.skipped[0].reason).toMatch(/inactive/i);
  });

  it("uses an explicit required-by override for every generated PRF", async () => {
    live([suggestion()]);
    await generateReorderPrfs({ rows: [row()], requiredByDate: "2026-09-30" } as Parameters<typeof generateReorderPrfs>[0]);
    const requiredBy = mockCreateWithCode.mock.calls[0][0].requiredByDate as Date;
    expect(requiredBy.toISOString().slice(0, 10)).toBe("2026-09-30");
  });
});

// Cleanup runs AFTER the row is gone, never before. The order is the concurrency argument: counting
// surviving references before the delete leaves a window where another request commits one, and the
// only failure this design permits is a leaked file — never a deleted-but-referenced one.
describe("PRF attachments — Cloudinary cleanup", () => {
  const mockFindAtt = prfRepo.findAttachment as ReturnType<typeof vi.fn>;
  const mockRemoveAtt = prfRepo.removeAttachment as ReturnType<typeof vi.fn>;
  const mockAddAtt = prfRepo.addAttachment as ReturnType<typeof vi.fn>;
  const release = attachmentService.releaseAsset as ReturnType<typeof vi.fn>;
  const ATT = { id: "att1", purchaseRequestId: PRF_ID, publicId: "senthra/purchase-orders/q.pdf", resourceType: "raw" };

  beforeEach(() => {
    mockFindById.mockResolvedValue(prfRow({ status: "draft" }));
    mockFindAtt.mockResolvedValue(ATT);
  });

  it("stores the Cloudinary identity when an attachment is added", async () => {
    await attachUploadedAsset(PRF_ID, {
      fileName: "q.pdf",
      fileType: "pdf",
      fileSizeBytes: 9,
      url: "https://cdn/q.pdf",
      publicId: "senthra/purchase-orders/q.pdf",
      resourceType: "raw",
    });
    // Identity, not just the URL. A row with only a URL can never have its file destroyed.
    expect(mockAddAtt.mock.calls[0][0]).toMatchObject({
      url: "https://cdn/q.pdf",
      publicId: "senthra/purchase-orders/q.pdf",
      resourceType: "raw",
    });
  });

  // ── Document groups ───────────────────────────────────────────────────────────────────────
  //
  // The category is a persisted COLUMN, not a convention over the label or over which picker the
  // file came out of. These pin the three things that makes true: it is written on every add, it is
  // written explicitly even when it is the default, and a row that predates the column still reads
  // as the group it was uploaded under.
  describe("document groups", () => {
    it("persists the group the uploader chose", async () => {
      await attachUploadedAsset(PRF_ID, {
        documentType: "other",
        fileName: "spec.pdf",
        fileType: "pdf",
        fileSizeBytes: 9,
        url: "https://cdn/spec.pdf",
        publicId: "senthra/purchase-orders/spec.pdf",
        resourceType: "raw",
      });
      expect(mockAddAtt.mock.calls[0][0]).toMatchObject({ documentType: "other" });
    });

    // The older upload path sends no group, and every file it ever sent was a quote — the field it
    // came out of said so. Storing that EXPLICITLY (rather than leaving the column blank) is what
    // keeps "no stored group" meaning "written before there were two", and nothing else.
    it("stores an explicit `quote` when no group is sent", async () => {
      await attachUploadedAsset(PRF_ID, {
        fileName: "q.pdf",
        fileType: "pdf",
        fileSizeBytes: 9,
        url: "https://cdn/q.pdf",
        publicId: "senthra/purchase-orders/q.pdf",
        resourceType: "raw",
      });
      expect(mockAddAtt.mock.calls[0][0]).toMatchObject({ documentType: "quote" });
    });

    // BACKWARD COMPATIBILITY. Nothing was backfilled, so the rows written before the second group
    // existed have no value at all. They are quote documents — they were uploaded under a field
    // labelled "Quote document(s)" — and the read side has to say so without a migration.
    it("reads a legacy row with no stored group as a quote document", async () => {
      mockFindById.mockResolvedValue(
        prfRow({
          status: "draft",
          attachments: [
            { id: "a1", documentType: null, label: null, fileName: "old.pdf", fileType: "pdf", fileSizeBytes: 1, url: "https://cdn/old.pdf", uploadedBy: null, createdAt: new Date() },
            { id: "a2", documentType: "other", label: null, fileName: "new.pdf", fileType: "pdf", fileSizeBytes: 1, url: "https://cdn/new.pdf", uploadedBy: null, createdAt: new Date() },
          ],
        }),
      );
      const dto = await getPurchaseRequest(PRF_ID);
      expect(dto.attachments.map((a) => [a.fileName, a.documentType])).toEqual([
        ["old.pdf", "quote"],
        ["new.pdf", "other"],
      ]);
    });

    // The trail is asked WHICH document went, after the row that could answer is gone.
    it("names the group in the removal audit entry", async () => {
      mockFindAtt.mockResolvedValue({ ...ATT, documentType: "other", fileName: "spec.pdf" });
      await removeAttachment(PRF_ID, "att1");
      const entry = auditEntries().find((e) => e.action === "purchase_request.attachment_removed");
      expect(entry?.metadata).toMatchObject({ documentType: "other", fileName: "spec.pdf" });
    });
  });

  it("hands the removed row's identity to the cleanup", async () => {
    await removeAttachment(PRF_ID, "att1");
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toMatchObject({ publicId: ATT.publicId, resourceType: ATT.resourceType });
    expect(release.mock.calls[0][1]).toContain("PRF-0001"); // context, so a failed cleanup is traceable
  });

  it("releases only AFTER the DB row is deleted", async () => {
    const order: string[] = [];
    mockRemoveAtt.mockImplementation(() => { order.push("db"); return Promise.resolve({}); });
    release.mockImplementation(() => { order.push("cleanup"); return Promise.resolve(); });
    await removeAttachment(PRF_ID, "att1");
    expect(order).toEqual(["db", "cleanup"]);
  });

  it("never releases when the guard rejects the removal", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "approved" })); // draft-only
    await expect(removeAttachment(PRF_ID, "att1")).rejects.toThrow(/only be changed on a draft/i);
    expect(release).not.toHaveBeenCalled();
  });

  // ── The re-check ────────────────────────────────────────────────────────────────────────────
  //
  // Converting a PRF copies its attachments' identity onto the PO instead of re-uploading the
  // files, and the conversion runs in a transaction whose reads are snapshot-based. So a conversion
  // can be mid-flight, already holding this attachment in its snapshot, while releaseAsset's
  // reference count sees nothing — the PO row does not exist yet. A fresh status read AFTER the
  // delete is what catches it: for that conversion to have seen this row, the approval was already
  // committed, so the status read here cannot still say `draft`.
  //
  // `findById` is called three times in this path — the initial load, this fresh read, and the
  // final DTO read — so these tests sequence it with mockResolvedValueOnce.
  describe("only destroys while the PRF is still, freshly, a draft", () => {
    const seq = (...rows: unknown[]) => {
      mockFindById.mockReset();
      for (const r of rows) mockFindById.mockResolvedValueOnce(r);
      mockFindById.mockResolvedValue(prfRow({ status: "draft" })); // any further reads
    };

    it("releases when the PRF is still a draft after the delete", async () => {
      seq(prfRow({ status: "draft" }), prfRow({ status: "draft" }));
      await removeAttachment(PRF_ID, "att1");
      expect(mockRemoveAtt).toHaveBeenCalledWith("att1");
      expect(release).toHaveBeenCalledTimes(1);
    });

    // Each of these means work moved on underneath us. `approved` and `converted` are the ones that
    // can actually have a conversion behind them; `submitted` and `cancelled` cannot, but they are
    // equally not-draft and the rule stays one rule rather than a list of exceptions.
    it.each(["submitted", "approved", "converted", "cancelled"])(
      "leaves the asset alone when the PRF is %s by then",
      async (status) => {
        seq(prfRow({ status: "draft" }), prfRow({ status }));
        await removeAttachment(PRF_ID, "att1");
        expect(mockRemoveAtt).toHaveBeenCalledWith("att1"); // the row still goes
        expect(release).not.toHaveBeenCalled(); // the file does not
      },
    );

    it("leaves the asset alone when the PRF can no longer be read", async () => {
      seq(prfRow({ status: "draft" }), null);
      // Still succeeds: the delete is committed and the caller gets their PRF back.
      await expect(removeAttachment(PRF_ID, "att1")).resolves.toMatchObject({ code: "PRF-0001" });
      expect(release).not.toHaveBeenCalled();
    });

    it("names the asset and the status in the skip log, for later reconciliation", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      seq(prfRow({ status: "draft" }), prfRow({ status: "approved" }));
      await removeAttachment(PRF_ID, "att1");
      expect(err).toHaveBeenCalledWith(expect.stringContaining(ATT.publicId));
      expect(err).toHaveBeenCalledWith(expect.stringContaining("approved"));
      err.mockRestore();
    });

    // MANDATORY ORDERING. Reading the status BEFORE the delete reopens the window this closes: a
    // conversion could commit in the gap between that read and the delete. And releasing before the
    // read would make the guard decorative.
    it("deletes, THEN re-reads the status, THEN releases — in that order", async () => {
      const order: string[] = [];
      mockFindById.mockReset();
      mockFindById.mockImplementation(() => {
        order.push("read");
        return Promise.resolve(prfRow({ status: "draft" }));
      });
      mockRemoveAtt.mockImplementation(() => { order.push("db"); return Promise.resolve({}); });
      release.mockImplementation(() => { order.push("cleanup"); return Promise.resolve(); });

      await removeAttachment(PRF_ID, "att1");

      // load, delete, fresh re-read, cleanup, final DTO read.
      expect(order).toEqual(["read", "db", "read", "cleanup", "read"]);
      expect(order.indexOf("db")).toBeLessThan(order.lastIndexOf("read"));
      expect(order.indexOf("cleanup")).toBeGreaterThan(order.indexOf("db"));
    });
  });

  // Ten documents, not the GRN's five: a PRF is one supplier's quotation package. Bounded because the
  // detail read loads every attachment on the record.
  // Ten documents, not the GRN's five: a PRF is one supplier's quotation package. Bounded because the
  // detail read loads every attachment on the record.
  //
  // Asserted against `assertCanAttach` rather than an uploader: that is the function the direct-upload
  // path runs as its preCheck, BEFORE a signature is minted — so a refusal here means the file never
  // reaches Cloudinary at all, and there is no orphan for the reaper to find.
  describe("count cap", () => {
    const attRow = (i: number) => ({
      id: `a${i}`, label: null, fileName: `q${i}.pdf`, fileType: "pdf", fileSizeBytes: 100,
      url: `https://cdn/q${i}.pdf`, publicId: `p${i}`, resourceType: "raw", uploadedBy: null,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    const withN = (n: number) => prfRow({ status: "draft", attachments: Array.from({ length: n }, (_, i) => attRow(i)) });
    const big = (i: number) => ({ ...attRow(i), fileSizeBytes: 8 * 1024 * 1024 });

    it("accepts the tenth document", async () => {
      mockFindById.mockResolvedValue(withN(9));
      await expect(assertCanAttach(PRF_ID, 9)).resolves.toBeUndefined();
    });

    it("refuses the eleventh", async () => {
      mockFindById.mockResolvedValue(withN(10));
      await expect(assertCanAttach(PRF_ID, 9)).rejects.toThrow(/at most 10 documents/i);
    });

    // The count alone left a gap: ten files at the 10 MB per-file ceiling is 100 MB on one record.
    it("refuses a document that would push the record past 40 MB", async () => {
      mockFindById.mockResolvedValue(prfRow({ status: "draft", attachments: Array.from({ length: 5 }, (_, i) => big(i)) }));
      await expect(assertCanAttach(PRF_ID, 2 * 1024 * 1024)).rejects.toThrow(/can't exceed 40 MB/i);
    });

    it("accepts one that stays inside 40 MB", async () => {
      mockFindById.mockResolvedValue(prfRow({ status: "draft", attachments: Array.from({ length: 4 }, (_, i) => big(i)) }));
      await expect(assertCanAttach(PRF_ID, 2 * 1024 * 1024)).resolves.toBeUndefined();
    });
  });

  // A soft delete keeps every attachment row, so the references survive and the files must too.
  it("soft-deleting the PRF destroys nothing", async () => {
    await deletePurchaseRequest(PRF_ID);
    expect(release).not.toHaveBeenCalled();
  });
});


// ── Rental lines on conversion ────────────────────────────────────────────────────────────────

describe("convert — rental lines", () => {
  const RENTAL_ID = "e".repeat(24);
  const mockReqRentals = rentalItemService.requireActiveRentalItems as ReturnType<typeof vi.fn>;

  const rentalRow = (over: Record<string, unknown> = {}) => ({
    rentalItemId: RENTAL_ID,
    itemName: "Fibre Tester",
    baseUnit: "Each",
    quantity: 2,
    hireStartDate: new Date("2026-09-01T00:00:00Z"),
    hireEndDate: new Date("2026-10-01T00:00:00Z"),
    notifyDaysBefore: 3,
    deliveryAddress: "Unit 4\nLeeds",
    unitPricePence: 15000,
    vatRate: 20,
    lineTotalPence: 30000,
    notes: "Calibrated",
    sortOrder: 0,
    ...over,
  });

  const liveWithRental = (rentalItems: Record<string, unknown>[]) => ({
    id: PRF_ID,
    code: "PRF-0001",
    status: "approved",
    supplierId: SUP_ID,
    warehouseId: WH_ID,
    jobId: null,
    projectRef: null,
    quoteReference: null,
    requiredByDate: FUTURE_REQUIRED_BY,
    justification: null,
    notes: null,
    deliveryTerms: null,
    paymentTerms: null,
    subtotalPence: 30000,
    vatPence: 6000,
    grandTotalPence: 36000,
    currency: "GBP",
    items: [],
    rentalItems,
    attachments: [],
  });

  beforeEach(() => {
    mockReqRentals.mockResolvedValue(undefined);
    mockFindById.mockResolvedValue(prfRow({ status: "approved", rentalItems: [rentalRow()] }));
    mockFindForConvertTx.mockResolvedValue(liveWithRental([rentalRow()]));
    mockAllocateCode.mockResolvedValue("PO-0001");
    mockCreatePoTx.mockResolvedValue("po1");
  });

  // Requirement: the COMPLETE snapshot and commercial data, not just the id. Naming every field
  // rather than spot-checking two is the point — a partial copy leaves the hire without its period
  // or its price on the record the supplier actually reads.
  it("copies every rental line field onto the purchase order", async () => {
    await convertPurchaseRequest(PRF_ID);
    const created = (mockCreatePoTx.mock.calls[0]![5] as Record<string, unknown>[])[0];
    expect(created).toEqual({
      rentalItemId: RENTAL_ID,
      itemName: "Fibre Tester",
      baseUnit: "Each",
      quantity: 2,
      hireStartDate: new Date("2026-09-01T00:00:00Z"),
      hireEndDate: new Date("2026-10-01T00:00:00Z"),
      notifyDaysBefore: 3,
      deliveryAddress: "Unit 4\nLeeds",
      unitPricePence: 15000,
      vatRate: 20,
      lineTotalPence: 30000,
      notes: "Calibrated",
      sortOrder: 0,
      hireStatus: "awaiting_delivery",
      // 30-day hire, 3-day lead → day 27.
      notifyOnDate: new Date("2026-09-28T00:00:00Z"),
    });
  });

  // The order is a commitment to the provider, not a delivery. A converted hire used to land on
  // `on_hire`, so the on-hire list showed kit nobody had touched and a hire whose end date passed
  // while the delivery was still in transit went red for a return that could not happen.
  it("starts a converted hire AWAITING DELIVERY, not on hire", async () => {
    await convertPurchaseRequest(PRF_ID);
    const created = (mockCreatePoTx.mock.calls[0]![5] as Record<string, unknown>[])[0]!;
    expect(created.hireStatus).toBe("awaiting_delivery");
    // The reminder date is still computed at conversion — the deadline exists, it just does not
    // count until someone confirms the kit arrived.
    expect(created.notifyOnDate).toEqual(new Date("2026-09-28T00:00:00Z"));
  });

  it("starts a converted hire un-notified so the reminder can still fire", async () => {
    await convertPurchaseRequest(PRF_ID);
    const created = (mockCreatePoTx.mock.calls[0]![5] as Record<string, unknown>[])[0]!;
    expect(created.deadlineNotifiedAt).toBeUndefined();
    expect(created.deadlineNotifyClaimToken).toBeUndefined();
  });

  // A short hire keeps the default 3-day lead and is simply reminded on its start date.
  it("clamps the reminder for a hire shorter than its lead", async () => {
    const short = rentalRow({ hireStartDate: new Date("2026-09-01T00:00:00Z"), hireEndDate: new Date("2026-09-03T00:00:00Z") });
    mockFindForConvertTx.mockResolvedValue(liveWithRental([short]));
    await convertPurchaseRequest(PRF_ID);
    const created = (mockCreatePoTx.mock.calls[0]![5] as Record<string, unknown>[])[0]!;
    expect(created.notifyOnDate).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  it("refuses to convert when a rental item has been retired", async () => {
    mockReqRentals.mockRejectedValue(new Error("One or more rental items are no longer active."));
    await expect(convertPurchaseRequest(PRF_ID)).rejects.toThrow(/no longer active/i);
    expect(mockCreatePoTx).not.toHaveBeenCalled();
  });

  // The figure an approver signs off and the supplier reads. Computing it from the IRM lines alone
  // made a hire-only order total ZERO while its own request showed the real number.
  it("totals the purchase order over BOTH kinds of line", async () => {
    await convertPurchaseRequest(PRF_ID);
    const header = mockCreatePoTx.mock.calls[0]![1] as Record<string, number>;
    // 2 x 15000 ex-VAT, 20% VAT.
    expect(header.subtotalPence).toBe(30000);
    expect(header.vatPence).toBe(6000);
    expect(header.grandTotalPence).toBe(36000);
  });

  it("totals an IRM-only order exactly as before", async () => {
    mockFindForConvertTx.mockResolvedValue(liveApprovedForRental());
    await convertPurchaseRequest(PRF_ID);
    const header = mockCreatePoTx.mock.calls[0]![1] as Record<string, number>;
    expect(header.subtotalPence).toBe(5000);
    expect(header.grandTotalPence).toBe(6000);
  });

  it("passes an empty rental array for an IRM-only request", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "approved" }));
    mockFindForConvertTx.mockResolvedValue(liveApprovedForRental());
    await convertPurchaseRequest(PRF_ID);
    expect(mockCreatePoTx.mock.calls[0]![5]).toEqual([]);
  });

  function liveApprovedForRental() {
    return { ...liveWithRental([]), items: [{ irmItemId: IRM_ID, itemName: "CAT6", sku: "C6", baseUnit: "Each", quantity: 10, unitPricePence: 500, vatRate: 20, lineTotalPence: 5000, notes: null, sortOrder: 0 }] };
  }
});

// ── Rental-only requests move through the workflow ────────────────────────────────────────────
//
// THE regression the browser pass caught: a hire-only request saved cleanly and then could not be
// submitted, because the submit gate counted IRM lines alone. No create-time validation would have
// found it — the request itself was valid.
describe("submit — a request carrying only rental lines", () => {
  const rentalLine = {
    id: "rl1",
    rentalItemId: "e".repeat(24),
    itemName: "Fibre Tester",
    baseUnit: "Each",
    quantity: 1,
    hireStartDate: new Date("2026-09-01T00:00:00Z"),
    hireEndDate: new Date("2026-10-01T00:00:00Z"),
    notifyDaysBefore: 3,
    deliveryAddress: null,
    unitPricePence: 15000,
    vatRate: 20,
    lineTotalPence: 15000,
    notes: null,
    sortOrder: 0,
    rentalItem: { id: "e".repeat(24), code: "RNT-0001", name: "Fibre Tester", status: "active" },
  };

  it("submits a rental-only request", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "draft", items: [], rentalItems: [rentalLine] }));
    mockUpdate.mockResolvedValue(prfRow({ status: "submitted", items: [], rentalItems: [rentalLine] }));
    await expect(submitPurchaseRequest(PRF_ID)).resolves.toBeTruthy();
  });

  it("still refuses a request with no lines of either kind", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "draft", items: [], rentalItems: [] }));
    await expect(submitPurchaseRequest(PRF_ID)).rejects.toThrow(/at least one item or rental line/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ── Edits must not silently drop what they did not send ───────────────────────────────────────

describe("update — rental lines and the wipe guard", () => {
  const rentalRow = {
    id: "rl1",
    rentalItemId: "e".repeat(24),
    itemName: "Fibre Tester",
    baseUnit: "Each",
    quantity: 1,
    hireStartDate: new Date("2026-09-01T00:00:00Z"),
    hireEndDate: new Date("2026-10-01T00:00:00Z"),
    notifyDaysBefore: 3,
    deliveryAddress: null,
    unitPricePence: 15000,
    vatRate: 20,
    lineTotalPence: 15000,
    notes: null,
    sortOrder: 0,
    rentalItem: { id: "e".repeat(24), code: "RNT-0001", name: "Fibre Tester", status: "active" },
  };

  beforeEach(() => {
    (rentalItemService.requireActiveRentalItems as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (rentalItemService.getRentalItemsByIds as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["e".repeat(24), { name: "Fibre Tester", baseUnit: "Each", vatRatePercent: 20 }]]),
    );
  });

  // The MONEY on a rate basis is the server's arithmetic, never the client's number: a browser that
  // sends a stale (or invented) price must not be able to file it beside a rate that contradicts it.
  describe("pricing basis — the server decides the money", () => {
    const hire = (over: Record<string, unknown>) => ({
      rentalItemId: "e".repeat(24),
      quantity: 3,
      // Dates, not strings: the schema turns them into UTC midnights before the service ever sees
      // a line, so a string fixture would be testing a shape production never produces.
      hireStartDate: new Date("2026-08-17T00:00:00.000Z"),
      hireEndDate: new Date("2026-10-01T00:00:00.000Z"), // 45 days
      unitPricePence: 1, // deliberately wrong — the server must ignore it
      vatRate: 20,
      ...over,
    });
    const create = async (rentalItems: Record<string, unknown>[]) => {
      mockCreateWithCode.mockImplementation((header: Record<string, unknown>) => Promise.resolve(prfRow({ ...header, items: [] })));
      await createPurchaseRequest({
        supplierId: SUP_ID, warehouseId: WH_ID, requiredByDate: "2026-12-31", items: [], rentalItems,
      } as unknown as Parameters<typeof createPurchaseRequest>[0]);
      return mockCreateWithCode.mock.calls.at(-1)!;
    };

    it("recomputes a daily rate and ignores the price the client sent", async () => {
      const [, , rentals] = await create([hire({ ratePeriod: "day", ratePence: 5500 })]);
      // £55 × 45 days = £2,475 per unit; × 3 = £7,425.
      expect(rentals[0]).toMatchObject({ unitPricePence: 247_500, lineTotalPence: 742_500 });
    });

    // THE regression: the unit price was recomputed while the line total was still multiplying the
    // number the client sent, so a £2,475 line was filed with a £0.03 total.
    it("uses the SAME price for the line total", async () => {
      const [, , rentals] = await create([hire({ ratePeriod: "week", ratePence: 30_000 })]);
      expect(rentals[0].lineTotalPence).toBe(rentals[0].quantity * rentals[0].unitPricePence);
    });

    it("keeps a NEGOTIATED price, and the rate beside it", async () => {
      const [, , rentals] = await create([
        hire({ ratePeriod: "day", ratePence: 5500, priceOverridden: true, unitPricePence: 230_000 }),
      ]);
      expect(rentals[0]).toMatchObject({ unitPricePence: 230_000, ratePence: 5500, priceOverridden: true });
    });

    it("takes the typed figure on the total basis, and files no rate", async () => {
      const [, , rentals] = await create([hire({ ratePeriod: "total", unitPricePence: 16_500 })]);
      expect(rentals[0]).toMatchObject({ unitPricePence: 16_500, ratePence: null, priceOverridden: false });
    });

    // An override only means something where there is a calculation to override.
    it("cannot be overridden on the total basis", async () => {
      const [, , rentals] = await create([hire({ ratePeriod: "total", unitPricePence: 16_500, priceOverridden: true })]);
      expect(rentals[0].priceOverridden).toBe(false);
    });
  });

  // THE regression. `itemsField` lost its `.min(1)` when rental lines arrived and the replacement
  // body rule landed on the CREATE schema only, so this PATCH wiped every line and zeroed the
  // totals — something the old rule had always refused.
  it("refuses an update that would leave the request with no lines at all", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "draft", items: [prfItem()], rentalItems: [rentalRow] }));
    await expect(updatePurchaseRequest(PRF_ID, { items: [], rentalItems: [] })).rejects.toThrow(
      /at least one item or rental line/i,
    );
    expect(prfRepo.replaceItemsAndTotals).not.toHaveBeenCalled();
  });

  // Sending one array is legitimate when the OTHER kind still carries the request.
  it("allows clearing the IRM lines when rental lines remain", async () => {
    mockFindById.mockResolvedValue(prfRow({ status: "draft", items: [prfItem()], rentalItems: [rentalRow] }));
    (prfRepo.replaceItemsAndTotals as ReturnType<typeof vi.fn>).mockResolvedValue(
      prfRow({ status: "draft", items: [], rentalItems: [rentalRow] }),
    );
    await updatePurchaseRequest(PRF_ID, { items: [] });
    const call = (prfRepo.replaceItemsAndTotals as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1]).toEqual([]);
    // The rental lines are re-derived from what is stored, not dropped.
    expect(call[4]).toHaveLength(1);
    // ...and the totals still count them.
    expect(call[2]).toMatchObject({ subtotalPence: 15000 });
  });
});

describe("duplicate — the revision carries the whole request", () => {
  // The header's totals are copied verbatim, so dropping the rental lines minted a revision whose
  // grand total did not match the lines it showed.
  it("copies rental lines onto the duplicate", async () => {
    const rentalRow = {
      rentalItemId: "e".repeat(24),
      itemName: "Fibre Tester",
      baseUnit: "Each",
      quantity: 2,
      hireStartDate: new Date("2026-09-01T00:00:00Z"),
      hireEndDate: new Date("2026-10-01T00:00:00Z"),
      notifyDaysBefore: 3,
      deliveryAddress: "Unit 4",
      unitPricePence: 15000,
      vatRate: 20,
      lineTotalPence: 30000,
      notes: null,
      sortOrder: 0,
    };
    mockFindById.mockResolvedValue(prfRow({ status: "converted", items: [], rentalItems: [rentalRow] }));
    mockCreateWithCode.mockResolvedValue(prfRow({ status: "draft", items: [], rentalItems: [rentalRow] }));
    (rentalItemService.requireActiveRentalItems as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await duplicatePurchaseRequest(PRF_ID);

    expect(mockCreateWithCode.mock.calls[0]![2]).toEqual([
      expect.objectContaining({ rentalItemId: "e".repeat(24), quantity: 2, lineTotalPence: 30000, deliveryAddress: "Unit 4" }),
    ]);
  });
});


// ── The rental master holds no pricing ────────────────────────────────────────────────────────
//
// Price, VAT and currency are negotiated per hire, so they live on the LINE. The master used to
// carry a reference rate and a VAT default; removing them changed exactly one behaviour — a line
// that sends no VAT now falls back to 0 rather than to a catalogue figure — and that is pinned here.
describe("rental lines take their commercial terms from the line, not the catalogue", () => {
  const RENTAL_ID = "e".repeat(24);
  const line = (over: Record<string, unknown> = {}) => ({
    rentalItemId: RENTAL_ID,
    quantity: 2,
    hireStartDate: new Date("2026-09-01T00:00:00Z"),
    hireEndDate: new Date("2026-10-01T00:00:00Z"),
    unitPricePence: 15000,
    ...over,
  });
  const header = () => ({ supplierId: SUP_ID, warehouseId: WH_ID, requiredByDate: FUTURE_REQUIRED_BY.toISOString() });

  beforeEach(() => {
    (rentalItemService.requireActiveRentalItems as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    // Name and unit only — there is no rate or VAT to hand back.
    (rentalItemService.getRentalItemsByIds as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([[RENTAL_ID, { name: "Fibre Tester", baseUnit: "Each" }]]),
    );
    mockCreateWithCode.mockImplementation((header: Record<string, unknown>) =>
      Promise.resolve(prfRow({ ...header, items: [], rentalItems: [] })),
    );
  });

  it("stores the VAT the line sent", async () => {
    await createPurchaseRequest({ ...header(), items: [], rentalItems: [line({ vatRate: 20 })] });
    expect(mockCreateWithCode.mock.calls[0]![2][0]).toMatchObject({ vatRate: 20 });
  });

  it("falls back to zero VAT when the line sends none — no catalogue default exists", async () => {
    await createPurchaseRequest({ ...header(), items: [], rentalItems: [line()] });
    expect(mockCreateWithCode.mock.calls[0]![2][0]).toMatchObject({ vatRate: 0 });
  });

  it("snapshots only the name and unit from the master", async () => {
    await createPurchaseRequest({ ...header(), items: [], rentalItems: [line({ vatRate: 20 })] });
    const stored = mockCreateWithCode.mock.calls[0]![2][0] as Record<string, unknown>;
    expect(stored).toMatchObject({ itemName: "Fibre Tester", baseUnit: "Each", unitPricePence: 15000 });
    // The price is the LINE's, never a catalogue rate.
    expect(stored.lineTotalPence).toBe(30000);
  });

  // The header roll-up is unaffected by the master losing its rate.
  it("totals a rental-only request from its own lines", async () => {
    await createPurchaseRequest({ ...header(), items: [], rentalItems: [line({ vatRate: 20 })] });
    expect(mockCreateWithCode.mock.calls[0]![0]).toMatchObject({
      subtotalPence: 30000,
      vatPence: 6000,
      grandTotalPence: 36000,
    });
  });
});

// A hire's start date is the first day it is BILLED, so kit that arrives later is charged for days
// it was never on site — and the app's own "awaiting delivery, hire has already started" alert
// fires on the day the order is raised. Reported, never blocked: some hire companies bill from the
// day the kit leaves their yard, and there a later delivery is legitimate.
describe("purchase request — late hire delivery flag", () => {
  const hireLine = (start: string) => ({
    id: "rl1",
    rentalItemId: "e".repeat(24),
    itemName: "Fibre Tester",
    baseUnit: "Each",
    quantity: 1,
    hireStartDate: new Date(`${start}T00:00:00.000Z`),
    hireEndDate: new Date("2026-09-30T00:00:00.000Z"),
    hireDays: 1,
    notifyDaysBefore: 3,
    deliveryAddress: null,
    returnMode: "delivery",
    returnAddress: null,
    ratePeriod: "total",
    ratePence: null,
    priceOverridden: false,
    unitPricePence: 15000,
    vatRate: 20,
    lineTotalPence: 15000,
    notes: null,
    rentalItem: null,
  });

  beforeEach(() => vi.clearAllMocks());

  it("flags a required-by date that falls after the hire has started", async () => {
    mockFindById.mockResolvedValue(
      prfRow({ requiredByDate: new Date("2026-09-02T00:00:00.000Z"), rentalItems: [hireLine("2026-09-01")] }),
    );
    const prf = await getPurchaseRequest(PRF_ID);
    expect(prf.lateHireDelivery).toEqual({ earliestHireStart: "2026-09-01T00:00:00.000Z", daysLate: 1 });
  });

  it("is null when the kit is due on the day the hire starts", async () => {
    mockFindById.mockResolvedValue(
      prfRow({ requiredByDate: new Date("2026-09-01T00:00:00.000Z"), rentalItems: [hireLine("2026-09-01")] }),
    );
    expect((await getPurchaseRequest(PRF_ID)).lateHireDelivery).toBeNull();
  });

  it("is null on a request with no hire lines", async () => {
    mockFindById.mockResolvedValue(prfRow({ rentalItems: [] }));
    expect((await getPurchaseRequest(PRF_ID)).lateHireDelivery).toBeNull();
  });
});
