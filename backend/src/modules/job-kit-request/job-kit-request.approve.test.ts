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
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({ findCustomerHoldingsByEngineer: vi.fn(), findCustomerStockEntriesByIds: vi.fn(), findCustomerEntryWarehousesByIds: vi.fn() }));
vi.mock("#modules/goods-management/goods-management.service.js", () => ({ jobCommittedByEngineer: vi.fn() }));
vi.mock("#modules/goods-management/demand.js", () => ({ getOpenDemand: vi.fn() }));
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({ findEngineerBalances: vi.fn() }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findAllBalances: vi.fn(), findBalancesByItemsAndWarehouses: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findMany: vi.fn() }));
vi.mock("#modules/engineer-transfer/engineer-transfer.repository.js", () => ({
  findHoldersForIrm: vi.fn(),
  findHoldersForCustomer: vi.fn(),
  findSourcesByIds: vi.fn(),
}));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn() }));
vi.mock("../../lib/realtime.js", () => ({ emitAttentionChanged: vi.fn(), emitToUser: vi.fn(), emitToRoom: vi.fn(), OFFICE_JOBS_ROOM: "office:jobs" }));
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
import * as goodsManagementService from "#modules/goods-management/goods-management.service.js";
import { getOpenDemand } from "#modules/goods-management/demand.js";
import { approve, holdersByLine } from "./job-kit-request.service.js";

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

// Plenty of stock at every warehouse and no competing demand, unless a test says otherwise — these
// suites are about SOURCING, and a capacity failure would mask what they actually assert.
beforeEach(() => {
  vi.mocked(getOpenDemand).mockResolvedValue(new Map() as never);
  // Nothing committed to the holder's own jobs by default — the shortage check awaits this now, so an
  // unset mock resolves to undefined and every suite fails on `.catch` rather than on its subject.
  vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map() as never);
  (inventoryRepo.findBalancesByItemsAndWarehouses as ReturnType<typeof vi.fn>).mockResolvedValue([
    { irmItemId: PANEL, warehouseId: WH, quantityOnHand: 999 },
    { irmItemId: CABLE, warehouseId: WH, quantityOnHand: 999 },
  ]);
});

