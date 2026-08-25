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
  // Supplier procurement summary.
  statusCountsForSupplier: vi.fn(),
  spendPenceForSupplier: vi.fn(),
}));
vi.mock("#modules/supplier/supplier.service.js", () => ({ requireActiveSupplier: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.service.js", () => ({ requireActiveWarehouse: vi.fn() }));
vi.mock("#modules/irm/irm.service.js", () => ({ requireActiveIrmItem: vi.fn(), requireActiveIrmItems: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));
vi.mock("#modules/attachment/attachment.service.js", () => ({ releaseAsset: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadFileToCloudinary: vi.fn() }));
// Realtime is fire-and-forget; mock it so we can assert every transition fans a refetch signal out
// to the procurement watchers (a stale detail page is what let a user re-send an already-sent PO).
vi.mock("../../lib/realtime.js", () => ({
  emitAttentionChanged: vi.fn(),
  emitToRoom: vi.fn(),
  emitToUser: vi.fn(),
  PURCHASE_ORDER_WATCHERS_ROOM: "purchase_orders:watchers",
  RENTAL_WATCHERS_ROOM: "rentals:watchers",
}));
// PRF fast-path + PM routing collaborators.
vi.mock("#modules/purchase-request/purchase-request.repository.js", () => ({ findById: vi.fn(), countBySupplier: vi.fn(), revertConversion: vi.fn() }));
vi.mock("#modules/job/job.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/user/user.repository.js", () => ({ findActiveWithRole: vi.fn() }));
vi.mock("#modules/document/document.service.js", () => ({ generatePurchaseOrderPdf: vi.fn() }));
// The supplier email is fire-and-forget; mock it so the transition tests stay pure and we can
// assert it's triggered + that a failure can't roll back the PO.
vi.mock("./purchase-order.email.js", () => ({
  notifySupplierPoSent: vi.fn(() => Promise.resolve()),
  notifySupplierPoCancelled: vi.fn(() => Promise.resolve()),
  notifyApproversPoSubmitted: vi.fn(() => Promise.resolve()),
  notifyPmAssigned: vi.fn(() => Promise.resolve()),
}));

import * as poRepo from "./purchase-order.repository.js";
import * as prfRepo from "#modules/purchase-request/purchase-request.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as documentService from "#modules/document/document.service.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as audit from "#modules/audit/audit.service.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { uploadFileToCloudinary } from "../../lib/cloudinary.js";
import { PO_ATTACHMENT_MAX_COUNT, PO_ATTACHMENT_MAX_TOTAL_BYTES } from "./purchase-order.validation.js";
import { PRF_ATTACHMENT_MAX_COUNT, PRF_ATTACHMENT_MAX_TOTAL_BYTES } from "#modules/purchase-request/purchase-request.validation.js";
import * as attachmentService from "#modules/attachment/attachment.service.js";
import { emitAttentionChanged, emitToRoom, PURCHASE_ORDER_WATCHERS_ROOM } from "../../lib/realtime.js";
import {
  ISSUED_PO_ATTACHMENT_LABEL,
  attachUploadedAsset,
  applyGoodsReceipt,
  recordReceiptStatusChange,
  approvePurchaseOrder,
  assignPmPurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  commerciallyMatchesPrf,
  createPurchaseOrder,
  createPurchaseOrdersBySplit,
  deletePurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  recordSupplierAcceptance,
  rejectPurchaseOrder,
  removeAttachment,
  requireReceivablePurchaseOrder,
  sendPurchaseOrder,
  submitPurchaseOrder,
  updateConfirmedDeliveryDate,
  updatePurchaseOrder,
} from "./purchase-order.service.js";
import * as poEmail from "./purchase-order.email.js";

const PO_ID = "f".repeat(24);
const SUP_ID = "a".repeat(24);
const WH_ID = "b".repeat(24);
const WH_ID_2 = "e".repeat(24);
const IRM_ID = "c".repeat(24);
const IRM_ID_2 = "d".repeat(24);
const PRF_ID = "9".repeat(24);
const PM_ID = "8".repeat(24);

// Flush the fire-and-forget promise chains (all mocks resolve in microtasks).
const flushAsync = () => new Promise((r) => setImmediate(r));

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
    // Present and empty by default: the repository's include always supplies the array, so a
    // fixture omitting it would be testing a shape production never produces.
    rentalItems: [],
    attachments: [],
    // Procurement chain + PM routing + supplier acceptance (all null/empty by default).
    purchaseRequestId: null,
    purchaseRequest: null,
    jobId: null,
    job: null,
    projectRef: null,
    goodsReceipts: [],
    pmUserId: null,
    pmName: null,
    pmEmail: null,
    pmAssignedAt: null,
    pmAssignedBy: null,
    supplierAcceptedAt: null,
    supplierAcceptedBy: null,
    supplierAckReference: null,
    confirmedDeliveryDate: null,
    supplierAcceptNotes: null,
    createdBy: null,
    submittedBy: null,
    submittedAt: null,
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    sentBy: null,
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
const mockReqIrms = irmService.requireActiveIrmItems as ReturnType<typeof vi.fn>;
const irmRow = (id: string) => ({ id, name: "CAT6", sku: "C6", baseUnit: "Each", vatRatePercent: 20 });
const mockAudit = audit.record as ReturnType<typeof vi.fn>;
const auditActions = () => mockAudit.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) => Promise.resolve(poRow(data)));
  mockReqSupplier.mockResolvedValue({ name: "Acme" });
  mockReqWarehouse.mockResolvedValue({ id: WH_ID });
  mockReqIrm.mockImplementation((id: string) => Promise.resolve(irmRow(id)));
  mockReqIrms.mockImplementation((ids: string[]) => Promise.resolve(new Map(ids.map((id) => [id, irmRow(id)]))));
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
    const r = await approvePurchaseOrder(PO_ID);
    expect(r.purchaseOrder.status).toBe("approved");
    expect(r.divertedToReview).toBe(false);
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

// A PO is handled by several people in sequence (raiser → finance approver → PM → warehouse), so a
// detail page left open on one desk goes stale the moment someone else acts. That is exactly how a
// user came to click "Send to supplier" on an order the assigned PM had ALREADY sent from their own
// session. Every transition must therefore fan a refetch signal out to the watchers room.
// A PO with no expected delivery date must never leave draft. Editing is draft-only and the state
// machine has no reverse edge back to draft, so an order that escapes draft dateless can neither be
// sent NOR fixed — only cancelled. These guards keep it in draft, where Edit is still available.
describe("expected delivery date is required to leave draft", () => {
  const dateless = (over: Record<string, unknown> = {}) =>
    poRow({ expectedDeliveryDate: null, items: [{ id: "l1", quantity: 1, receivedQuantity: 0 }], ...over });

  it("submit: blocks a dateless draft", async () => {
    mockFindById.mockResolvedValue(dateless({ status: "draft" }));
    await expect(submitPurchaseOrder(PO_ID)).rejects.toThrow(/expected delivery date/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("approve: blocks a dateless PRF-born draft on the fast path", async () => {
    mockFindById.mockResolvedValue(dateless({ status: "draft", purchaseRequestId: PRF_ID }));
    await expect(approvePurchaseOrder(PO_ID)).rejects.toThrow(/expected delivery date/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("approve: blocks a dateless order in the normal review queue too", async () => {
    mockFindById.mockResolvedValue(dateless({ status: "pending_approval" }));
    await expect(approvePurchaseOrder(PO_ID)).rejects.toThrow(/expected delivery date/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // Backstop: the approve/submit gates should mean this is unreachable, but the date is printed on
  // the issued document and the warehouse schedules against it — so send re-checks regardless.
  it("send: blocks a dateless order that somehow reached approved", async () => {
    mockFindById.mockResolvedValue(dateless({ status: "approved" }));
    await expect(sendPurchaseOrder(PO_ID)).rejects.toThrow(/expected delivery date/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("lets a dated order through every one of those gates", async () => {
    // Same fixtures, date present — proves the guards are the only thing being tested above.
    mockFindById.mockResolvedValue(poRow({ status: "draft", items: [{ id: "l1", quantity: 1, receivedQuantity: 0 }] }));
    expect((await submitPurchaseOrder(PO_ID)).status).toBe("pending_approval");
    mockFindById.mockResolvedValue(poRow({ status: "pending_approval" }));
    expect((await approvePurchaseOrder(PO_ID)).purchaseOrder.status).toBe("approved");
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    expect((await sendPurchaseOrder(PO_ID)).status).toBe("sent");
  });
});

describe("realtime: transitions notify procurement watchers", () => {
  const mockEmitRoom = emitToRoom as ReturnType<typeof vi.fn>;
  // The payloads sent to the PO watchers room, in order.
  const poEmits = () =>
    mockEmitRoom.mock.calls
      .filter((c) => c[0] === PURCHASE_ORDER_WATCHERS_ROOM && c[1] === "purchase_order:updated")
      .map((c) => c[2] as { id: string; code: string; status: string });

  it("send: notifies watchers with the NEW status", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    await sendPurchaseOrder(PO_ID);
    expect(poEmits()).toEqual([{ id: PO_ID, code: "PO-0001", status: "sent" }]);
  });

  it("notifies on every other status transition", async () => {
    // submit refuses an empty order, so that row needs a line; the rest transition on status alone.
    const aLine = [{ id: "l1", irmItemId: IRM_ID, quantity: 1, unitPricePence: 100, vatRatePercent: 20 }];
    const cases: [string, () => Promise<unknown>, string, Record<string, unknown>?][] = [
      ["draft", () => submitPurchaseOrder(PO_ID), "pending_approval", { items: aLine }],
      ["pending_approval", () => approvePurchaseOrder(PO_ID), "approved"],
      ["pending_approval", () => rejectPurchaseOrder(PO_ID, "Wrong supplier"), "draft"],
      ["sent", () => recordSupplierAcceptance(PO_ID, { confirmedDeliveryDate: "2026-07-25" }), "supplier_accepted"],
      ["sent", () => cancelPurchaseOrder(PO_ID, "No longer needed"), "cancelled"],
      ["fully_received", () => closePurchaseOrder(PO_ID), "closed"],
    ];
    for (const [from, act, to, extra] of cases) {
      vi.clearAllMocks();
      mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) => Promise.resolve(poRow(data)));
      mockFindById.mockResolvedValue(poRow({ status: from, ...extra }));
      await act();
      expect(poEmits(), `${from} → ${to}`).toEqual([{ id: PO_ID, code: "PO-0001", status: to }]);
    }
  });

  it("does NOT notify when the transition is REJECTED (nothing changed)", async () => {
    // A guard throwing must not tell watchers to refetch — there is nothing new to see, and the
    // stale-state 409 is precisely the case where a spurious signal would be most confusing.
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    await expect(sendPurchaseOrder(PO_ID)).rejects.toThrow(/can't move/i);
    expect(poEmits()).toEqual([]);
  });

  it("does NOT notify on a pure READ", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    await requireReceivablePurchaseOrder(PO_ID);
    expect(poEmits()).toEqual([]);
  });

  it("notifies on DELETE so a watcher's list drops the row", async () => {
    // Without this a watcher keeps seeing a row that no longer exists; acting on it 404s.
    mockFindById.mockResolvedValue(poRow({ status: "draft" }));
    await deletePurchaseOrder(PO_ID);
    expect(poEmits()).toEqual([{ id: PO_ID, code: "PO-0001", status: "deleted" }]);
  });

  it("does NOT notify when a delete is REFUSED", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    await expect(deletePurchaseOrder(PO_ID)).rejects.toThrow(/only draft/i);
    expect(poEmits()).toEqual([]);
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

// Deleting a draft PO that came from a request used to strand that request: `converted` is terminal
// (ALLOWED_TRANSITIONS.converted is empty), so it had no PO, no Generate PO and no Reopen — and it
// still rendered a "View PO-…" button pointing at the deleted order.
describe("deleting a converted-from PO gives the request back", () => {
  const PRF_ID = "f".repeat(24);
  const mockRevert = prfRepo.revertConversion as ReturnType<typeof vi.fn>;
  const fromPrf = (over: Record<string, unknown> = {}) =>
    poRow({ status: "draft", purchaseRequestId: PRF_ID, purchaseRequest: { id: PRF_ID, code: "PRF-0046", status: "converted" }, ...over });

  it("returns the request to approved, naming the deleted order in the audit trail", async () => {
    mockFindById.mockResolvedValue(fromPrf());
    mockRevert.mockResolvedValue(true);

    await deletePurchaseOrder(PO_ID, { email: "buyer@example.com" });

    expect(mockRevert).toHaveBeenCalledWith(PRF_ID, "buyer@example.com");
    expect(auditActions()).toEqual(["purchase_order.deleted", "purchase_request.conversion_reverted"]);
    const reverted = mockAudit.mock.calls.map((c) => c[0]).find((e) => e.action === "purchase_request.conversion_reverted");
    expect(reverted).toMatchObject({ targetType: "purchase_request", targetId: PRF_ID, targetLabel: "PRF-0046" });
    // The PO code has to be IN the entry: read a month later, "returned to approved" with no cause
    // is not an explanation.
    expect(reverted?.metadata).toMatchObject({ purchaseOrderCode: "PO-0001" });
  });

  it("re-counts the request under 'Approved — generate PO'", async () => {
    // The badge counts approved requests; without this the number stays one short until a refresh.
    mockFindById.mockResolvedValue(fromPrf());
    mockRevert.mockResolvedValue(true);
    await deletePurchaseOrder(PO_ID);
    expect(emitAttentionChanged).toHaveBeenCalledWith("purchase_requests");
  });

  it("does NOT claim the move when the conditional update matched nothing", async () => {
    // Two deletes racing, or a request already moved on: only the caller whose update matched may
    // write the audit entry, or the trail shows the same move twice.
    mockFindById.mockResolvedValue(fromPrf());
    mockRevert.mockResolvedValue(false);
    await deletePurchaseOrder(PO_ID);
    expect(auditActions()).toEqual(["purchase_order.deleted"]);
    // The PO area still refreshes (every delete moves a PO queue) — the REQUEST area must not.
    expect(emitAttentionChanged).not.toHaveBeenCalledWith("purchase_requests");
  });

  it("leaves a standalone PO alone — there is no request to give back", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "draft" }));
    await deletePurchaseOrder(PO_ID);
    expect(mockRevert).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["purchase_order.deleted"]);
  });

  it("never rewinds a request whose order was already sent", async () => {
    // Belt and braces on the draft-only guard: the refusal must happen BEFORE anything is written.
    mockFindById.mockResolvedValue(fromPrf({ status: "sent" }));
    await expect(deletePurchaseOrder(PO_ID)).rejects.toThrow(/only draft/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
    expect(mockRevert).not.toHaveBeenCalled();
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
    const change = await applyGoodsReceipt(tx, PO_ID, [{ purchaseOrderItemId: LINE_ID, receivedDelta: 5 }]);
    expect(mockIncrement).toHaveBeenCalledWith(tx, LINE_ID, 5);
    expect(mockSetStatus).toHaveBeenCalledWith(tx, PO_ID, "partially_received");
    // REPORTED, not recorded here. `audit.record` commits on its own, so writing the entry inside this
    // transaction left the trail asserting a status the rollback then undid. The caller records it
    // once the transaction has actually landed.
    expect(change).toEqual({ code: "PO-0001", status: "partially_received" });
    expect(auditActions()).not.toContain("purchase_order.partially_received");
  });

  // The other half of the seam: the entry the transaction reported still has to reach the trail — it
  // just does so once the transaction has committed, which is the caller's job.
  it("records the reported change through the after-commit seam", () => {
    recordReceiptStatusChange(PO_ID, { code: "PO-0001", status: "fully_received" });
    expect(auditActions()).toContain("purchase_order.fully_received");
  });

  it("records nothing when the receipt moved no status", () => {
    recordReceiptStatusChange(PO_ID, null);
    expect(auditActions()).toEqual([]);
  });

  it("partially_received → fully_received: applies the remainder", async () => {
    mockHeader.mockResolvedValue({ id: PO_ID, code: "PO-0001", status: "partially_received" });
    mockLineTotals
      .mockResolvedValueOnce([{ id: LINE_ID, quantity: 10, receivedQuantity: 5 }]) // before
      .mockResolvedValueOnce([{ id: LINE_ID, quantity: 10, receivedQuantity: 10 }]); // after
    const change = await applyGoodsReceipt(tx, PO_ID, [{ purchaseOrderItemId: LINE_ID, receivedDelta: 5 }]);
    expect(mockSetStatus).toHaveBeenCalledWith(tx, PO_ID, "fully_received");
    expect(change).toEqual({ code: "PO-0001", status: "fully_received" });
    expect(auditActions()).not.toContain("purchase_order.fully_received");
  });
});

describe("attachments — terminal-state guard", () => {
  const mockAddAtt = poRepo.addAttachment as ReturnType<typeof vi.fn>;
  const mockFindAtt = poRepo.findAttachment as ReturnType<typeof vi.fn>;
  const mockRemoveAtt = poRepo.removeAttachment as ReturnType<typeof vi.fn>;
  // AN ASSET THAT IS ALREADY IN CLOUDINARY — which is what the live path hands over. The signed
  // upload puts the bytes there under a signature and calls this with the URL and identity it got
  // back; there is no data URI anywhere in it any more.
  const att = {
    label: "Quote",
    fileName: "q.pdf",
    fileType: "pdf",
    fileSizeBytes: 1000,
    url: "https://cdn/q.pdf",
    publicId: "senthra/purchase-orders/uuid.pdf",
    resourceType: "raw",
  } as Parameters<typeof attachUploadedAsset>[1];

  it("adds an attachment on a SENT (non-terminal) PO", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    await attachUploadedAsset(PO_ID, att, { type: "admin", email: "x@x.com" });
    expect(mockAddAtt).toHaveBeenCalledTimes(1);
    // The identity, not just the URL. A row that stores only a URL names a file nothing can ever
    // delete — the state every attachment table in this app was in before.
    expect(mockAddAtt.mock.calls[0][0]).toMatchObject({
      url: "https://cdn/q.pdf",
      publicId: "senthra/purchase-orders/uuid.pdf",
      resourceType: "raw",
    });
    expect(auditActions()).toContain("purchase_order.attachment_added");
  });

  it("blocks adding an attachment on a CLOSED PO", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "closed" }));
    await expect(attachUploadedAsset(PO_ID, att)).rejects.toThrow(/closed or cancelled/i);
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

// ── PRF fast-path: draft → approved without a second finance review, ONLY while the PO still
// commercially matches the approved purchase request it was generated from. ──────────────────
describe("commerciallyMatchesPrf (pure)", () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    supplierId: SUP_ID,
    warehouseId: WH_ID,
    currency: "GBP",
    items: [
      { irmItemId: IRM_ID, quantity: 10, unitPricePence: 500, vatRate: 20 },
      { irmItemId: IRM_ID_2, quantity: 2, unitPricePence: 1000, vatRate: 20 },
    ],
    ...over,
  });

  it("matches an identical document (line order irrelevant)", () => {
    const reversed = doc({ items: [...doc().items].reverse() });
    expect(commerciallyMatchesPrf(doc(), reversed)).toBe(true);
  });

  it.each([
    ["price change", { items: [{ irmItemId: IRM_ID, quantity: 10, unitPricePence: 501, vatRate: 20 }, { irmItemId: IRM_ID_2, quantity: 2, unitPricePence: 1000, vatRate: 20 }] }],
    ["quantity change", { items: [{ irmItemId: IRM_ID, quantity: 11, unitPricePence: 500, vatRate: 20 }, { irmItemId: IRM_ID_2, quantity: 2, unitPricePence: 1000, vatRate: 20 }] }],
    ["VAT change", { items: [{ irmItemId: IRM_ID, quantity: 10, unitPricePence: 500, vatRate: 0 }, { irmItemId: IRM_ID_2, quantity: 2, unitPricePence: 1000, vatRate: 20 }] }],
    ["line removed", { items: [{ irmItemId: IRM_ID, quantity: 10, unitPricePence: 500, vatRate: 20 }] }],
    ["line swapped for another item", { items: [{ irmItemId: IRM_ID, quantity: 10, unitPricePence: 500, vatRate: 20 }, { irmItemId: PRF_ID, quantity: 2, unitPricePence: 1000, vatRate: 20 }] }],
    ["supplier change", { supplierId: PRF_ID }],
    ["warehouse change", { warehouseId: WH_ID_2 }],
    ["currency change", { currency: "EUR" }],
  ])("refuses on %s", (_label, over) => {
    expect(commerciallyMatchesPrf(doc(over as Record<string, unknown>) as Parameters<typeof commerciallyMatchesPrf>[0], doc())).toBe(false);
  });
});

describe("approvePurchaseOrder — PRF fast-path (draft → approved)", () => {
  const mockPrfFind = prfRepo.findById as ReturnType<typeof vi.fn>;
  const matchingPrf = () => ({
    id: PRF_ID,
    code: "PRF-0001",
    supplierId: SUP_ID,
    warehouseId: WH_ID,
    currency: "GBP",
    items: [{ irmItemId: IRM_ID, quantity: 10, unitPricePence: 500, vatRate: 20 }],
  });
  const prfBornDraft = (over: Record<string, unknown> = {}) =>
    poRow({
      status: "draft",
      purchaseRequestId: PRF_ID,
      items: [{ id: "l1", irmItemId: IRM_ID, itemName: "CAT6", sku: null, baseUnit: null, quantity: 10, unitPricePence: 500, vatRate: 20, lineTotalPence: 5000, receivedQuantity: 0, notes: null, irmItem: null }],
      ...over,
    });

  it("approves a PRF-born draft directly when it still matches the PRF (audited as fastPath)", async () => {
    mockFindById.mockResolvedValue(prfBornDraft());
    mockPrfFind.mockResolvedValue(matchingPrf());
    const r = await approvePurchaseOrder(PO_ID);
    expect(r.purchaseOrder.status).toBe("approved");
    expect(r.divertedToReview).toBe(false);
    const call = mockAudit.mock.calls.find((c) => c[0].action === "purchase_order.approved");
    expect(call?.[0].metadata).toMatchObject({ fastPath: true });
  });

  // A diverged PRF-born draft must NOT dead-end: instead of throwing, it's routed into the normal
  // review queue (pending_approval) so there's always a forward path.
  it("diverts a commercially-diverged PRF-born draft to review instead of dead-ending", async () => {
    mockFindById.mockResolvedValue(prfBornDraft());
    mockPrfFind.mockResolvedValue({ ...matchingPrf(), items: [{ irmItemId: IRM_ID, quantity: 10, unitPricePence: 400, vatRate: 20 }] });
    const r = await approvePurchaseOrder(PO_ID);
    expect(r.divertedToReview).toBe(true);
    expect(r.purchaseOrder.status).toBe("pending_approval");
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({ status: "pending_approval" });
    expect(auditActions()).toContain("purchase_order.submitted");
    expect(auditActions()).not.toContain("purchase_order.approved");
  });

  it("refuses the fast path when the source PRF no longer exists", async () => {
    mockFindById.mockResolvedValue(prfBornDraft());
    mockPrfFind.mockResolvedValue(null);
    await expect(approvePurchaseOrder(PO_ID)).rejects.toThrow(/no longer exists/i);
  });

  it("a plain draft (no PRF) still can't skip pending_approval", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "draft" }));
    await expect(approvePurchaseOrder(PO_ID)).rejects.toThrow(/can't move/i);
  });

  // REGRESSION: both fast-path arms return EARLY, so they were originally missed when realtime was
  // added — only the generic `pending_approval → approved` arm emitted. Since every PRF-born PO
  // takes this path, the single most-watched approval in the system silently failed to broadcast.
  it("BOTH fast-path arms notify watchers (regression: early returns skipped the emit)", async () => {
    const mockEmitRoom = emitToRoom as ReturnType<typeof vi.fn>;
    const poEmits = () =>
      mockEmitRoom.mock.calls
        .filter((c) => c[0] === PURCHASE_ORDER_WATCHERS_ROOM && c[1] === "purchase_order:updated")
        .map((c) => (c[2] as { status: string }).status);

    // Arm 1 — still matches the PRF → approved outright.
    mockFindById.mockResolvedValue(prfBornDraft());
    mockPrfFind.mockResolvedValue(matchingPrf());
    await approvePurchaseOrder(PO_ID);
    expect(poEmits(), "fast-path approve").toEqual(["approved"]);

    // Arm 2 — diverged from the PRF → routed into the review queue.
    vi.clearAllMocks();
    mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) => Promise.resolve(poRow(data)));
    mockFindById.mockResolvedValue(prfBornDraft());
    mockPrfFind.mockResolvedValue({ ...matchingPrf(), items: [{ irmItemId: IRM_ID, quantity: 10, unitPricePence: 400, vatRate: 20 }] });
    await approvePurchaseOrder(PO_ID);
    expect(poEmits(), "diverted to review").toEqual(["pending_approval"]);
  });
});

// ── PM routing: approved → pm_review → sent, with the assigned-PM send guard. ────────────────
describe("PM routing (approved → pm_review → sent)", () => {
  const mockUsers = userRepo.findActiveWithRole as ReturnType<typeof vi.fn>;
  const mockNotifyPm = poEmail.notifyPmAssigned as ReturnType<typeof vi.fn>;
  const pmUser = (permissions: string[] = ["purchase_orders.send"]) => ({
    id: PM_ID,
    firstName: "Priya",
    lastName: "M",
    email: "pm@x.co",
    role: { permissions },
  });

  it("routes an approved PO to a qualified PM (snapshots + notification + audit)", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    mockUsers.mockResolvedValue([pmUser()]);
    const r = await assignPmPurchaseOrder(PO_ID, PM_ID, { type: "user", id: "u1", email: "fin@x.co", permissions: [] });
    expect(r.status).toBe("pm_review");
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({ pmUserId: PM_ID, pmName: "Priya M", pmEmail: "pm@x.co" });
    expect(auditActions()).toContain("purchase_order.pm_assigned");
    expect(mockNotifyPm).toHaveBeenCalledTimes(1);
  });

  it("rejects a PM whose role can't send purchase orders", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    mockUsers.mockResolvedValue([pmUser(["jobs.view"])]);
    await expect(assignPmPurchaseOrder(PO_ID, PM_ID)).rejects.toThrow(/send permission/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("re-assigns while in pm_review (audited as pm_reassigned, still pm_review)", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "pm_review", pmUserId: "7".repeat(24), pmEmail: "old@x.co" }));
    mockUsers.mockResolvedValue([pmUser()]);
    const r = await assignPmPurchaseOrder(PO_ID, PM_ID);
    expect(r.status).toBe("pm_review");
    expect(auditActions()).toContain("purchase_order.pm_reassigned");
  });

  it("can't route a draft or sent PO to a PM", async () => {
    mockUsers.mockResolvedValue([pmUser()]);
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    await expect(assignPmPurchaseOrder(PO_ID, PM_ID)).rejects.toThrow(/can't move/i);
  });

  it("in pm_review, the ASSIGNED PM can send", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "pm_review", pmUserId: PM_ID, pmName: "Priya M" }));
    const r = await sendPurchaseOrder(PO_ID, { type: "user", id: PM_ID, email: "pm@x.co", permissions: ["purchase_orders.send"] });
    expect(r.status).toBe("sent");
  });

  it("in pm_review, ANOTHER user without the override is refused (403)", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "pm_review", pmUserId: PM_ID, pmName: "Priya M" }));
    await expect(
      sendPurchaseOrder(PO_ID, { type: "user", id: "7".repeat(24), email: "other@x.co", permissions: ["purchase_orders.send"] }),
    ).rejects.toThrow(/assigned project manager/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("in pm_review, an assign_pm holder may send on the PM's behalf (override)", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "pm_review", pmUserId: PM_ID }));
    const r = await sendPurchaseOrder(PO_ID, {
      type: "user",
      id: "7".repeat(24),
      email: "fin@x.co",
      permissions: ["purchase_orders.send", "purchase_orders.assign_pm"],
    });
    expect(r.status).toBe("sent");
  });

  it("the direct approved → sent path still works (non-PM orders)", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    expect((await sendPurchaseOrder(PO_ID)).status).toBe("sent");
  });
});

