import { beforeEach, describe, expect, it, vi } from "vitest";

// Per-line fulfilment sourcing on approve. Requested stock is rarely all in one place — the warehouse
// may hold some items while another engineer's van holds the rest — so each request line names its
// own source and approve fans that out into ONE transfer per source engineer plus the normal
// warehouse-issue path. These tests pin that fan-out, the per-engineer shortage check, and the
// crash-resume behaviour (which must never open a duplicate transfer).
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/job/job.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/job/job.service.js", () => ({ appendKitFromRequest: vi.fn() }));
vi.mock("#modules/engineer-transfer/engineer-transfer.service.js", () => ({
  createJobTransfer: vi.fn(),
  assertTransferEngineers: vi.fn(),
}));
vi.mock("#modules/irm/irm.repository.js", () => ({}));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({ findCustomerHoldingsByEngineer: vi.fn() }));
vi.mock("#modules/goods-management/goods-management.service.js", () => ({}));
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({ findEngineerBalances: vi.fn() }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findAllBalances: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findMany: vi.fn() }));
vi.mock("#modules/engineer-transfer/engineer-transfer.repository.js", () => ({
  findHoldersForIrm: vi.fn(),
  findHoldersForCustomer: vi.fn(),
  findSourcesByIds: vi.fn(),
}));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn() }));
vi.mock("../../lib/realtime.js", () => ({ emitToUser: vi.fn(), emitToRoom: vi.fn(), OFFICE_JOBS_ROOM: "office:jobs" }));
vi.mock("./job-kit-request.repository.js", () => ({
  findById: vi.fn(),
  claimPending: vi.fn(),
  revertToPending: vi.fn(),
  finalizeApproval: vi.fn(),
  stampLineKitIdsTx: vi.fn(),
  appendTransferIdTx: vi.fn(),
  setTransferIdTx: vi.fn(),
}));

import * as jobRepo from "#modules/job/job.repository.js";
import * as jobService from "#modules/job/job.service.js";
import * as transferService from "#modules/engineer-transfer/engineer-transfer.service.js";
import * as transferRepo from "#modules/engineer-transfer/engineer-transfer.repository.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as kitRequestRepo from "./job-kit-request.repository.js";
import { approve } from "./job-kit-request.service.js";

const REQ_ID = "r".repeat(24);
const JOB_ID = "j".repeat(24);
const CUSTOMER_ID = "c".repeat(24);
const TO_ENG = "e1".padEnd(24, "0"); // the job's own engineer (receives)
const SAHUL = "e2".padEnd(24, "0"); // a source engineer
const RAVI = "e3".padEnd(24, "0"); // a second source engineer
const WH = "w1".padEnd(24, "0");
const PANEL = "i1".padEnd(24, "0");
const CABLE = "i2".padEnd(24, "0");

const L_PANEL = "l1".padEnd(24, "0");
const L_CABLE = "l2".padEnd(24, "0");

const mockFindReq = kitRequestRepo.findById as ReturnType<typeof vi.fn>;
const mockClaim = kitRequestRepo.claimPending as ReturnType<typeof vi.fn>;
const mockFinalize = kitRequestRepo.finalizeApproval as ReturnType<typeof vi.fn>;
const mockAppendKit = jobService.appendKitFromRequest as ReturnType<typeof vi.fn>;
const mockCreateTransfer = transferService.createJobTransfer as ReturnType<typeof vi.fn>;
const mockFindJob = jobRepo.findById as ReturnType<typeof vi.fn>;
const mockEngBalances = engineerStockRepo.findEngineerBalances as ReturnType<typeof vi.fn>;
const mockCustHoldings = goodsManagementRepo.findCustomerHoldingsByEngineer as ReturnType<typeof vi.fn>;
const mockTransferSources = transferRepo.findSourcesByIds as ReturnType<typeof vi.fn>;