describe("approve — per-line fulfilment sourcing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOpenDemand).mockResolvedValue(new Map() as never);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map() as never);
    (inventoryRepo.findBalancesByItemsAndWarehouses as ReturnType<typeof vi.fn>).mockResolvedValue([
      { irmItemId: PANEL, warehouseId: WH, quantityOnHand: 999 },
      { irmItemId: CABLE, warehouseId: WH, quantityOnHand: 999 },
    ]);
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

// ── holdersByLine — which vans the reviewer may source a line from ─────────────────────────────
//
// `available` drives two things: whether a holder is offered at all (they need enough for the line)
// and the number shown beside their name. It read the raw EngineerStockBalance, which counts stock the
// holder is already holding AGAINST THEIR OWN active job — stock that must go back through that job's
// Close & Reconcile and can never be transferred away. Offering it double-books the same units: the
// reviewer picks a colleague who looks like they have five, and the transfer strands the job that was
// relying on them. The field-stock return flow already nets this off via jobCommittedByEngineer; the
// kit-request source picker never did.
describe("holdersByLine — a van only offers what is genuinely spare", () => {
  const REQ_ID = "r".repeat(24);
  const LINE_ID = "l".repeat(24);
  const ITEM_ID = "i".repeat(24);
  const OWN_ENG = "o".repeat(24);
  const HOLDER = "h".repeat(24);

  const stageRequest = () => {
    vi.mocked(kitRequestRepo.findById).mockResolvedValue({
      id: REQ_ID,
      jobId: "j".repeat(24),
      lines: [{ id: LINE_ID, source: "irm", irmItemId: ITEM_ID, qty: 3, itemName: "CAT6" }],
    } as never);
    vi.mocked(jobRepo.findById).mockResolvedValue({ id: "j".repeat(24), assignedEngineerId: OWN_ENG } as never);
  };

  beforeEach(() => {
    stageRequest();
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map() as never);
  });

  it("subtracts what the holder owes their own job", async () => {
    vi.mocked(transferRepo.findHoldersForIrm).mockResolvedValue([{ engineerId: HOLDER, name: "Bob", available: 5 }] as never);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map([[ITEM_ID, 2]]) as never);

    const [line] = await holdersByLine(REQ_ID);
    expect(line.holders).toEqual([{ engineerId: HOLDER, name: "Bob", available: 3 }]);
  });

  // The unit-of-work: 5 on the van, 3 owed to their own job ⇒ 2 spare, which is short of this line's
  // 3. Before, they were offered as having 5 and the reviewer could pick them.
  it("drops a holder whose spare stock no longer covers the line", async () => {
    vi.mocked(transferRepo.findHoldersForIrm).mockResolvedValue([{ engineerId: HOLDER, name: "Bob", available: 5 }] as never);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map([[ITEM_ID, 3]]) as never);

    const [line] = await holdersByLine(REQ_ID);
    expect(line.holders).toEqual([]);
  });

  it("leaves an uncommitted holder untouched", async () => {
    vi.mocked(transferRepo.findHoldersForIrm).mockResolvedValue([{ engineerId: HOLDER, name: "Bob", available: 4 }] as never);
    const [line] = await holdersByLine(REQ_ID);
    expect(line.holders).toEqual([{ engineerId: HOLDER, name: "Bob", available: 4 }]);
  });

  // Consignment offers NO van source at all — this used to return the holder untouched.
  //
  // Customer stock only ever reaches an engineer THROUGH A JOB: a field stock request carries no
  // customerStockEntryId, and the only writes to EngineerCustomerStockHolding are a job issue and a
  // job-scoped transfer. So every unit a colleague holds is committed to their job — there is no
  // "spare" consignment to offer, and jobCommittedByEngineer deliberately doesn't cover this pool, so
  // there was nothing to net it against either. The reviewer saw "Kansha M · holds 2" in the same
  // words used for genuinely free IRM stock, and picking it would strip the job relying on it.
  //
  // The engineer's own composer already treats consignment as warehouse-only; this makes the review
  // step agree. A planner who really means to move it raises a job transfer directly, where the
  // re-allocation is explicit rather than disguised as spare stock.
  it("offers no van source for a customer-stock line", async () => {
    vi.mocked(kitRequestRepo.findById).mockResolvedValue({
      id: REQ_ID,
      jobId: "j".repeat(24),
      lines: [{ id: LINE_ID, source: "customer_stock", customerStockEntryId: "e".repeat(24), qty: 2, itemName: "mouse" }],
    } as never);
    vi.mocked(transferRepo.findHoldersForCustomer).mockResolvedValue([{ engineerId: HOLDER, name: "Bob", available: 2 }] as never);

    const [line] = await holdersByLine(REQ_ID);
    expect(line.holders).toEqual([]);
  });

  it("never even asks who holds a consignment entry", async () => {
    vi.mocked(kitRequestRepo.findById).mockResolvedValue({
      id: REQ_ID,
      jobId: "j".repeat(24),
      lines: [{ id: LINE_ID, source: "customer_stock", customerStockEntryId: "e".repeat(24), qty: 2, itemName: "mouse" }],
    } as never);
    await holdersByLine(REQ_ID);
    expect(transferRepo.findHoldersForCustomer).not.toHaveBeenCalled();
  });
});