// ── Supplier acceptance + delivery-date revisions (audit ledger IS the history). ─────────────
// Acceptance is a recorded EVENT, not a workflow gate: receiving is never blocked on it, so goods
// routinely arrive first. The acknowledgement must still be capturable afterwards — WITHOUT
// rewinding the order's status, which would rewrite history.
describe("supplier acceptance (a recorded event, not a gate)", () => {
  const acceptedMeta = () => mockAudit.mock.calls.find((c) => c[0].action === "purchase_order.supplier_accepted")?.[0].metadata;

  it("records acceptance with reference + confirmed date, advancing sent → supplier_accepted", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    const r = await recordSupplierAcceptance(
      PO_ID,
      { confirmedDeliveryDate: "2026-07-20", supplierAckReference: "ACK-77", notes: "Friday slot" },
      { type: "user", id: "u1", email: "pm@x.co", permissions: [] },
    );
    expect(r.status).toBe("supplier_accepted");
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({ supplierAckReference: "ACK-77", supplierAcceptedBy: "pm@x.co" });
    expect(auditActions()).toContain("purchase_order.supplier_accepted");
    expect(acceptedMeta()).toMatchObject({ statusAtAcceptance: "sent", statusChanged: true });
  });

  // The whole point of the decoupling: a supplier acknowledging after the truck arrived must not
  // lose their ack reference just because the goods beat the paperwork.
  it.each(["partially_received", "fully_received"])(
    "records a LATE acknowledgement on a %s order without changing its status",
    async (status) => {
      mockFindById.mockResolvedValue(poRow({ status }));
      await recordSupplierAcceptance(PO_ID, { confirmedDeliveryDate: "2026-07-20", supplierAckReference: "ACK-99" });
      // The patch carries NO status key — the receipt state stays the source of truth. (Asserting
      // the patch, not the returned row: the repo stub rebuilds the row from the patch alone.)
      expect(mockUpdate.mock.calls[0][1]).not.toHaveProperty("status");
      // …but the acknowledgement IS captured.
      expect(mockUpdate.mock.calls[0][1]).toMatchObject({ supplierAckReference: "ACK-99" });
      expect(acceptedMeta()).toMatchObject({ statusAtAcceptance: status, statusChanged: false });
    },
  );

  it("re-recording on an accepted order corrects the details without moving it", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "supplier_accepted", supplierAckReference: "TYPO-1" }));
    await recordSupplierAcceptance(PO_ID, { confirmedDeliveryDate: "2026-07-20", supplierAckReference: "ACK-1023" });
    expect(mockUpdate.mock.calls[0][1]).not.toHaveProperty("status");
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({ supplierAckReference: "ACK-1023" });
  });

  it.each(["draft", "approved", "closed", "cancelled"])("refuses to record acceptance on a %s order", async (status) => {
    mockFindById.mockResolvedValue(poRow({ status }));
    await expect(recordSupplierAcceptance(PO_ID, { confirmedDeliveryDate: "2026-07-25" })).rejects.toThrow(/can't be recorded/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("delivery-date revision audits {previousDate, newDate, reason}", async () => {
    mockFindById.mockResolvedValue(
      poRow({ status: "supplier_accepted", confirmedDeliveryDate: new Date("2026-07-20T00:00:00Z") }),
    );
    await updateConfirmedDeliveryDate(PO_ID, "2026-07-22", "Supplier slipped two days");
    const call = mockAudit.mock.calls.find((c) => c[0].action === "purchase_order.delivery_date_updated");
    expect(call?.[0].metadata).toMatchObject({
      previousDate: "2026-07-20T00:00:00.000Z",
      reason: "Supplier slipped two days",
    });
    expect(String(call?.[0].metadata.newDate)).toContain("2026-07-22");
  });

  // The warehouse plans against this date, so a slip announced mid-delivery must still land.
  it("allows revising the delivery date after goods have started arriving", async () => {
    mockFindById.mockResolvedValue(
      poRow({ status: "partially_received", confirmedDeliveryDate: new Date("2026-07-20T00:00:00Z") }),
    );
    await updateConfirmedDeliveryDate(PO_ID, "2026-07-24", "Rest of the order slipped");
    // Only the date is patched — the status is never touched by this endpoint.
    expect(mockUpdate.mock.calls[0][1]).toEqual({ confirmedDeliveryDate: new Date("2026-07-24") });
    expect(auditActions()).toContain("purchase_order.delivery_date_updated");
  });

  it("blocks revising the delivery date once the order is closed or cancelled", async () => {
    for (const status of ["closed", "cancelled"]) {
      vi.clearAllMocks();
      mockUpdate.mockImplementation((_id, data) => Promise.resolve(poRow(data)));
      mockFindById.mockResolvedValue(poRow({ status, confirmedDeliveryDate: new Date("2026-07-20T00:00:00Z") }));
      await expect(updateConfirmedDeliveryDate(PO_ID, "2026-07-22", undefined)).rejects.toThrow(/can't be changed/i);
    }
  });

  // The same invariant the acceptance schema enforces at capture — otherwise a revision could
  // smuggle in a date the original capture would have rejected, landing as a phantom "overdue".
  it("delivery-date revision can't set a date before the supplier accepted", async () => {
    mockFindById.mockResolvedValue(
      poRow({
        status: "supplier_accepted",
        supplierAcceptedAt: new Date("2026-07-20T09:00:00Z"),
        confirmedDeliveryDate: new Date("2026-07-25T00:00:00Z"),
      }),
    );
    await expect(updateConfirmedDeliveryDate(PO_ID, "2026-07-01", undefined)).rejects.toThrow(/before the date the supplier accepted/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("allows revising to the acceptance day itself (date-only compare, not the instant)", async () => {
    // Accepted mid-morning; a same-day delivery is legitimate and must not be rejected as "before".
    mockFindById.mockResolvedValue(
      poRow({
        status: "supplier_accepted",
        supplierAcceptedAt: new Date("2026-07-20T09:00:00Z"),
        confirmedDeliveryDate: new Date("2026-07-25T00:00:00Z"),
      }),
    );
    await expect(updateConfirmedDeliveryDate(PO_ID, "2026-07-20", undefined)).resolves.toBeTruthy();
  });

  // This endpoint REVISES a promise; recordSupplierAcceptance is the only way to create one.
  it("delivery-date revision is blocked when no date has been confirmed yet", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "sent", confirmedDeliveryDate: null }));
    await expect(updateConfirmedDeliveryDate(PO_ID, "2026-07-22", undefined)).rejects.toThrow(/record the supplier's acceptance/i);
  });

  it("a supplier_accepted order is receivable; an approved one is not", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "supplier_accepted" }));
    await expect(requireReceivablePurchaseOrder(PO_ID)).resolves.toMatchObject({ status: "supplier_accepted" });
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    await expect(requireReceivablePurchaseOrder(PO_ID)).rejects.toThrow(/can't receive stock/i);
  });
});