// Two IRM lines: a patch panel (x1) and cable (x2).
const request = (over: Record<string, unknown> = {}) => ({
  id: REQ_ID,
  code: "JKR-0022",
  status: "pending",
  jobId: JOB_ID,
  jobNumber: "JOB-2026-0024",
  requestedByEngineerId: TO_ENG,
  requestedByEngineerName: "Azar M",
  requestedByEngineerEmail: "azar@x.com",
  reason: "extra kit",
  notes: null,
  attachments: [],
  reviewedByUserId: null,
  reviewedByEmail: null,
  reviewedAt: null,
  decisionNote: null,
  fulfillmentMode: null,
  createdBy: null,
  createdAt: new Date("2026-07-21T00:00:00Z"),
  updatedAt: new Date("2026-07-21T00:00:00Z"),
  transferId: null,
  transferIds: [],
  lines: [
    { id: L_PANEL, source: "irm", irmItemId: PANEL, customerStockEntryId: null, itemName: "Patch Panel", qty: 1, jobKitLineId: null, sourceEngineerId: null },
    { id: L_CABLE, source: "irm", irmItemId: CABLE, customerStockEntryId: null, itemName: "CAT6 Cable", qty: 2, jobKitLineId: null, sourceEngineerId: null },
  ],
  ...over,
});

const actor = { id: "u".repeat(24), email: "pm@x.com" } as never;