// ── Split sourcing: part of a line from a warehouse, the rest off a colleague's van ────────────
//
// The reviewer could only pick ONE source per line, so a request for 5 with 2 on the shelf and 29 on
// a colleague's van had no answer: the warehouse can't cover it and moving all 5 off the van strips a
// colleague who may need them. They were forced to decline, or to over-draw one side.
//
// The kit line already models this — jobStatus.tsx: "A kit line MERGES sources … units collected from
// the warehouse and units handed over from another engineer's van end up on a single line (planned 3
// = 2 from stock + 1 from a van)". Only the approve dialog forced the either/or.
//
// `engineerQty` expresses the split. The TRANSFER carries just that many; the kit line still grows by
// the full requested quantity and stays homed at the chosen warehouse, so the remainder is collected
// there in the normal way. Omitting engineerQty keeps the old whole-line behaviour.
describe("approve — splitting one line across a warehouse and a van", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindReq.mockResolvedValue(request());
    mockFindJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0024", assignedEngineerId: TO_ENG, customerId: CUSTOMER_ID, kitLines: [] });
    mockClaim.mockResolvedValue(1);
    mockAppendKit.mockResolvedValue({ jobKitLineIds: ["k1", "k2"] });
    mockCreateTransfer.mockImplementation(async () => ({ id: "t1" }));
    mockFinalize.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...request(), status: "approved", ...patch, lines: request().lines }));
    mockTransferSources.mockResolvedValue([]);
    (kitRequestRepo.revertToPending as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (inventoryRepo.findAllBalances as ReturnType<typeof vi.fn>).mockResolvedValue([{ warehouseId: WH, quantityOnHand: 5 }]);
    mockEngBalances.mockResolvedValue([{ irmItemId: PANEL, quantityOnHand: 50 }, { irmItemId: CABLE, quantityOnHand: 50 }]);
    mockCustHoldings.mockResolvedValue([]);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map() as never);
  });

  // CABLE is requested ×2. Take 1 off the van, leave 1 to collect from the warehouse.
  it("transfers only the van portion, not the whole line", async () => {
    await approve(
      REQ_ID,
      {
        lineSources: [
          { requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH },
          { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL, engineerQty: 1, warehouseId: WH },
        ],
      } as never,
      actor,
    );

    const payload = mockCreateTransfer.mock.calls[0][0];
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0]).toMatchObject({ irmItemId: CABLE, quantity: 1 }); // not 2
  });

  // The remainder has to be collectable, so a split line keeps the reviewer's chosen warehouse rather
  // than the nominal home a fully-van-sourced line gets.
  it("homes the split line at the warehouse the reviewer picked", async () => {
    await approve(
      REQ_ID,
      {
        lineSources: [
          { requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH },
          { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL, engineerQty: 1, warehouseId: WH },
        ],
      } as never,
      actor,
    );
    const patch = mockFinalize.mock.calls[0][1];
    expect(patch.lineSources).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: L_CABLE, sourceWarehouseId: WH, sourceEngineerId: SAHUL })]),
    );
  });

  // The shortage guard must test the SPLIT quantity. Against the full line it would reject a colleague
  // who can comfortably cover the portion actually being asked of them.
  it("checks the holder against the split quantity, not the whole line", async () => {
    mockEngBalances.mockResolvedValue([{ irmItemId: PANEL, quantityOnHand: 50 }, { irmItemId: CABLE, quantityOnHand: 1 }]);
    await expect(
      approve(
        REQ_ID,
        {
          lineSources: [
            { requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH },
            { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL, engineerQty: 1, warehouseId: WH },
          ],
        } as never,
        actor,
      ),
    ).resolves.toBeDefined();
  });

  it("still rejects a holder who is short of even the split portion", async () => {
    mockEngBalances.mockResolvedValue([{ irmItemId: PANEL, quantityOnHand: 50 }, { irmItemId: CABLE, quantityOnHand: 0 }]);
    await expect(
      approve(
        REQ_ID,
        { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL, engineerQty: 1, warehouseId: WH }] } as never,
        actor,
      ),
    ).rejects.toThrow(/doesn't hold enough/i);
  });

  // A split needs somewhere to collect the remainder from; without it the leftover units would have no
  // pickup location and the engineer would arrive at the job short with nothing saying why.
  it("refuses a partial split with no warehouse for the remainder", async () => {
    await expect(
      approve(
        REQ_ID,
        { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL, engineerQty: 1 }] } as never,
        actor,
      ),
    ).rejects.toThrow(/warehouse/i);
  });

  // engineerQty equal to the line is just the existing whole-line transfer.
  it("treats a full-quantity split as an ordinary van line", async () => {
    await approve(
      REQ_ID,
      { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL, engineerQty: 2 }] } as never,
      actor,
    );
    expect(mockCreateTransfer.mock.calls[0][0].lines[0]).toMatchObject({ quantity: 2 });
  });

  it("rejects a split larger than the line itself", async () => {
    await expect(
      approve(
        REQ_ID,
        { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL, engineerQty: 5, warehouseId: WH }] } as never,
        actor,
      ),
    ).rejects.toThrow(/more than/i);
  });
});