// ── Explicit cancellation matrix (reason mandatory at the route; matrix enforced here). ──────
describe("cancellation matrix", () => {
  it.each(["draft", "pending_approval", "approved", "pm_review", "sent", "supplier_accepted"])(
    "allows cancelling a %s order",
    async (status) => {
      mockFindById.mockResolvedValue(poRow({ status }));
      expect((await cancelPurchaseOrder(PO_ID, "No longer needed")).status).toBe("cancelled");
    },
  );

  it.each(["partially_received", "fully_received", "closed", "cancelled"])(
    "refuses cancelling a %s order",
    async (status) => {
      mockFindById.mockResolvedValue(poRow({ status }));
      await expect(cancelPurchaseOrder(PO_ID, "reason")).rejects.toThrow(/can't move/i);
      expect(mockUpdate).not.toHaveBeenCalled();
    },
  );
});

// ── Document of record: the issued PDF archived at send, undeletable, never blocking the send. ─
describe("issued-PDF archive (document of record)", () => {
  const mockCreds = getCloudinaryCreds as ReturnType<typeof vi.fn>;
  const mockUpload = uploadFileToCloudinary as ReturnType<typeof vi.fn>;
  const mockPdf = documentService.generatePurchaseOrderPdf as ReturnType<typeof vi.fn>;
  const mockAddAtt = poRepo.addAttachment as ReturnType<typeof vi.fn>;
  const mockFindAtt = poRepo.findAttachment as ReturnType<typeof vi.fn>;
  const mockRemoveAtt = poRepo.removeAttachment as ReturnType<typeof vi.fn>;

  it("send archives the generated PDF as the system attachment", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    mockCreds.mockResolvedValue({ cloudName: "c", apiKey: "k", apiSecret: "s" });
    mockPdf.mockResolvedValue({ filename: "PO-0001.pdf", buffer: Buffer.from("pdf"), mimeType: "application/pdf" });
    mockUpload.mockResolvedValue({ url: "https://cdn/po-0001.pdf", publicId: "senthra/purchase-orders/po1.pdf", resourceType: "raw" });
    await sendPurchaseOrder(PO_ID, { type: "user", id: "u1", email: "pm@x.co", permissions: [] });
    await flushAsync();
    expect(mockAddAtt).toHaveBeenCalledTimes(1);
    expect(mockAddAtt.mock.calls[0][0]).toMatchObject({
      label: ISSUED_PO_ATTACHMENT_LABEL,
      fileType: "pdf",
      uploadedBy: "system",
      // Recorded even though this row can never be removed. The guard in removeAttachment is what
      // protects the document of record — not a missing identity.
      publicId: "senthra/purchase-orders/po1.pdf",
      resourceType: "raw",
    });
  });

  it("an archive failure never rolls back the send", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    mockCreds.mockResolvedValue({ cloudName: "c", apiKey: "k", apiSecret: "s" });
    mockPdf.mockRejectedValue(new Error("pdfkit exploded"));
    expect((await sendPurchaseOrder(PO_ID)).status).toBe("sent");
    await flushAsync();
    expect(mockAddAtt).not.toHaveBeenCalled();
  });

  it("send still works with Cloudinary unconfigured (archive skipped)", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "approved" }));
    mockCreds.mockResolvedValue(null);
    expect((await sendPurchaseOrder(PO_ID)).status).toBe("sent");
    await flushAsync();
    expect(mockAddAtt).not.toHaveBeenCalled();
  });

  it("the archived attachment can't be removed", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    mockFindAtt.mockResolvedValue({ id: "att1", purchaseOrderId: PO_ID, label: ISSUED_PO_ATTACHMENT_LABEL, uploadedBy: "system" });
    await expect(removeAttachment(PO_ID, "att1")).rejects.toThrow(/can't be removed/i);
    expect(mockRemoveAtt).not.toHaveBeenCalled();
  });

  it("a user attachment can't claim the reserved label", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    await expect(
      attachUploadedAsset(PO_ID, {
        label: ISSUED_PO_ATTACHMENT_LABEL,
        fileName: "fake.pdf",
        fileType: "pdf",
        fileSizeBytes: 10,
        url: "https://cdn/fake.pdf",
        publicId: "pfake",
        resourceType: "raw",
      } as Parameters<typeof attachUploadedAsset>[1]),
    ).rejects.toThrow(/reserved label/i);
  });
});