describe("approve — per-line fulfilment sourcing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindReq.mockResolvedValue(request());
    mockFindJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0024", assignedEngineerId: TO_ENG, customerId: CUSTOMER_ID, kitLines: [] });
    mockClaim.mockResolvedValue(1);
    mockAppendKit.mockResolvedValue({ jobKitLineIds: ["k1", "k2"] });
    mockCreateTransfer.mockImplementation(async () => ({ id: `t${mockCreateTransfer.mock.calls.length}` }));
    mockFinalize.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...request(), status: "approved", ...patch, lines: request().lines }));
    mockTransferSources.mockResolvedValue([]);
    (kitRequestRepo.revertToPending as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    // A van-sourced IRM line still needs a nominal home warehouse for returns (deriveHomeWarehouse).
    (inventoryRepo.findAllBalances as ReturnType<typeof vi.fn>).mockResolvedValue([{ warehouseId: WH, quantityOnHand: 5 }]);
    // Sahul and Ravi both hold plenty of everything by default.
    mockEngBalances.mockResolvedValue([{ irmItemId: PANEL, quantityOnHand: 50 }, { irmItemId: CABLE, quantityOnHand: 50 }]);
    mockCustHoldings.mockResolvedValue([]);
  });

  it("sources one line from a warehouse and the other from an engineer's van", async () => {
    await approve(
      REQ_ID,
      {
        lineSources: [
          { requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH },
          { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL },
        ],
      } as never,
      actor,
    );

    // ONE transfer, carrying ONLY the van-sourced line.
    expect(mockCreateTransfer).toHaveBeenCalledTimes(1);
    const payload = mockCreateTransfer.mock.calls[0][0];
    expect(payload.fromEngineerId).toBe(SAHUL);
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0]).toMatchObject({ irmItemId: CABLE, quantity: 2 });

    // The warehouse line keeps its picked warehouse; the van line records its source engineer.
    const patch = mockFinalize.mock.calls[0][1];
    expect(patch.fulfillmentMode).toBe("mixed");
    expect(patch.lineSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: L_PANEL, sourceType: "warehouse", sourceWarehouseId: WH, sourceEngineerId: null }),
        expect.objectContaining({ id: L_CABLE, sourceType: "engineer", sourceEngineerId: SAHUL }),
      ]),
    );
  });

  it("opens ONE transfer per distinct source engineer", async () => {
    await approve(
      REQ_ID,
      {
        lineSources: [
          { requestLineId: L_PANEL, sourceType: "engineer", engineerId: SAHUL },
          { requestLineId: L_CABLE, sourceType: "engineer", engineerId: RAVI },
        ],
      } as never,
      actor,
    );

    expect(mockCreateTransfer).toHaveBeenCalledTimes(2);
    const sources = mockCreateTransfer.mock.calls.map((c) => c[0].fromEngineerId).sort();
    expect(sources).toEqual([SAHUL, RAVI].sort());
    expect(mockFinalize.mock.calls[0][1].fulfillmentMode).toBe("engineer_transfer");
    expect(mockFinalize.mock.calls[0][1].transferIds).toHaveLength(2);
  });

  it("checks each engineer against ONLY the lines they supply, not the whole request", async () => {
    // Sahul holds cable but NO panel. He's only asked for the cable, so this must succeed —
    // the old all-or-nothing check would have rejected him for not holding everything.
    mockEngBalances.mockResolvedValue([{ irmItemId: CABLE, quantityOnHand: 10 }]);

    await approve(
      REQ_ID,
      {
        lineSources: [
          { requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH },
          { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL },
        ],
      } as never,
      actor,
    );

    expect(mockCreateTransfer).toHaveBeenCalledTimes(1);
  });

  it("rejects when a source engineer is short of the line they were assigned", async () => {
    mockEngBalances.mockResolvedValue([{ irmItemId: CABLE, quantityOnHand: 1 }]); // needs 2

    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL }] } as never, actor),
    ).rejects.toThrow(/doesn't hold enough/i);

    // Nothing was claimed or grown — a rejected approval leaves the request pending.
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockAppendKit).not.toHaveBeenCalled();
  });

  it("refuses to transfer from the job's own engineer", async () => {
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: TO_ENG }] } as never, actor),
    ).rejects.toThrow(/can't transfer to themselves/i);
  });

  it("requires a source for every stock-tracked line", async () => {
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }] } as never, actor),
    ).rejects.toThrow(/Choose where "CAT6 Cable" will be fulfilled from/i);
  });

  it("requires a warehouse on a warehouse-sourced IRM line", async () => {
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse" }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL }] } as never, actor),
    ).rejects.toThrow(/pickup warehouse/i);
  });

  it("resumes after a crash without opening a duplicate transfer", async () => {
    // A prior attempt already opened Sahul's transfer and checkpointed it, then died before Ravi's.
    mockFindReq.mockResolvedValue(request({ transferIds: ["t-sahul"] }));
    mockTransferSources.mockResolvedValue([{ id: "t-sahul", fromEngineerId: SAHUL }]);

    await approve(
      REQ_ID,
      {
        lineSources: [
          { requestLineId: L_PANEL, sourceType: "engineer", engineerId: SAHUL },
          { requestLineId: L_CABLE, sourceType: "engineer", engineerId: RAVI },
        ],
      } as never,
      actor,
    );

    // Only RAVI's transfer is created; Sahul's existing one is reused.
    expect(mockCreateTransfer).toHaveBeenCalledTimes(1);
    expect(mockCreateTransfer.mock.calls[0][0].fromEngineerId).toBe(RAVI);
    expect(mockFinalize.mock.calls[0][1].transferIds).toContain("t-sahul");
  });

  it("still accepts the legacy all-warehouse shorthand", async () => {
    await approve(
      REQ_ID,
      { fulfillmentMode: "warehouse_issue", lineWarehouses: [{ requestLineId: L_PANEL, warehouseId: WH }, { requestLineId: L_CABLE, warehouseId: WH }] } as never,
      actor,
    );
    expect(mockCreateTransfer).not.toHaveBeenCalled();
    expect(mockFinalize.mock.calls[0][1].fulfillmentMode).toBe("warehouse_issue");
  });

  it("still accepts the legacy single-engineer shorthand", async () => {
    await approve(REQ_ID, { fulfillmentMode: "engineer_transfer", fromEngineerId: SAHUL } as never, actor);
    expect(mockCreateTransfer).toHaveBeenCalledTimes(1);
    expect(mockCreateTransfer.mock.calls[0][0].lines).toHaveLength(2); // both lines from one van
    expect(mockFinalize.mock.calls[0][1].fulfillmentMode).toBe("engineer_transfer");
  });
});