// ── Approved quantity: the reviewer's trim ────────────────────────────────────────────────────
//
// An engineer asks for 5; the planner judges 4 is right. Without a trim the only moves were approve
// all 5 or decline the lot, so a request that was 80% reasonable got refused — and the engineer had
// to raise it again for the number the planner would have said yes to. Field Stock already models
// this (VanStockLine.approvedQty, "the trim"); kit requests grew the kit by whatever was asked.
//
// `approvedQty` caps the line. The KIT grows by it, and a van split has to fit inside it.
describe("approve — trimming the approved quantity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindReq.mockResolvedValue(request());
    mockFindJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0024", assignedEngineerId: TO_ENG, customerId: CUSTOMER_ID, kitLines: [] });
    mockClaim.mockResolvedValue(1);
    mockAppendKit.mockResolvedValue({ jobKitLineIds: ["k1", "k2"] });
    mockCreateTransfer.mockImplementation(async () => ({ id: "t1" }));
    mockFinalize.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...request(), status: "approved", ...patch, lines: request().lines }));
    mockTransferSources.mockResolvedValue([]);
    (kitRequestRepo.revertToPending as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (inventoryRepo.findAllBalances as ReturnType<typeof vi.fn>).mockResolvedValue([{ warehouseId: WH, quantityOnHand: 5 }]);
    mockEngBalances.mockResolvedValue([{ irmItemId: PANEL, quantityOnHand: 50 }, { irmItemId: CABLE, quantityOnHand: 50 }]);
    mockCustHoldings.mockResolvedValue([]);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map() as never);
  });

  // CABLE is requested ×2; approve only 1.
  it("grows the kit by the approved quantity, not the requested one", async () => {
    await approve(
      REQ_ID,
      {
        lineSources: [
          { requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH },
          { requestLineId: L_CABLE, sourceType: "warehouse", warehouseId: WH, approvedQty: 1 },
        ],
      } as never,
      actor,
    );
    const appended = mockAppendKit.mock.calls[0][1];
    expect(appended.find((l: { itemName: string }) => l.itemName === "CAT6 Cable")).toMatchObject({ qty: 1 });
    // Untouched lines keep what was asked for.
    expect(appended.find((l: { itemName: string }) => l.itemName === "Patch Panel")).toMatchObject({ qty: 1 });
  });

  it("leaves the kit at the requested quantity when no trim is given", async () => {
    await approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "warehouse", warehouseId: WH }] } as never, actor);
    expect(mockAppendKit.mock.calls[0][1].find((l: { itemName: string }) => l.itemName === "CAT6 Cable")).toMatchObject({ qty: 2 });
  });

  it("refuses a trim above what was requested", async () => {
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "warehouse", warehouseId: WH, approvedQty: 9 }] } as never, actor),
    ).rejects.toThrow(/more than/i);
  });

  // A van split has to fit inside the APPROVED quantity — approving 1 but transferring 2 would put
  // more on the kit line than the planner agreed to.
  it("caps a van split at the approved quantity", async () => {
    await expect(
      approve(
        REQ_ID,
        {
          lineSources: [
            { requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH },
            { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL, engineerQty: 2, approvedQty: 1, warehouseId: WH },
          ],
        } as never,
        actor,
      ),
    ).rejects.toThrow(/more than/i);
  });

  it("transfers the whole approved quantity when the split equals it", async () => {
    await approve(
      REQ_ID,
      {
        lineSources: [
          { requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH },
          { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL, engineerQty: 1, approvedQty: 1 },
        ],
      } as never,
      actor,
    );
    expect(mockCreateTransfer.mock.calls[0][0].lines[0]).toMatchObject({ quantity: 1 });
  });
});