// The PO is the side of the shared-asset problem that can actually bite. A PO converted from a PRF
// holds COPIES of that PRF's attachment identities — same Cloudinary file, two rows — and the PRF,
// now `converted` and read-only, still displays them. So removing the PO's row must not assume it
// owns the file; it hands the identity to releaseAsset, whose reference count decides.
describe("PO attachments — Cloudinary cleanup", () => {
  const mockFindAtt = poRepo.findAttachment as ReturnType<typeof vi.fn>;
  const mockRemoveAtt = poRepo.removeAttachment as ReturnType<typeof vi.fn>;
  const release = attachmentService.releaseAsset as ReturnType<typeof vi.fn>;
  const SHARED = { publicId: "senthra/purchase-orders/quote-abc.pdf", resourceType: "raw" };

  beforeEach(() => {
    mockFindById.mockResolvedValue(poRow({ status: "sent" }));
    mockFindAtt.mockResolvedValue({ id: "att1", purchaseOrderId: PO_ID, label: "Quote", uploadedBy: "u@x.co", ...SHARED });
  });

  it("hands the removed row's identity to the cleanup, both halves", async () => {
    await removeAttachment(PO_ID, "att1");
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toMatchObject(SHARED);
  });

  it("releases only AFTER the DB row is deleted", async () => {
    const order: string[] = [];
    mockRemoveAtt.mockImplementation(() => { order.push("db"); return Promise.resolve({}); });
    release.mockImplementation(() => { order.push("cleanup"); return Promise.resolve(); });
    await removeAttachment(PO_ID, "att1");
    expect(order).toEqual(["db", "cleanup"]);
  });

  // The document of record is immutable — the guard fires before anything is deleted, so no cleanup
  // is even considered. This is the one attachment whose file must outlive every removal attempt.
  it("never touches Cloudinary for the archived issued-PO document", async () => {
    mockFindAtt.mockResolvedValue({ id: "att1", purchaseOrderId: PO_ID, label: ISSUED_PO_ATTACHMENT_LABEL, uploadedBy: "system", ...SHARED });
    await expect(removeAttachment(PO_ID, "att1")).rejects.toThrow(/can't be removed/i);
    expect(mockRemoveAtt).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("never releases when the terminal-state guard rejects the removal", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "closed" }));
    await expect(removeAttachment(PO_ID, "att1")).rejects.toThrow(/closed or cancelled/i);
    expect(release).not.toHaveBeenCalled();
  });

  it("passes a legacy row's null identity straight through — the skip is releaseAsset's call", async () => {
    mockFindAtt.mockResolvedValue({ id: "att1", purchaseOrderId: PO_ID, label: null, uploadedBy: null, publicId: null, resourceType: null });
    await removeAttachment(PO_ID, "att1");
    expect(mockRemoveAtt).toHaveBeenCalled(); // the business operation still succeeds
    expect(release.mock.calls[0][0]).toMatchObject({ publicId: null, resourceType: null });
  });
});

