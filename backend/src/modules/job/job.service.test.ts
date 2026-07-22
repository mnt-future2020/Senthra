import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────────────────────────
vi.mock("./job.repository.js", () => ({
  findById: vi.fn(),
  findByIdForEngineer: vi.fn(),
  findManyByEngineer: vi.fn(),
  countByEngineer: vi.fn(),
  startIfAccepted: vi.fn(),
  completeIfInProgressTx: vi.fn(),
  acceptIfAssigned: vi.fn(),
  rejectIfAssigned: vi.fn(),
  update: vi.fn(),
  createWithCode: vi.fn(),
  mergeKitLines: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  findByNumber: vi.fn(),
  findActiveForGoodsManagement: vi.fn(),
  softDelete: vi.fn(),
}));

vi.mock("#modules/goods-management/goods-management.service.js", () => ({
  recordConsumeAndComplete: vi.fn(),
  warehouseScopeFilter: vi.fn(),
  scanLookup: vi.fn(),
  postIssue: vi.fn(),
  listQueue: vi.fn(),
  getJobGoods: vi.fn(),
  getJobKitTallies: vi.fn(),
  getGoodsStatus: vi.fn(),
}));

vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("../../lib/realtime.js", () => ({
  emitToUser: vi.fn(),
  emitToRoom: vi.fn(),
  OFFICE_JOBS_ROOM: "office_jobs",
}));
vi.mock("#modules/customer/customer.repository.js", () => ({
  findById: vi.fn(),
  findProjectById: vi.fn(),
  findSiteById: vi.fn(),
  findStockEntryById: vi.fn(),
}));
vi.mock("#modules/supplier/supplier.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/irm/irm.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findBalancePair: vi.fn() }));
vi.mock("#modules/user/user.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/engineer-transfer/engineer-transfer.repository.js", () => ({ findVanSourcesByKitLines: vi.fn() }));
vi.mock("#modules/email/email.service.js", () => ({ sendTemplatedEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("#modules/role/permissions.js", () => ({ roleGrants: vi.fn().mockReturnValue(false) }));

import * as jobRepo from "./job.repository.js";
import * as goodsManagementService from "#modules/goods-management/goods-management.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as transferRepo from "#modules/engineer-transfer/engineer-transfer.repository.js";
import { startJobForEngineer, completeJobForEngineer, updateJob, kitLinesChanged, getJob } from "./job.service.js";

const JOB_ID = "a".repeat(24);
const ENG_ID = "b".repeat(24);
const OTHER_ENG = "c".repeat(24);

const baseJob = {
  id: JOB_ID,
  jobNumber: "JOB-2026-0001",
  name: "Test Job",
  status: "accepted",
  assignedEngineerId: ENG_ID,
  assignedEngineerName: "Bob Smith",
  assignedEngineerEmail: "bob@x.com",
  assignedEngineer: null,
  deletedAt: null,
  customerId: "d".repeat(24),
  customerName: "Acme",
  customer: null,
  projectId: "e".repeat(24),
  projectName: null,
  project: null,
  siteId: null,
  siteName: null,
  site: null,
  supplierId: null,
  supplierName: null,
  supplier: null,
  trsArea: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  county: null,
  postcode: null,
  country: null,
  latitude: null,
  longitude: null,
  floor: null,
  suite: null,
  rack: null,
  shelf: null,
  completionDate: null,
  priority: "normal",
  plannerName: null,
  plannerPhone: null,
  notes: null,
  attachments: [],
  jobType: "installation",
  technology: null,
  customerRef: null,
  schemeNo: null,
  installerType: "internal",
  acceptedAt: null,
  acceptedBy: null,
  assignedAt: null,
  rejectedAt: null,
  rejectedBy: null,
  rejectReason: null,
  cancelledAt: null,
  cancelReason: null,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  kitLines: [],
};

const inProgressJob = { ...baseJob, status: "in_progress" };

const mockFindById = jobRepo.findById as ReturnType<typeof vi.fn>;
const mockStartIfAccepted = jobRepo.startIfAccepted as ReturnType<typeof vi.fn>;
const mockRecordConsumeAndComplete = goodsManagementService.recordConsumeAndComplete as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  mockRecordConsumeAndComplete.mockResolvedValue(undefined);
});

// ── startJobForEngineer ───────────────────────────────────────────────────────────────────────
describe("startJobForEngineer", () => {
  it("transitions accepted → in_progress and returns the updated job", async () => {
    mockFindById
      .mockResolvedValueOnce(baseJob) // pre-check read
      .mockResolvedValueOnce({ ...inProgressJob }); // post-start read (not used in start path)
    mockStartIfAccepted.mockResolvedValue({ ...inProgressJob });

    const result = await startJobForEngineer(JOB_ID, ENG_ID, { email: "wm@x.com" } as never);
    expect(result.status).toBe("in_progress");
    expect(mockStartIfAccepted).toHaveBeenCalledWith(JOB_ID, ENG_ID);
  });

  it("throws 403 if the caller is not the assigned engineer", async () => {
    mockFindById.mockResolvedValue({ ...baseJob, assignedEngineerId: OTHER_ENG });
    await expect(startJobForEngineer(JOB_ID, ENG_ID, { email: "wm@x.com" } as never)).rejects.toThrow(/not assigned|isn't assigned/i);
  });

  it("throws 409 if the job is not in 'accepted' state", async () => {
    mockFindById.mockResolvedValue({ ...baseJob, status: "in_progress" });
    await expect(startJobForEngineer(JOB_ID, ENG_ID, { email: "wm@x.com" } as never)).rejects.toThrow(/can't move/i);
  });

  it("throws 409 on concurrent race (startIfAccepted returns null)", async () => {
    mockFindById.mockResolvedValue(baseJob);
    mockStartIfAccepted.mockResolvedValue(null);
    await expect(startJobForEngineer(JOB_ID, ENG_ID, { email: "wm@x.com" } as never)).rejects.toThrow(/can't be started/i);
  });
});

// ── completeJobForEngineer ────────────────────────────────────────────────────────────────────
describe("completeJobForEngineer", () => {
  it("delegates to recordConsumeAndComplete and returns the completed job", async () => {
    const completedJob = { ...inProgressJob, status: "completed" };
    mockFindById
      .mockResolvedValueOnce(inProgressJob) // pre-check
      .mockResolvedValueOnce(completedJob);  // post-complete read

    const result = await completeJobForEngineer(
      JOB_ID,
      ENG_ID,
      { workSummary: "All done", usedLines: [{ source: "irm", irmItemId: "f".repeat(24), qty: 2 }] },
      { email: "eng@x.com" } as never,
    );
    expect(result.status).toBe("completed");
    expect(mockRecordConsumeAndComplete).toHaveBeenCalledTimes(1);
    // Verify the work summary is passed through.
    expect(mockRecordConsumeAndComplete.mock.calls[0][2]).toBe("All done");
    // usedLines with qty > 0 are passed.
    expect(mockRecordConsumeAndComplete.mock.calls[0][3]).toHaveLength(1);
  });

  it("throws 403 if the caller is not the assigned engineer", async () => {
    mockFindById.mockResolvedValue({ ...inProgressJob, assignedEngineerId: OTHER_ENG });
    await expect(
      completeJobForEngineer(JOB_ID, ENG_ID, { usedLines: [] }, { email: "eng@x.com" } as never),
    ).rejects.toThrow(/not assigned|isn't assigned/i);
  });

  it("throws 409 if the job is not in 'in_progress' state", async () => {
    mockFindById.mockResolvedValue({ ...baseJob, status: "accepted" });
    await expect(
      completeJobForEngineer(JOB_ID, ENG_ID, { usedLines: [] }, { email: "eng@x.com" } as never),
    ).rejects.toThrow(/can't move/i);
  });

  it("filters out usedLines with qty = 0 before passing to recordConsumeAndComplete", async () => {
    const completedJob = { ...inProgressJob, status: "completed" };
    mockFindById
      .mockResolvedValueOnce(inProgressJob)
      .mockResolvedValueOnce(completedJob);

    await completeJobForEngineer(
      JOB_ID,
      ENG_ID,
      { usedLines: [{ source: "irm", irmItemId: "f".repeat(24), qty: 0 }, { source: "irm", irmItemId: "g".repeat(24), qty: 3 }] },
      { email: "eng@x.com" } as never,
    );
    // Only the non-zero line is passed.
    expect(mockRecordConsumeAndComplete.mock.calls[0][3]).toHaveLength(1);
    expect(mockRecordConsumeAndComplete.mock.calls[0][3][0].qty).toBe(3);
  });
});

// ── updateJob: issued kit-line edit rules ──────────────────────────────────────────────────────
const mockMergeKitLines = jobRepo.mergeKitLines as ReturnType<typeof vi.fn>;
const mockUpdate = jobRepo.update as ReturnType<typeof vi.fn>;
const mockGetGoodsStatus = goodsManagementService.getGoodsStatus as ReturnType<typeof vi.fn>;
const mockGetJobKitTallies = goodsManagementService.getJobKitTallies as ReturnType<typeof vi.fn>;

// A live (editable) job with one misc kit line — misc needs no item/warehouse resolution, so
// resolveKitLineRows touches no repositories, keeping these tests focused on the edit rules.
const jobWithMisc = {
  ...baseJob,
  status: "in_progress",
  kitLines: [
    { id: "k1", lineType: "misc", irmItemId: null, customerStockEntryId: null, warehouseId: null, warehouseName: null, warehouseCode: null, qty: 2, itemName: "cable", seCode: null, description: null, notes: null },
  ],
};

describe("updateJob (issued kit-line edit rules)", () => {
  it("rejects reducing the quantity of an already-issued line", async () => {
    mockFindById.mockResolvedValue(jobWithMisc);
    mockGetGoodsStatus.mockResolvedValue("issued");
    mockGetJobKitTallies.mockResolvedValue({ k1: { issued: 2, returned: 0, remaining: 2 } });
    await expect(
      updateJob(JOB_ID, { kitLines: [{ lineType: "misc", itemName: "cable", qty: 1 }] } as never, { email: "a@x.com" } as never),
    ).rejects.toThrow(/only be increased|reduced/i);
    expect(mockMergeKitLines).not.toHaveBeenCalled();
  });

  it("rejects removing (or swapping) an already-issued line", async () => {
    mockFindById.mockResolvedValue(jobWithMisc);
    mockGetGoodsStatus.mockResolvedValue("issued");
    mockGetJobKitTallies.mockResolvedValue({ k1: { issued: 2, returned: 0, remaining: 2 } });
    // Replacing cable with a different misc item = remove cable (issued) + add widget → blocked on the removal.
    await expect(
      updateJob(JOB_ID, { kitLines: [{ lineType: "misc", itemName: "widget", qty: 1 }] } as never, { email: "a@x.com" } as never),
    ).rejects.toThrow(/can't be removed|must stay/i);
    expect(mockMergeKitLines).not.toHaveBeenCalled();
  });

  it("allows increasing the quantity of an already-issued line", async () => {
    mockFindById.mockResolvedValue(jobWithMisc);
    mockGetGoodsStatus.mockResolvedValue("issued");
    mockGetJobKitTallies.mockResolvedValue({ k1: { issued: 2, returned: 0, remaining: 2 } });
    mockMergeKitLines.mockResolvedValue({ ...jobWithMisc, kitLines: [{ ...jobWithMisc.kitLines[0], qty: 5 }] });
    await updateJob(JOB_ID, { kitLines: [{ lineType: "misc", itemName: "cable", qty: 5 }] } as never, { email: "a@x.com" } as never);
    expect(mockMergeKitLines).toHaveBeenCalledTimes(1);
    const changes = mockMergeKitLines.mock.calls[0][1];
    expect(changes.updates).toEqual([expect.objectContaining({ id: "k1", qty: 5 })]);
    expect(changes.deleteIds).toEqual([]);
  });

  it("allows adding a new item after stock has been issued", async () => {
    mockFindById.mockResolvedValue(jobWithMisc);
    mockGetGoodsStatus.mockResolvedValue("issued");
    mockGetJobKitTallies.mockResolvedValue({ k1: { issued: 2, returned: 0, remaining: 2 } });
    mockMergeKitLines.mockResolvedValue(jobWithMisc);
    await updateJob(
      JOB_ID,
      { kitLines: [{ lineType: "misc", itemName: "cable", qty: 2 }, { lineType: "misc", itemName: "widget", qty: 1 }] } as never,
      { email: "a@x.com" } as never,
    );
    expect(mockMergeKitLines).toHaveBeenCalledTimes(1);
    const changes = mockMergeKitLines.mock.calls[0][1];
    expect(changes.creates).toHaveLength(1);
    expect(changes.creates[0].itemName).toBe("widget");
    expect(changes.deleteIds).toEqual([]);
  });

  it("allows reducing/removing freely when no stock has been issued", async () => {
    mockFindById.mockResolvedValue(jobWithMisc);
    mockGetGoodsStatus.mockResolvedValue("not_issued");
    mockMergeKitLines.mockResolvedValue({ ...jobWithMisc, kitLines: [{ ...jobWithMisc.kitLines[0], qty: 1 }] });
    await updateJob(JOB_ID, { kitLines: [{ lineType: "misc", itemName: "cable", qty: 1 }] } as never, { email: "a@x.com" } as never);
    expect(mockMergeKitLines).toHaveBeenCalledTimes(1);
    expect(mockGetJobKitTallies).not.toHaveBeenCalled(); // no tally check needed when nothing issued
  });

  it("does a header-only update (no kit merge) when the kit list is unchanged", async () => {
    mockFindById.mockResolvedValue(jobWithMisc);
    mockUpdate.mockResolvedValue({ ...jobWithMisc, notes: "x" });
    const job = await updateJob(
      JOB_ID,
      { notes: "x", kitLines: [{ lineType: "misc", itemName: "cable", qty: 2 }] } as never,
      { email: "a@x.com" } as never,
    );
    expect(mockMergeKitLines).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(job.notes).toBe("x");
  });
});

describe("updateJob (H1 backend stock cap)", () => {
  const mockBalancePair = inventoryRepo.findBalancePair as ReturnType<typeof vi.fn>;
  const mockIrmFind = irmRepo.findById as ReturnType<typeof vi.fn>;
  const mockWhFind = warehouseRepo.findById as ReturnType<typeof vi.fn>;
  const liveEmptyJob = { ...baseJob, status: "in_progress", kitLines: [] };

  beforeEach(() => {
    mockFindById.mockResolvedValue(liveEmptyJob);
    mockGetGoodsStatus.mockResolvedValue("not_issued");
    mockIrmFind.mockResolvedValue({ id: "i1", name: "CAT6" });
    mockWhFind.mockResolvedValue({ id: "w1", name: "WH1", code: "W1", status: "active" });
    mockMergeKitLines.mockResolvedValue(liveEmptyJob);
  });

  it("rejects adding a kit line that exceeds warehouse stock", async () => {
    mockBalancePair.mockResolvedValue({ quantityOnHand: 5, quantityReserved: 0 });
    await expect(
      updateJob(JOB_ID, { kitLines: [{ lineType: "irm", itemName: "CAT6", irmItemId: "i1", warehouseId: "w1", qty: 10 }] } as never, { email: "a@x.com" } as never),
    ).rejects.toThrow(/only 5 in stock/i);
    expect(mockMergeKitLines).not.toHaveBeenCalled();
  });

  it("allows adding a kit line within warehouse stock", async () => {
    mockBalancePair.mockResolvedValue({ quantityOnHand: 50, quantityReserved: 0 });
    await updateJob(JOB_ID, { kitLines: [{ lineType: "irm", itemName: "CAT6", irmItemId: "i1", warehouseId: "w1", qty: 10 }] } as never, { email: "a@x.com" } as never);
    expect(mockMergeKitLines).toHaveBeenCalledTimes(1);
  });
});

describe("kitLinesChanged", () => {
  const base = { lineType: "irm", irmItemId: "i1", customerStockEntryId: null, warehouseId: "w1", qty: 10, itemName: "CAT6", seCode: null, description: null, notes: null };
  it("is false for identical lists regardless of order", () => {
    const a = [{ ...base }, { ...base, irmItemId: "i2", itemName: "SFP" }];
    const b = [{ ...base, irmItemId: "i2", itemName: "SFP" }, { ...base }];
    expect(kitLinesChanged(a, b)).toBe(false);
  });
  it("is true when a quantity changes", () => {
    expect(kitLinesChanged([{ ...base, qty: 10 }], [{ ...base, qty: 11 }])).toBe(true);
  });
  it("is true when a line is added or removed", () => {
    expect(kitLinesChanged([{ ...base }, { ...base, irmItemId: "i2" }], [{ ...base }])).toBe(true);
  });
  it("is true when the pickup warehouse changes", () => {
    expect(kitLinesChanged([{ ...base, warehouseId: "w1" }], [{ ...base, warehouseId: "w2" }])).toBe(true);
  });
});

// A kit line fulfilled from another engineer's van still carries a warehouse — deriveHomeWarehouse
// assigns a nominal one so leftovers have somewhere to be returned to. Without exposing the van
// source, both kit lists render that warehouse as the PICKUP location ("View pickup address"), which
// sends the engineer to a warehouse for stock another engineer already handed them.
describe("getJob — van-sourced kit lines", () => {
  const mockFindById = jobRepo.findById as ReturnType<typeof vi.fn>;
  const mockTallies = goodsManagementService.getJobKitTallies as ReturnType<typeof vi.fn>;
  const mockGoodsStatus = goodsManagementService.getGoodsStatus as ReturnType<typeof vi.fn>;
  const mockVanSources = transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>;

  const jobRow = () => ({
    id: JOB_ID,
    jobNumber: "JOB-2026-0024",
    name: "Fibre install",
    kitLines: [
      { id: "k1", lineType: "irm", seCode: null, itemName: "Cat6 Cable", description: null, customerStockEntryId: null, irmItemId: "i1", warehouseId: "w1", warehouseName: "London Fulfillment Centre", warehouseCode: "WH-0009", warehouse: null, qty: 4, notes: null },
      { id: "k2", lineType: "irm", seCode: null, itemName: "Patch Panel", description: null, customerStockEntryId: null, irmItemId: "i2", warehouseId: "w1", warehouseName: "London Fulfillment Centre", warehouseCode: "WH-0009", warehouse: null, qty: 3, notes: null },
    ],
    attachments: [],
    createdAt: new Date("2026-07-21T00:00:00Z"),
    updatedAt: new Date("2026-07-21T00:00:00Z"),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(jobRow());
    mockTallies.mockResolvedValue({});
    mockGoodsStatus.mockResolvedValue("partially_issued");
    mockVanSources.mockResolvedValue(new Map());
  });

  it("reports the source engineer on a line handed over from a van", async () => {
    mockVanSources.mockResolvedValue(
      new Map([["k1", [{ transferCode: "ENG-0026", engineerName: "sahul FE", quantity: 4, status: "completed" }]]]),
    );

    const job = await getJob(JOB_ID);
    const k1 = job.kitLines.find((l) => l.id === "k1")!;
    const k2 = job.kitLines.find((l) => l.id === "k2")!;

    expect(k1.vanSources).toEqual([{ transferCode: "ENG-0026", engineerName: "sahul FE", quantity: 4, status: "completed" }]);
    // The warehouse stays put — it's where leftovers go back to, not where this came from.
    expect(k1.warehouseName).toBe("London Fulfillment Centre");
    // A warehouse-collected line must NOT gain a phantom van source.
    expect(k2.vanSources).toEqual([]);
  });

  it("defaults to an empty list when nothing was transferred", async () => {
    const job = await getJob(JOB_ID);
    expect(job.kitLines.every((l) => l.vanSources.length === 0)).toBe(true);
  });
});