// ── Excluding a single line (approvedQty 0) ───────────────────────────────────────────────────
//
// A planner who wanted 6 of 7 items had two moves: approve all 7, or decline the lot and make the
// engineer raise it again minus one. Field Stock already treats approvedQty 0 as "excluded" and
// renders it struck through; kit requests had no per-line refusal at all.
//
// The subtlety is the kit grow: it stamps each request line with the JobKitLine it created BY INDEX
// (`ids[i]`). Drop a line from the grow without dropping it from the stamping and every line after it
// is stamped with its neighbour's kit line — silently attributing a transfer to the wrong item.
describe("approve — excluding one line while approving the rest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindReq.mockResolvedValue(request());
    mockFindJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0024", assignedEngineerId: TO_ENG, customerId: CUSTOMER_ID, kitLines: [] });
    mockClaim.mockResolvedValue(1);
    mockAppendKit.mockResolvedValue({ jobKitLineIds: ["k1"] });
    mockCreateTransfer.mockImplementation(async () => ({ id: "t1" }));
    mockFinalize.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...request(), status: "approved", ...patch, lines: request().lines }));
    mockTransferSources.mockResolvedValue([]);
    (kitRequestRepo.revertToPending as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (inventoryRepo.findAllBalances as ReturnType<typeof vi.fn>).mockResolvedValue([{ warehouseId: WH, quantityOnHand: 5 }]);
    mockEngBalances.mockResolvedValue([{ irmItemId: PANEL, quantityOnHand: 50 }, { irmItemId: CABLE, quantityOnHand: 50 }]);
    mockCustHoldings.mockResolvedValue([]);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map() as never);
  });

  const excludeCable = {
    lineSources: [
      { requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH },
      { requestLineId: L_CABLE, sourceType: "warehouse", approvedQty: 0 },
    ],
  } as never;

  it("keeps an excluded line out of the kit entirely", async () => {
    await approve(REQ_ID, excludeCable, actor);
    const appended = mockAppendKit.mock.calls[0][1];
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ itemName: "Patch Panel" });
  });

  // The index trap: with CABLE dropped from the grow, PANEL must still be stamped with k1.
  it("stamps the surviving lines with their OWN kit lines, not their neighbour's", async () => {
    await approve(REQ_ID, excludeCable, actor);
    const stampFn = mockAppendKit.mock.calls[0][3];
    const stamped: { id: string; jobKitLineId: string | null }[] = [];
    (kitRequestRepo.stampLineKitIdsTx as ReturnType<typeof vi.fn>).mockImplementation(async (_tx: unknown, rows: typeof stamped) => { stamped.push(...rows); });
    await stampFn({}, ["k1"]);
    expect(stamped).toEqual([{ id: L_PANEL, jobKitLineId: "k1" }]);
  });

  // An excluded line must not drag a colleague into a transfer for stock nobody approved.
  it("never transfers an excluded line", async () => {
    await approve(
      REQ_ID,
      { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL, approvedQty: 0 }] } as never,
      actor,
    );
    expect(mockCreateTransfer).not.toHaveBeenCalled();
  });

  // …nor be blocked by a shortage on stock that isn't being moved.
  it("ignores a holder shortage on an excluded line", async () => {
    mockEngBalances.mockResolvedValue([{ irmItemId: CABLE, quantityOnHand: 0 }]);
    await expect(
      approve(
        REQ_ID,
        { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL, approvedQty: 0 }] } as never,
        actor,
      ),
    ).resolves.toBeDefined();
  });

  // The resume guard asked whether EVERY line was stamped. An excluded line is deliberately never
  // stamped, so with one exclusion the request could never look grown: a retry after a crash past the
  // grow would call appendKitFromRequest a second time, and that ADDS to the matching kit line —
  // silently doubling the approved quantity on the job.
  it("does not re-grow the kit on a retry after the grow already committed", async () => {
    mockFindReq.mockResolvedValue(
      request({
        lines: [
          { id: L_PANEL, source: "irm", irmItemId: PANEL, customerStockEntryId: null, itemName: "Patch Panel", qty: 1, jobKitLineId: "k1", sourceEngineerId: null },
          { id: L_CABLE, source: "irm", irmItemId: CABLE, customerStockEntryId: null, itemName: "CAT6 Cable", qty: 2, jobKitLineId: null, sourceEngineerId: null },
        ],
      }),
    );

    await approve(REQ_ID, excludeCable, actor);

    expect(mockAppendKit).not.toHaveBeenCalled();
  });

  // Resuming reads the stamps off req.lines, which still holds the excluded line. Pairing those ids
  // positionally against the INCLUDED lines shifts every line after an exclusion onto its neighbour's
  // kit line — the same index trap as the grow, one branch over.
  it("pairs a resumed kit line with its own request line, not its neighbour's", async () => {
    mockFindReq.mockResolvedValue(
      request({
        lines: [
          { id: L_PANEL, source: "irm", irmItemId: PANEL, customerStockEntryId: null, itemName: "Patch Panel", qty: 1, jobKitLineId: null, sourceEngineerId: null },
          { id: L_CABLE, source: "irm", irmItemId: CABLE, customerStockEntryId: null, itemName: "CAT6 Cable", qty: 2, jobKitLineId: "k2", sourceEngineerId: null },
        ],
      }),
    );

    await approve(
      REQ_ID,
      { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", approvedQty: 0 }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL }] } as never,
      actor,
    );

    expect(mockCreateTransfer.mock.calls[0][0].lines).toEqual([expect.objectContaining({ jobKitLineId: "k2" })]);
  });

  // Excluding everything is a decline wearing an approval's clothes — it would mark the request
  // "approved" while giving the engineer nothing, and the decline note is where the reason belongs.
  it("refuses an approval with every line excluded", async () => {
    await expect(
      approve(
        REQ_ID,
        { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", approvedQty: 0 }, { requestLineId: L_CABLE, sourceType: "warehouse", approvedQty: 0 }] } as never,
        actor,
      ),
    ).rejects.toThrow(/decline/i);
  });
});

// The request has to stay a faithful record of ask-versus-granted. An EXCLUDED line grows no kit
// line at all, so if the decision lived only in the kit, the refusal would simply vanish from the
// history — nobody could later answer "did the planner say no to that, or was it never asked for?".
describe("approve — recording what was actually approved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindReq.mockResolvedValue(request());
    mockFindJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0024", assignedEngineerId: TO_ENG, customerId: CUSTOMER_ID, kitLines: [] });
    mockClaim.mockResolvedValue(1);
    mockAppendKit.mockResolvedValue({ jobKitLineIds: ["k1", "k2"] });
    mockFinalize.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...request(), status: "approved", ...patch, lines: request().lines }));
    mockTransferSources.mockResolvedValue([]);
    (kitRequestRepo.revertToPending as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (inventoryRepo.findAllBalances as ReturnType<typeof vi.fn>).mockResolvedValue([{ warehouseId: WH, quantityOnHand: 5 }]);
    mockEngBalances.mockResolvedValue([{ irmItemId: PANEL, quantityOnHand: 50 }, { irmItemId: CABLE, quantityOnHand: 50 }]);
    mockCustHoldings.mockResolvedValue([]);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map() as never);
  });

  const sourcesOf = () => mockFinalize.mock.calls[0][1].lineSources as { id: string; approvedQty: number | null }[];

  it("records a trim against its line", async () => {
    await approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "warehouse", warehouseId: WH, approvedQty: 1 }] } as never, actor);
    expect(sourcesOf().find((s) => s.id === L_CABLE)).toMatchObject({ approvedQty: 1 });
  });

  // Zero is the whole point — it is the only trace an excluded line leaves anywhere.
  it("records an exclusion as 0, not as absent", async () => {
    await approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "warehouse", approvedQty: 0 }] } as never, actor);
    expect(sourcesOf().find((s) => s.id === L_CABLE)).toMatchObject({ approvedQty: 0 });
  });

  // Null means "approved in full", which is also what every row predating the trim reads as — so an
  // untouched line must not be written as its own quantity, or old and new rows stop meaning the same.
  it("leaves an untouched line null rather than echoing its quantity", async () => {
    await approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "warehouse", warehouseId: WH }] } as never, actor);
    expect(sourcesOf().find((s) => s.id === L_CABLE)).toMatchObject({ approvedQty: null });
  });
});