// Twenty, not the PRF's ten: conversion COPIES a full PRF's attachments onto the order, so an equal cap
// would be exhausted the moment the PO existed — no room for the supplier's confirmation or the invoice.
describe("PO attachments — count cap", () => {
  const mockAddAtt2 = poRepo.addAttachment as ReturnType<typeof vi.fn>;
  const att = {
    fileName: "inv.pdf",
    fileType: "pdf",
    fileSizeBytes: 9,
    url: "https://cdn/inv.pdf",
    publicId: "pinv",
    resourceType: "raw",
  } as Parameters<typeof attachUploadedAsset>[1];

  const userAtt = (i: number) => ({ id: `u${i}`, label: null, fileName: `f${i}.pdf`, fileType: "pdf", fileSizeBytes: 10, url: `https://cdn/f${i}.pdf`, publicId: `p${i}`, resourceType: "raw", uploadedBy: "buyer@x.co", createdAt: new Date("2026-07-01T00:00:00Z") });
  const archive = { id: "sys", label: ISSUED_PO_ATTACHMENT_LABEL, fileName: "PO-0001.pdf", fileType: "pdf", fileSizeBytes: 10, url: "https://cdn/po.pdf", publicId: "psys", resourceType: "raw", uploadedBy: "system", createdAt: new Date("2026-07-01T00:00:00Z") };
  const withAtts = (atts: unknown[]) => poRow({ status: "sent", attachments: atts });

  it("accepts the twentieth user document", async () => {
    mockFindById.mockResolvedValue(withAtts(Array.from({ length: 19 }, (_, i) => userAtt(i))));
    await attachUploadedAsset(PO_ID, att, { type: "admin", email: "x@x.com" });
    expect(mockAddAtt2).toHaveBeenCalledTimes(1);
  });

  it("refuses the twenty-first", async () => {
    mockFindById.mockResolvedValue(withAtts(Array.from({ length: 20 }, (_, i) => userAtt(i))));
    await expect(attachUploadedAsset(PO_ID, att)).rejects.toThrow(/at most 20 documents/i);
  });

  // THE point of excluding the archive. A buyer who fills the cap must not be able to consume the slot
  // the system needs for the document of record — its write is fire-and-forget and fails SILENTLY.
  it("does not count the issued-PO archive against the cap", async () => {
    mockFindById.mockResolvedValue(withAtts([archive, ...Array.from({ length: 19 }, (_, i) => userAtt(i))]));
    await attachUploadedAsset(PO_ID, att, { type: "admin", email: "x@x.com" });
    expect(mockAddAtt2).toHaveBeenCalledTimes(1); // 20 rows on the record, 19 of them user documents
  });

  // Refused before anything is written. The bytes are already in Cloudinary by the time this runs —
  // the signed upload put them there — so what this proves now is that a refused attachment leaves no
  // ROW behind it. The orphaned asset itself is the reaper's job (upload.reaper.ts).
  it("writes no row when the cap is full", async () => {
    mockFindById.mockResolvedValue(withAtts(Array.from({ length: 20 }, (_, i) => userAtt(i))));
    await expect(attachUploadedAsset(PO_ID, att)).rejects.toThrow();
    expect(mockAddAtt2).not.toHaveBeenCalled();
  });

  it("refuses a document that would push the order past 80 MB", async () => {
    const big = (i: number) => ({ ...userAtt(i), fileSizeBytes: 15 * 1024 * 1024 });
    mockFindById.mockResolvedValue(withAtts(Array.from({ length: 5 }, (_, i) => big(i))));
    const oneMore = { ...att, fileSizeBytes: 6 * 1024 * 1024 } as Parameters<typeof attachUploadedAsset>[1];
    await expect(attachUploadedAsset(PO_ID, oneMore)).rejects.toThrow(/can't exceed 80 MB/i);
    expect(mockAddAtt2).not.toHaveBeenCalled();
  });

  // The archive is excluded from the BYTE total for the same reason as the count.
  it("does not count the archive's bytes against the total", async () => {
    const bigArchive = { ...archive, fileSizeBytes: 70 * 1024 * 1024 };
    mockFindById.mockResolvedValue(withAtts([bigArchive, userAtt(0)]));
    await attachUploadedAsset(PO_ID, { ...att, fileSizeBytes: 5 * 1024 * 1024 } as Parameters<typeof attachUploadedAsset>[1], { type: "admin", email: "x@x.com" });
    expect(mockAddAtt2).toHaveBeenCalledTimes(1);
  });

  it("keeps the byte ceiling above the PRF's, so a converted order has room", () => {
    expect(PO_ATTACHMENT_MAX_TOTAL_BYTES).toBeGreaterThan(PRF_ATTACHMENT_MAX_TOTAL_BYTES);
  });

  // A PRF is capped at ten, so a full conversion can never exhaust the order's twenty on its own.
  it("leaves headroom above a full PRF's worth of copied documents", () => {
    expect(PO_ATTACHMENT_MAX_COUNT).toBeGreaterThan(PRF_ATTACHMENT_MAX_COUNT);
  });
});

// The header roll-up must survive an edit that does not touch the hires.
//
// Conversion learned to total both kinds of line; a later draft edit recomputed from the IRM lines
// alone and quietly took the hire value back out — a hire-only order dropped to £0 with its rental
// lines still rendering underneath.
describe("updatePurchaseOrder — totals keep the hire value", () => {
  const rentalRow = {
    id: "rl1",
    rentalItemId: "e".repeat(24),
    itemName: "Fibre Tester",
    baseUnit: "Each",
    quantity: 2,
    hireStartDate: new Date("2026-09-01T00:00:00Z"),
    hireEndDate: new Date("2026-10-01T00:00:00Z"),
    notifyDaysBefore: 3,
    notifyOnDate: new Date("2026-09-28T00:00:00Z"),
    deliveryAddress: null,
    unitPricePence: 15000,
    vatRate: 20,
    lineTotalPence: 30000,
    notes: null,
    sortOrder: 0,
    hireStatus: "on_hire",
    returnedAt: null,
    returnedBy: null,
    rentalItem: { id: "e".repeat(24), code: "RNT-0001", name: "Fibre Tester", status: "active" },
  };

  it("counts rental lines when only the IRM lines are replaced", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "draft", items: [], rentalItems: [rentalRow] }));
    (poRepo.replaceItemsAndTotals as ReturnType<typeof vi.fn>).mockResolvedValue(
      poRow({ status: "draft", items: [], rentalItems: [rentalRow] }),
    );

    await updatePurchaseOrder(PO_ID, { items: [] });

    // 2 x 15000 ex-VAT + 20% VAT — the hire, untouched by this edit, still in the header.
    expect((poRepo.replaceItemsAndTotals as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toEqual({
      subtotalPence: 30000,
      vatPence: 6000,
      grandTotalPence: 36000,
    });
  });

  // The schema can no longer refuse an empty items array (a hire-only order legitimately has none),
  // so the "must keep a line" rule lives here, where the rental lines are visible.
  it("refuses an edit that would leave the order with no lines of either kind", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "draft", items: [], rentalItems: [] }));
    await expect(updatePurchaseOrder(PO_ID, { items: [] })).rejects.toThrow(/at least one item or rental line/i);
    expect(poRepo.replaceItemsAndTotals).not.toHaveBeenCalled();
  });
});

// Mirrors the same flag on the purchase request — the order is where the consequence lands, since
// `expectedDeliveryDate` is the date printed on the PDF the supplier reads.
describe("purchase order — late hire delivery flag", () => {
  const hireLine = (start: string) => ({
    id: "rl1",
    rentalItemId: "e".repeat(24),
    itemName: "Fibre Tester",
    baseUnit: "Each",
    quantity: 1,
    hireStartDate: new Date(`${start}T00:00:00.000Z`),
    hireEndDate: new Date("2026-10-01T00:00:00.000Z"),
    notifyDaysBefore: 3,
    notifyOnDate: new Date("2026-09-28T00:00:00.000Z"),
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
    sortOrder: 0,
    hireStatus: "awaiting_delivery",
    returnedAt: null,
    returnedBy: null,
    rentalItem: null,
  });

  beforeEach(() => vi.clearAllMocks());

  it("flags an expected delivery that falls after the hire has started", async () => {
    mockFindById.mockResolvedValue(
      poRow({ expectedDeliveryDate: new Date("2026-09-03T00:00:00.000Z"), rentalItems: [hireLine("2026-09-01")] }),
    );
    const po = await getPurchaseOrder(PO_ID);
    expect(po.lateHireDelivery).toEqual({ earliestHireStart: "2026-09-01T00:00:00.000Z", daysLate: 2 });
  });

  it("is null when the kit is due on the day the hire starts", async () => {
    mockFindById.mockResolvedValue(
      poRow({ expectedDeliveryDate: new Date("2026-09-01T00:00:00.000Z"), rentalItems: [hireLine("2026-09-01")] }),
    );
    expect((await getPurchaseOrder(PO_ID)).lateHireDelivery).toBeNull();
  });

  it("is null on a goods-only order", async () => {
    mockFindById.mockResolvedValue(poRow({ rentalItems: [] }));
    expect((await getPurchaseOrder(PO_ID)).lateHireDelivery).toBeNull();
  });

  // Once the supplier has COMMITTED to a date, that is the date the kit actually turns up — the
  // warehouse worklist already plans against it in preference to the expected date. Measuring the
  // superseded estimate would clear the warning on an order that is still going to be late.
  it("measures the supplier's confirmed date once there is one", async () => {
    mockFindById.mockResolvedValue(
      poRow({
        expectedDeliveryDate: new Date("2026-09-01T00:00:00.000Z"),
        confirmedDeliveryDate: new Date("2026-09-04T00:00:00.000Z"),
        rentalItems: [hireLine("2026-09-01")],
      }),
    );
    const po = await getPurchaseOrder(PO_ID);
    expect(po.lateHireDelivery).toEqual({ earliestHireStart: "2026-09-01T00:00:00.000Z", daysLate: 3 });
  });

  it("clears the warning when the supplier confirms a date that beats the hire start", async () => {
    mockFindById.mockResolvedValue(
      poRow({
        expectedDeliveryDate: new Date("2026-09-04T00:00:00.000Z"),
        confirmedDeliveryDate: new Date("2026-08-31T00:00:00.000Z"),
        rentalItems: [hireLine("2026-09-01")],
      }),
    );
    expect((await getPurchaseOrder(PO_ID)).lateHireDelivery).toBeNull();
  });
});