// A stale client (or a hand-rolled call) could still name an engineer for a consignment line, and the
// UI no longer offering the option is not a guarantee. Refused at the service, where it can't be
// bypassed — otherwise the approval opens a transfer that strips another job's committed stock.
describe("approve — consignment can't be sourced from a van", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0024", assignedEngineerId: TO_ENG, customerId: CUSTOMER_ID, kitLines: [] });
    mockClaim.mockResolvedValue(1);
    mockFindReq.mockResolvedValue({
      ...request(),
      lines: [{ id: L_PANEL, source: "customer_stock", irmItemId: null, customerStockEntryId: "e".repeat(24), itemName: "mouse123", qty: 2, jobKitLineId: null, sourceEngineerId: null }],
    });
  });

  it("rejects an engineer source on a customer-stock line", async () => {
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "engineer", engineerId: SAHUL }] } as never, actor),
    ).rejects.toThrow(/customer stock/i);
  });
});

// ── Server-side guards that were UI-only ──────────────────────────────────────────────────────
//
// Two checks existed in the approve dialog and nowhere else. A stale tab, a replayed request or a
// direct call bypassed both — and "the client stopped sending it" has never been a guarantee.
describe("approve — guards that must not live only in the dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindReq.mockResolvedValue(request());
    mockFindJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0024", assignedEngineerId: TO_ENG, customerId: CUSTOMER_ID, kitLines: [] });
    mockClaim.mockResolvedValue(1);
    mockAppendKit.mockResolvedValue({ jobKitLineIds: ["k1", "k2"] });
    mockCreateTransfer.mockImplementation(async () => ({ id: "t1" }));
    mockFinalize.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...request(), status: "approved", ...patch, lines: request().lines }));
    mockTransferSources.mockResolvedValue([]);
    (kitRequestRepo.revertToPending as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (inventoryRepo.findAllBalances as ReturnType<typeof vi.fn>).mockResolvedValue([{ warehouseId: WH, quantityOnHand: 5 }]);
    mockEngBalances.mockResolvedValue([{ irmItemId: PANEL, quantityOnHand: 50 }, { irmItemId: CABLE, quantityOnHand: 50 }]);
    mockCustHoldings.mockResolvedValue([]);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map() as never);
    // Plenty at the chosen warehouse unless a test says otherwise.
    (inventoryRepo.findBalancesByItemsAndWarehouses as ReturnType<typeof vi.fn>).mockResolvedValue([
      { irmItemId: PANEL, warehouseId: WH, quantityOnHand: 50 },
      { irmItemId: CABLE, warehouseId: WH, quantityOnHand: 50 },
    ]);
  });

  // A kit line homes at ONE warehouse, so anything approved beyond what that site holds is
  // unissuable and sits on the job forever. The dialog blocks it; nothing else did.
  it("refuses to approve more than the chosen warehouse can supply", async () => {
    (inventoryRepo.findBalancesByItemsAndWarehouses as ReturnType<typeof vi.fn>).mockResolvedValue([
      { irmItemId: PANEL, warehouseId: WH, quantityOnHand: 50 },
      { irmItemId: CABLE, warehouseId: WH, quantityOnHand: 1 }, // line asks for 2
    ]);
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "warehouse", warehouseId: WH }] } as never, actor),
    ).rejects.toThrow(/only 1/i);
  });

  // Only the WAREHOUSE portion has to be there — a van covering the rest is not the warehouse's problem.
  it("measures the warehouse against its own portion of a split, not the whole line", async () => {
    (inventoryRepo.findBalancesByItemsAndWarehouses as ReturnType<typeof vi.fn>).mockResolvedValue([
      { irmItemId: PANEL, warehouseId: WH, quantityOnHand: 50 },
      { irmItemId: CABLE, warehouseId: WH, quantityOnHand: 1 },
    ]);
    await expect(
      approve(
        REQ_ID,
        { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL, engineerQty: 1, warehouseId: WH }] } as never,
        actor,
      ),
    ).resolves.toBeDefined(); // 2 requested − 1 from the van = 1 from the warehouse, which has 1
  });

  it("lets a trimmed line through when the trim brings it within stock", async () => {
    (inventoryRepo.findBalancesByItemsAndWarehouses as ReturnType<typeof vi.fn>).mockResolvedValue([
      { irmItemId: PANEL, warehouseId: WH, quantityOnHand: 50 },
      { irmItemId: CABLE, warehouseId: WH, quantityOnHand: 1 },
    ]);
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "warehouse", warehouseId: WH, approvedQty: 1 }] } as never, actor),
    ).resolves.toBeDefined();
  });

  // The PICKER nets a holder's own job commitments; this check read the raw balance. So a colleague
  // the dialog would never offer could still be named directly, and the approval sailed through —
  // stripping the job those units were held for.
  it("checks a holder's SPARE stock, not their raw balance", async () => {
    mockEngBalances.mockResolvedValue([{ irmItemId: CABLE, quantityOnHand: 5 }]);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map([[CABLE, 4]]) as never);
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL }] } as never, actor),
    ).rejects.toThrow(/doesn't hold enough/i); // holds 5, owes 4 to their own job, line needs 2
  });

  it("still accepts a holder whose spare covers the line", async () => {
    mockEngBalances.mockResolvedValue([{ irmItemId: CABLE, quantityOnHand: 5 }]);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map([[CABLE, 3]]) as never);
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", warehouseId: WH }, { requestLineId: L_CABLE, sourceType: "engineer", engineerId: SAHUL }] } as never, actor),
    ).resolves.toBeDefined();
  });
});

// The capacity guard walked irmLines only, so consignment was checked in the dialog and nowhere else
// — the exact UI-only pattern this suite exists to close. A consignment line can't be van-sourced, so
// the whole approved quantity comes off the entry; approving more than it holds leaves a shortfall
// that can never be issued and sits on the job forever.
describe("approve — consignment capacity is enforced on the server too", () => {
  const CSE = "e".repeat(24);
  const consignmentRequest = (qty: number) => ({
    ...request(),
    lines: [{ id: L_PANEL, source: "customer_stock", irmItemId: null, customerStockEntryId: CSE, itemName: "mouse123", qty, jobKitLineId: null, sourceEngineerId: null }],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0024", assignedEngineerId: TO_ENG, customerId: CUSTOMER_ID, kitLines: [] });
    mockClaim.mockResolvedValue(1);
    mockAppendKit.mockResolvedValue({ jobKitLineIds: ["k1"] });
    mockFinalize.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...consignmentRequest(2), status: "approved", ...patch }));
    mockTransferSources.mockResolvedValue([]);
    (kitRequestRepo.revertToPending as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    vi.mocked(getOpenDemand).mockResolvedValue(new Map() as never);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map() as never);
    (inventoryRepo.findBalancesByItemsAndWarehouses as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (goodsManagementRepo.findCustomerStockEntriesByIds as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: CSE, quantity: 1 }]);
  });

  it("refuses to approve more than the entry holds", async () => {
    mockFindReq.mockResolvedValue(consignmentRequest(2)); // entry holds 1
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse" }] } as never, actor),
    ).rejects.toThrow(/only 1/i);
  });

  it("allows an approval the entry can cover", async () => {
    mockFindReq.mockResolvedValue(consignmentRequest(1));
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse" }] } as never, actor),
    ).resolves.toBeDefined();
  });

  it("lets a trim bring an over-sized line within the entry", async () => {
    mockFindReq.mockResolvedValue(consignmentRequest(2));
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", approvedQty: 1 }] } as never, actor),
    ).resolves.toBeDefined();
  });

  // Netted like every other availability figure — the raw entry quantity would offer units another
  // job has already planned.
  it("nets the entry against other jobs' planned demand", async () => {
    mockFindReq.mockResolvedValue(consignmentRequest(1));
    (goodsManagementRepo.findCustomerStockEntriesByIds as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: CSE, quantity: 3 }]);
    vi.mocked(getOpenDemand).mockResolvedValue(
      new Map([["k", { irmItemId: null, customerStockEntryId: CSE, warehouseId: null, itemName: "mouse123", warehouseName: null, demand: 3 }]]) as never,
    );
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse" }] } as never, actor),
    ).rejects.toThrow(/only 0/i);
  });

  it("skips the check for an excluded line", async () => {
    mockFindReq.mockResolvedValue({
      ...request(),
      lines: [
        { id: L_PANEL, source: "customer_stock", irmItemId: null, customerStockEntryId: CSE, itemName: "mouse123", qty: 2, jobKitLineId: null, sourceEngineerId: null },
        { id: L_CABLE, source: "irm", irmItemId: CABLE, customerStockEntryId: null, itemName: "CAT6 Cable", qty: 1, jobKitLineId: null, sourceEngineerId: null },
      ],
    });
    (inventoryRepo.findBalancesByItemsAndWarehouses as ReturnType<typeof vi.fn>).mockResolvedValue([{ irmItemId: CABLE, warehouseId: WH, quantityOnHand: 9 }]);
    await expect(
      approve(
        REQ_ID,
        { lineSources: [{ requestLineId: L_PANEL, sourceType: "warehouse", approvedQty: 0 }, { requestLineId: L_CABLE, sourceType: "warehouse", warehouseId: WH }] } as never,
        actor,
      ),
    ).resolves.toBeDefined();
  });
});