// ── A cancelled order must not strand the supplier's kit ───────────────────────────────────────
//
// Cancelling is a one-way door with no way back through it: every hire predicate excludes a cancelled
// order (rentalHire.predicate's LIVE_ORDER) and the return path only accepts one in the receiving
// window, so a hire caught by it could never be handed back. Its equipment would sit in the yard on
// no list, no badge and no report.
describe("cancelPurchaseOrder — hired kit still in our hands", () => {
  const held = (over: Record<string, unknown> = {}) => ({
    id: "rl1",
    itemName: "Fibre Tester",
    quantity: 5,
    receivedQuantity: 3,
    returnedQuantity: 0,
    hireStatus: "on_hire",
    ...over,
  });

  it("refuses while units are still held, naming how many", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "sent", rentalItems: [held()] }));
    await expect(cancelPurchaseOrder(PO_ID, "No longer needed")).rejects.toThrow(
      /3 Fibre Tester are still on hire here/i,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // Asked on the QUANTITIES, not the status: a part-delivered line whose delivered units have all
  // gone back is still `on_hire` and holds nothing, so blocking on the status would refuse a
  // cancellation that is perfectly safe.
  it("allows it once everything received has gone back, even while the line reads on_hire", async () => {
    mockFindById.mockResolvedValue(
      poRow({ status: "sent", rentalItems: [held({ receivedQuantity: 3, returnedQuantity: 3 })] }),
    );
    await expect(cancelPurchaseOrder(PO_ID, "No longer needed")).resolves.toMatchObject({ status: "cancelled" });
  });

  // Cancelling the order is the RIGHT way to end a hire that never arrived — those lines leave every
  // queue with it, so there is nothing to strand.
  it("allows it for a hire that never arrived", async () => {
    mockFindById.mockResolvedValue(
      poRow({
        status: "sent",
        rentalItems: [held({ hireStatus: "awaiting_delivery", receivedQuantity: 0, returnedQuantity: 0 })],
      }),
    );
    await expect(cancelPurchaseOrder(PO_ID, "Supplier cannot supply")).resolves.toMatchObject({ status: "cancelled" });
  });

  // The close guard's other half: a hire cancelled in its own right is finished, so it must not hold
  // its order open forever.
  it("closePurchaseOrder accepts a cancelled hire as finished", async () => {
    mockFindById.mockResolvedValue(
      poRow({
        status: "fully_received",
        rentalItems: [held({ hireStatus: "cancelled", receivedQuantity: 0, returnedQuantity: 0 })],
      }),
    );
    await expect(closePurchaseOrder(PO_ID)).resolves.toMatchObject({ status: "closed" });
  });

  it("closePurchaseOrder still refuses a hire that is genuinely still out", async () => {
    mockFindById.mockResolvedValue(poRow({ status: "fully_received", rentalItems: [held()] }));
    await expect(closePurchaseOrder(PO_ID)).rejects.toThrow(/still on hire/i);
  });
});