// Consignment cannot come off a van. A CustomerStockEntry is warehouse-held stock owned by the
// customer; the only reason an engineer ever holds any is that a JOB issued it to them, so it is
// already committed to that job. Approving a van source for it opens a transfer that strips another
// job's stock — which is why the per-line `sourceType: "engineer"` path refuses it.
//
// The request-level `fulfillmentMode: "engineer_transfer"` shorthand did NOT: it assigned the chosen
// engineer to every non-misc line, consignment included, walking straight past that guard. It is the
// legacy shape (the dialog sends lineSources now), so nothing in the UI reaches it — but "the client
// stopped sending it" has never been a guarantee here.
describe("approve — the legacy whole-request van mode can't take customer stock either", () => {
  const CSE2 = "f".repeat(24);
  const SRC_ENG = "e2".padEnd(24, "0"); // another engineer, the would-be van source
  const mixedRequest = () => ({
    ...request(),
    lines: [
      { id: L_CABLE, source: "irm", irmItemId: CABLE, customerStockEntryId: null, itemName: "CAT6 Cable", qty: 2, jobKitLineId: null, sourceEngineerId: null },
      { id: L_PANEL, source: "customer_stock", irmItemId: null, customerStockEntryId: CSE2, itemName: "mouse123", qty: 1, jobKitLineId: null, sourceEngineerId: null },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0030", assignedEngineerId: TO_ENG, customerId: CUSTOMER_ID, kitLines: [] });
    mockClaim.mockResolvedValue(1);
    mockAppendKit.mockResolvedValue({ jobKitLineIds: ["k1", "k2"] });
    mockFinalize.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...mixedRequest(), status: "approved", ...patch }));
    mockTransferSources.mockResolvedValue([]);
    (kitRequestRepo.revertToPending as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    vi.mocked(getOpenDemand).mockResolvedValue(new Map() as never);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map() as never);
    (inventoryRepo.findBalancesByItemsAndWarehouses as ReturnType<typeof vi.fn>).mockResolvedValue([{ irmItemId: CABLE, warehouseId: WH, quantityOnHand: 99 }]);
    (goodsManagementRepo.findCustomerStockEntriesByIds as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: CSE2, quantity: 9 }]);
    mockFindReq.mockResolvedValue(mixedRequest());
  });

  it("refuses the whole-request van mode when the request carries customer stock", async () => {
    await expect(
      approve(REQ_ID, { fulfillmentMode: "engineer_transfer", fromEngineerId: SRC_ENG } as never, actor),
    ).rejects.toThrow(/customer stock/i);
  });

  // Same refusal, same words, as the per-line path — one rule stated one way.
  it("names the item and says where it CAN come from", async () => {
    await expect(
      approve(REQ_ID, { fulfillmentMode: "engineer_transfer", fromEngineerId: SRC_ENG } as never, actor),
    ).rejects.toThrow(/mouse123.*warehouse it's stored at/i);
  });

  // An all-IRM request is untouched — the legacy mode still works for what it was built for.
  it("still allows the legacy mode for an IRM-only request", async () => {
    mockFindReq.mockResolvedValue({
      ...request(),
      lines: [{ id: L_CABLE, source: "irm", irmItemId: CABLE, customerStockEntryId: null, itemName: "CAT6 Cable", qty: 2, jobKitLineId: null, sourceEngineerId: null }],
    });
    await expect(
      approve(REQ_ID, { fulfillmentMode: "engineer_transfer", fromEngineerId: SRC_ENG } as never, actor),
    ).resolves.toBeDefined();
  });
});
