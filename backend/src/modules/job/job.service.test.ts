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
  findAttachments: vi.fn(),
  addAttachment: vi.fn(),
  setAttachmentInternal: vi.fn(),
  removeAttachment: vi.fn(),
}));
vi.mock("#modules/upload/upload.service.js", () => ({
  claimDeferredUpload: vi.fn(),
  commitAttachment: vi.fn(),
}));
vi.mock("#modules/attachment/attachment.service.js", () => ({ releaseAsset: vi.fn() }));

vi.mock("#modules/goods-management/goods-management.service.js", () => ({
  recordConsumeAndComplete: vi.fn(),
  openReturnsOnCancel: vi.fn(),
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
  emitAttentionChanged: vi.fn(),
  emitToUser: vi.fn(),
  emitToRoom: vi.fn(),
  OFFICE_JOBS_ROOM: "office_jobs",
}));
vi.mock("#modules/customer/customer.repository.js", () => ({
  findById: vi.fn(),
  findProjectById: vi.fn(),
  findSiteById: vi.fn(),
  findStockEntryById: vi.fn(),
  findStockEntryQuantitiesByIds: vi.fn(async () => []),
}));
vi.mock("#modules/supplier/supplier.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/rental-item/rental-item.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/irm/irm.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/purchase-request/purchase-request.repository.js", () => ({ countByJob: vi.fn(async () => 0) }));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({ countByJob: vi.fn(async () => 0), findLiveHiresByRentalItems: vi.fn(async () => []) }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findBalancePair: vi.fn(), findBalancesByItemsAndWarehouses: vi.fn(async () => []) }));
vi.mock("#modules/user/user.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/engineer-transfer/engineer-transfer.repository.js", () => ({ findVanSourcesByKitLines: vi.fn() }));
vi.mock("#modules/engineer-transfer/engineer-transfer.service.js", () => ({ cancelPendingForJob: vi.fn() }));
vi.mock("#modules/job-kit-request/job-kit-request.service.js", () => ({ declinePendingForJob: vi.fn() }));
vi.mock("#modules/email/email.service.js", () => ({ sendTemplatedEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("#modules/role/permissions.js", () => ({ roleGrants: vi.fn().mockReturnValue(false) }));

import * as jobRepo from "./job.repository.js";
import * as goodsManagementService from "#modules/goods-management/goods-management.service.js";
import * as prfRepo from "#modules/purchase-request/purchase-request.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as transferRepo from "#modules/engineer-transfer/engineer-transfer.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as emailService from "#modules/email/email.service.js";
import * as transferService from "#modules/engineer-transfer/engineer-transfer.service.js";
import * as kitRequestService from "#modules/job-kit-request/job-kit-request.service.js";
import * as uploadService from "#modules/upload/upload.service.js";
import { startJobForEngineer, completeJobForEngineer, updateJob, kitLinesChanged, getJob, cancelJob, assignJob, deleteJob } from "./job.service.js";

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
  // A DESTINATION (a site or an address) — updateJob rejects a merged result that has neither, so
  // without this every update test below would fail for a reason unrelated to what it's testing.
  addressLine1: "1 Test Street",
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

const KIT_LINE = { id: "kl1", lineType: "irm", seCode: null, itemName: "Cat6 Cable", description: null, customerStockEntryId: null, irmItemId: "i1", warehouseId: "w1", warehouseName: "London Logistics Hub", warehouseCode: "WH-0005", warehouse: null, qty: 6, notes: null };

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

  it("returns the job ENRICHED with goods tallies (so the Complete form can cap declared usage)", async () => {
    // The started job has a collected kit line — the response must carry issued/remaining, not 0s,
    // or the engineer's Complete form (which caps "used" at `remaining`) is unusable after Start.
    const startedWithKit = { ...inProgressJob, kitLines: [{ id: "k1", lineType: "irm", irmItemId: "f".repeat(24), qty: 5, warehouse: null }] };
    mockFindById.mockResolvedValueOnce(baseJob);
    mockStartIfAccepted.mockResolvedValue(startedWithKit);
    (goodsManagementService.getJobKitTallies as ReturnType<typeof vi.fn>).mockResolvedValue({ k1: { issued: 5, used: 0, returned: 0, remaining: 5 } });
    (goodsManagementService.getGoodsStatus as ReturnType<typeof vi.fn>).mockResolvedValue("issued");
    (transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());

    const result = await startJobForEngineer(JOB_ID, ENG_ID, { email: "wm@x.com" } as never);
    expect(result.kitLines[0]).toMatchObject({ issued: 5, remaining: 5 });
    expect(result.goodsStatus).toBe("issued");
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

// ── updateJob: a job can never be left without a destination ──────────────────────────────────
// createJobSchema enforces "a site OR an address" at the schema level, but an update is a PATCH:
// omitting both keys says nothing about them, so the rule is only decidable against the MERGED
// result. That's why it lives in the service, and why these tests cover the merge — not the schema.
describe("updateJob (destination is mandatory on edit too)", () => {
  const addressOnly = { ...baseJob, status: "in_progress" }; // addressLine1 set, no site
  const siteOnly = { ...baseJob, status: "in_progress", siteId: "f".repeat(24), siteName: "Leeds Basinghall", addressLine1: null };
  const noDestination = { ...baseJob, status: "in_progress", addressLine1: null };

  it("rejects clearing the address when the job has no site to fall back on", async () => {
    mockFindById.mockResolvedValue(addressOnly);
    await expect(updateJob(JOB_ID, { addressLine1: "" } as never, { email: "a@x.com" } as never)).rejects.toThrow(/without a destination/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only address just like a blank one", async () => {
    mockFindById.mockResolvedValue(noDestination);
    await expect(updateJob(JOB_ID, { addressLine1: "   " } as never, { email: "a@x.com" } as never)).rejects.toThrow(/without a destination/i);
  });

  it("rejects ANY edit to a job that already has neither (it must be given one first)", async () => {
    // The patch doesn't touch the destination at all — but the merged result still has none, and a
    // save that leaves the engineer with nowhere to go is exactly what this rule exists to stop.
    mockFindById.mockResolvedValue(noDestination);
    await expect(updateJob(JOB_ID, { notes: "just a note" } as never, { email: "a@x.com" } as never)).rejects.toThrow(/without a destination/i);
  });

  it("allows repairing a destination-less job by supplying an address in the same patch", async () => {
    mockFindById.mockResolvedValue(noDestination);
    mockUpdate.mockResolvedValue({ ...noDestination, addressLine1: "9 New Road" });
    const job = await updateJob(JOB_ID, { addressLine1: "9 New Road" } as never, { email: "a@x.com" } as never);
    expect(job.addressLine1).toBe("9 New Road");
  });

  it("allows clearing the address when the job keeps a site (a site alone IS a destination)", async () => {
    // A customer site's own address fields are optional, so "has a site" is complete on its own —
    // demanding an address here would punish someone who correctly picked an address-less site.
    mockFindById.mockResolvedValue(siteOnly);
    mockUpdate.mockResolvedValue({ ...siteOnly, addressLine1: null });
    await updateJob(JOB_ID, { addressLine1: "" } as never, { email: "a@x.com" } as never);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("leaves an untouched destination alone (a patch that omits both keys still passes)", async () => {
    mockFindById.mockResolvedValue(addressOnly);
    mockUpdate.mockResolvedValue({ ...addressOnly, notes: "x" });
    await updateJob(JOB_ID, { notes: "x" } as never, { email: "a@x.com" } as never);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  // Un-picking a site is now reachable at all (the schema used to swallow "" as "not mentioned").
  // The name has to go with it: siteName holds the CHOSEN site's label, so leaving it behind would
  // show "Leeds Basinghall" next to whatever address replaced it — two places on one job.
  it("clearing the site clears its name too, not just the id", async () => {
    mockFindById.mockResolvedValue(siteOnly);
    mockUpdate.mockResolvedValue({ ...siteOnly, siteId: null, siteName: null, addressLine1: "9 New Road" });
    await updateJob(JOB_ID, { siteId: null, addressLine1: "9 New Road" } as never, { email: "a@x.com" } as never);
    const patch = mockUpdate.mock.calls[0][1];
    expect(patch.siteId).toBeNull();
    expect(patch.siteName).toBeNull();
  });

  it("keeps a manually typed site name when the saved site is un-picked", async () => {
    mockFindById.mockResolvedValue(siteOnly);
    mockUpdate.mockResolvedValue(siteOnly);
    await updateJob(JOB_ID, { siteId: null, siteName: "Unit 4, back yard", addressLine1: "9 New Road" } as never, { email: "a@x.com" } as never);
    const patch = mockUpdate.mock.calls[0][1];
    expect(patch.siteId).toBeNull();
    expect(patch.siteName).toBe("Unit 4, back yard");
  });

  it("refuses to clear the site when nothing else names the destination", async () => {
    mockFindById.mockResolvedValue(siteOnly); // site set, addressLine1 null
    await expect(updateJob(JOB_ID, { siteId: null } as never, { email: "a@x.com" } as never)).rejects.toThrow(/without a destination/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe("updateJob (H1 backend stock cap)", () => {
  // Availability is read for the WHOLE kit list in one query now, so stock is staged as balance
  // ROWS (item + warehouse + qty) rather than a single pair.
  const mockBalances = inventoryRepo.findBalancesByItemsAndWarehouses as ReturnType<typeof vi.fn>;
  const stageStock = (quantityOnHand: number, quantityReserved = 0) =>
    mockBalances.mockResolvedValue([{ irmItemId: "i1", warehouseId: "w1", quantityOnHand, quantityReserved }]);
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
    stageStock(5);
    await expect(
      updateJob(JOB_ID, { kitLines: [{ lineType: "irm", itemName: "CAT6", irmItemId: "i1", warehouseId: "w1", qty: 10 }] } as never, { email: "a@x.com" } as never),
    ).rejects.toThrow(/only 5 in stock/i);
    expect(mockMergeKitLines).not.toHaveBeenCalled();
  });

  it("allows adding a kit line within warehouse stock", async () => {
    stageStock(50);
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


// ── cancelJob / assignJob ─────────────────────────────────────────────────────────────────────
// Cancelling is the moment stock is MOST likely to be stranded: it is reachable from accepted and
// in_progress, and the engineer is still physically holding the kit afterwards. Every exit was shut —
// postReturn refused a cancelled job, the engineer could never complete it (so it never reached
// awaiting_return), and closeReconcile only unlocks from awaiting_return. The kit had nowhere to go,
// while the overdue list chased it forever. Cancelling now OPENS the return instead of blocking it.
describe("cancelJob — cancelling opens the return, it doesn't strand the kit", () => {
  const mockUpdate = jobRepo.update as ReturnType<typeof vi.fn>;
  const mockOpenReturns = goodsManagementService.openReturnsOnCancel as ReturnType<typeof vi.fn>;
  const cancelled = { ...baseJob, status: "cancelled", cancelledAt: new Date(), cancelReason: "customer pulled out" };

  beforeEach(() => {
    mockFindById.mockResolvedValue(baseJob);
    mockUpdate.mockResolvedValue(cancelled);
    mockOpenReturns.mockResolvedValue(undefined);
    (transferService.cancelPendingForJob as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (kitRequestService.declinePendingForJob as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (goodsManagementService.getJobKitTallies as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (goodsManagementService.getGoodsStatus as ReturnType<typeof vi.fn>).mockResolvedValue("awaiting_return");
    (transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
  });

  it("hands the job to goods management so the kit can be scanned back in", async () => {
    await cancelJob(JOB_ID, "customer pulled out");
    expect(mockOpenReturns).toHaveBeenCalledWith(JOB_ID);
  });

  // A pending van handover is another engineer's to-do: "give N units from your van to this job".
  // Cancelling the job doesn't make that stock needed any more, but the request stayed pending — so it
  // sat on the holder's Transfers list forever, and both kit lists kept showing "awaiting handover" as
  // though stock were still on its way to a dead job.
  it("withdraws the pending van handovers other engineers were asked for", async () => {
    await cancelJob(JOB_ID, "customer pulled out");
    expect(transferService.cancelPendingForJob).toHaveBeenCalledWith(JOB_ID, expect.anything());
  });

  it("still cancels when withdrawing a handover fails", async () => {
    (transferService.cancelPendingForJob as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    await expect(cancelJob(JOB_ID, "reason")).resolves.toMatchObject({ status: "cancelled" });
  });

  // Same loose end one queue over: a kit request raised before the cancel stayed pending forever. The
  // planner's Approve on it can't work — appendKitFromRequest refuses a cancelled job — so it sat in
  // the review queue as a permanent 409, and the engineer never learned the answer was no.
  it("declines the kit requests still waiting on this job", async () => {
    await cancelJob(JOB_ID, "customer pulled out");
    expect(kitRequestService.declinePendingForJob).toHaveBeenCalledWith(JOB_ID, expect.anything());
  });

  it("still cancels when declining a kit request fails", async () => {
    (kitRequestService.declinePendingForJob as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    await expect(cancelJob(JOB_ID, "reason")).resolves.toMatchObject({ status: "cancelled" });
  });

  // Best-effort: a summary write must never cost the planner their cancel. The chase list still holds
  // the job either way (findGoodsActiveJobIds keeps cancelled), so the stock stays visible.
  it("still cancels when the goods side fails", async () => {
    mockOpenReturns.mockRejectedValue(new Error("mongo down"));
    await expect(cancelJob(JOB_ID, "reason")).resolves.toMatchObject({ status: "cancelled" });
  });

  // The office job detail puts this response straight into state, so a payload without tallies wiped
  // every Issued / Used / Returned / Remaining column to 0 the instant you confirmed the cancel — and
  // the warehouse split under each item with it. Nothing had moved; the response simply carried the
  // defaults. Same bug on Reassign, which is why assignJob is covered below.
  it("returns the job WITH its goods tallies, not the zeroed defaults", async () => {
    const withKit = { ...baseJob, kitLines: [{ ...KIT_LINE, id: "kl1" }] };
    mockFindById.mockResolvedValue(withKit);
    mockUpdate.mockResolvedValue({ ...withKit, status: "cancelled" });
    (goodsManagementService.getJobKitTallies as ReturnType<typeof vi.fn>).mockResolvedValue({
      kl1: { issued: 3, used: 0, returned: 0, remaining: 3 },
    });
    const job = await cancelJob(JOB_ID, undefined);
    expect(job.kitLines[0]).toMatchObject({ issued: 3, remaining: 3 });
    expect(job.goodsStatus).toBe("awaiting_return");
  });
});

describe("assignJob — reassigning must not wipe the goods columns either", () => {
  it("returns the job WITH its goods tallies", async () => {
    const withKit = { ...baseJob, status: "assigned", kitLines: [{ ...KIT_LINE, id: "kl1" }] };
    mockFindById.mockResolvedValue({ ...baseJob, status: "assigned" });
    (jobRepo.update as ReturnType<typeof vi.fn>).mockResolvedValue(withKit);
    (userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: OTHER_ENG, firstName: "Ann", lastName: "Lee", email: "ann@x.com", status: "active", deletedAt: null, role: { name: "Engineer", canHoldStock: true },
    });
    (goodsManagementService.getJobKitTallies as ReturnType<typeof vi.fn>).mockResolvedValue({
      kl1: { issued: 2, used: 0, returned: 0, remaining: 2 },
    });
    (goodsManagementService.getGoodsStatus as ReturnType<typeof vi.fn>).mockResolvedValue("issued");
    (transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    // resetAllMocks in the global beforeEach drops the module-level default; the assignment email is
    // fire-and-forget, so an unstubbed mock returns undefined and assignJob throws on `.catch`.
    (emailService.sendTemplatedEmail as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const job = await assignJob(JOB_ID, OTHER_ENG);
    expect(job.kitLines[0]).toMatchObject({ issued: 2, remaining: 2 });
  });
});

// A job holding stock must not be deletable, whatever its status.
//
// The bug this locks down: `cancelled` is a deletable status and cancelling has no stock guard, so
// accepted → cancel → delete removed a job with units still out. Every read filters `deletedAt: null`,
// so the job left the goods queue and could never be scanned back or reconciled — and because
// `jobCommittedByEngineer` also skips deleted jobs, those units quietly stopped counting as
// job-committed and became free van stock, walking around the field-return guard that exists to stop
// exactly that. Two real jobs (JOB-2026-0028, JOB-2026-0030) reached that state, 23 units between them.
describe("deleteJob — stock still out blocks deletion", () => {
  const mockSoftDelete = jobRepo.softDelete as ReturnType<typeof vi.fn>;
  const mockTallies = goodsManagementService.getJobKitTallies as ReturnType<typeof vi.fn>;

  const jobWith = (status: string, kitLines: unknown[] = []) => ({ ...baseJob, status, kitLines });
  const tally = (remaining: number) => ({ issued: remaining, used: 0, returned: 0, remaining });

  it("deletes a cancelled job that has nothing out", async () => {
    mockFindById.mockResolvedValue(jobWith("cancelled", [{ ...KIT_LINE, id: "kl1" }]));
    mockTallies.mockResolvedValue({ kl1: tally(0) });
    await deleteJob(JOB_ID);
    expect(mockSoftDelete).toHaveBeenCalledWith(JOB_ID);
  });

  it("deletes a draft job with no kit at all", async () => {
    mockFindById.mockResolvedValue(jobWith("draft"));
    mockTallies.mockResolvedValue({});
    await deleteJob(JOB_ID);
    expect(mockSoftDelete).toHaveBeenCalledWith(JOB_ID);
  });

  // THE regression: this is exactly what happened to JOB-2026-0030.
  it("REFUSES a cancelled job that still has units out, and does not soft-delete", async () => {
    mockFindById.mockResolvedValue(jobWith("cancelled", [{ ...KIT_LINE, id: "kl1" }]));
    mockTallies.mockResolvedValue({ kl1: tally(3) });
    await expect(deleteJob(JOB_ID)).rejects.toThrow(/3 units out with the engineer/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("closes the cancel → delete bypass for every deletable status", async () => {
    for (const status of ["draft", "assigned", "rejected", "cancelled"]) {
      mockSoftDelete.mockClear();
      mockFindById.mockResolvedValue(jobWith(status, [{ ...KIT_LINE, id: "kl1" }]));
      mockTallies.mockResolvedValue({ kl1: tally(2) });
      await expect(deleteJob(JOB_ID)).rejects.toThrow(/out with the engineer/i);
      expect(mockSoftDelete).not.toHaveBeenCalled();
    }
  });

  // A job named on a purchase request or order is a link on that document, and every job read
  // filters `deletedAt` — so deleting it left the request pointing at a record the loader refuses.
  // Same class as the request that kept a "View PO-0051" button for a deleted order.
  describe("a job named on a purchase request or order", () => {
    const mockPrfCount = prfRepo.countByJob as ReturnType<typeof vi.fn>;
    const mockPoCount = poRepo.countByJob as ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockPrfCount.mockResolvedValue(0);
      mockPoCount.mockResolvedValue(0);
    });

    it("REFUSES the delete and names the document kind", async () => {
      mockFindById.mockResolvedValue(jobWith("cancelled"));
      mockTallies.mockResolvedValue({});
      mockPrfCount.mockResolvedValue(1);
      await expect(deleteJob(JOB_ID)).rejects.toThrow(/named on existing purchase requests/i);
      expect(mockSoftDelete).not.toHaveBeenCalled();
    });

    it("checks purchase ORDERS too, not just requests", async () => {
      mockFindById.mockResolvedValue(jobWith("draft"));
      mockTallies.mockResolvedValue({});
      mockPoCount.mockResolvedValue(2);
      await expect(deleteJob(JOB_ID)).rejects.toThrow(/named on existing purchase orders/i);
      expect(mockSoftDelete).not.toHaveBeenCalled();
    });

    it("points at cancel, which is what someone in this position actually wants", async () => {
      mockFindById.mockResolvedValue(jobWith("assigned"));
      mockTallies.mockResolvedValue({});
      mockPrfCount.mockResolvedValue(1);
      await expect(deleteJob(JOB_ID)).rejects.toThrow(/cancel it instead/i);
    });

    it("still deletes a job nothing references", async () => {
      mockFindById.mockResolvedValue(jobWith("cancelled"));
      mockTallies.mockResolvedValue({});
      await deleteJob(JOB_ID);
      expect(mockSoftDelete).toHaveBeenCalledWith(JOB_ID);
    });
  });

  it("sums what is out across several kit lines", async () => {
    mockFindById.mockResolvedValue(jobWith("cancelled", [{ ...KIT_LINE, id: "kl1" }, { ...KIT_LINE, id: "kl2" }]));
    mockTallies.mockResolvedValue({ kl1: tally(3), kl2: tally(7) });
    await expect(deleteJob(JOB_ID)).rejects.toThrow(/10 units/);
  });

  it("says \"1 unit\", not \"1 units\"", async () => {
    mockFindById.mockResolvedValue(jobWith("cancelled", [{ ...KIT_LINE, id: "kl1" }]));
    mockTallies.mockResolvedValue({ kl1: tally(1) });
    await expect(deleteJob(JOB_ID)).rejects.toThrow(/1 unit out/);
  });

  // Misc is free text, handed over by count and never stock-tracked, so it can never be returned. If it
  // counted here, a job carrying one would be undeletable for ever with no action that could clear it.
  it("ignores a misc line that can never be returned", async () => {
    mockFindById.mockResolvedValue(jobWith("cancelled", [
      { ...KIT_LINE, id: "kl1", lineType: "misc", irmItemId: null, warehouseId: null },
    ]));
    mockTallies.mockResolvedValue({ kl1: tally(5) });
    await deleteJob(JOB_ID);
    expect(mockSoftDelete).toHaveBeenCalledWith(JOB_ID);
  });

  // The guard already holds the whole job. Letting getJobKitTallies fall back to its own findById
  // costs a second full `withRelations` load — every kit line's irmItem join plus each pickup
  // warehouse's address block — to read one scalar and four fields per line. getJobForCustomer takes
  // the prefetch path for exactly this reason; the delete path should not be the one that doesn't.
  it("tallies from the job it already loaded instead of fetching it a second time", async () => {
    const kitLines = [{ ...KIT_LINE, id: "kl1" }];
    mockFindById.mockResolvedValue(jobWith("cancelled", kitLines));
    mockTallies.mockResolvedValue({ kl1: tally(0) });
    await deleteJob(JOB_ID);
    expect(mockFindById).toHaveBeenCalledTimes(1);
    expect(mockTallies).toHaveBeenCalledWith(JOB_ID, { assignedEngineerId: ENG_ID, kitLines });
  });

  // The pre-existing status rule still stands, and must fail BEFORE the tally lookup.
  it("still refuses a live job outright", async () => {
    mockFindById.mockResolvedValue(jobWith("in_progress", [{ ...KIT_LINE, id: "kl1" }]));
    await expect(deleteJob(JOB_ID)).rejects.toThrow(/can't be deleted/i);
    expect(mockTallies).not.toHaveBeenCalled();
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });
});

// ── Retiring the legacy attachment array ────────────────────────────────────────────────────────
//
// A job's files live in JobAttachment ROWS now; `Job.attachments` is a legacy `String[]` that is
// still read for pre-migration jobs. An edit that carries attachments migrates the URLs into rows
// and retires the array — and the ORDER of those two writes is the whole safety property, because
// they are separate writes with no transaction spanning them.
//
// Clearing the array in the header write and converting afterwards means a failure part-way through
// the conversion leaves the URLs in neither place: the array is already empty, and only some of the
// rows exist. Nothing else holds them. Doing it the other way round costs nothing — the DTO
// concatenates legacy strings and rows, so the worst case is a URL listed twice until the next
// successful save, against a URL lost for good.
describe("updateJob — retiring the legacy attachment array", () => {
  const legacy = { ...baseJob, status: "in_progress", attachments: ["https://cdn.x/a.pdf", "https://cdn.x/b.pdf"] };

  beforeEach(() => {
    mockFindById.mockResolvedValue(legacy);
    mockUpdate.mockResolvedValue(legacy);
    vi.mocked(jobRepo.findAttachments).mockResolvedValue([]);
    vi.mocked(uploadService.claimDeferredUpload).mockResolvedValue(null as never);
    vi.mocked(jobRepo.addAttachment).mockResolvedValue({} as never);
  });

  it("does not clear the array in the same write that precedes the conversion", async () => {
    await updateJob(JOB_ID, { attachments: legacy.attachments } as never, { email: "a@x.com" } as never);
    // The FIRST write is the header. It must not be the one that empties the array.
    expect(mockUpdate.mock.calls[0]![1]).not.toMatchObject({ attachments: [] });
  });

  it("retires the array once every URL has a row", async () => {
    await updateJob(JOB_ID, { attachments: legacy.attachments } as never, { email: "a@x.com" } as never);
    expect(vi.mocked(jobRepo.addAttachment)).toHaveBeenCalledTimes(2);
    expect(mockUpdate.mock.calls.some((c) => (c[1] as { attachments?: string[] }).attachments?.length === 0)).toBe(true);
  });

  it("leaves the array standing when the conversion fails part-way", async () => {
    vi.mocked(jobRepo.addAttachment)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error("write failed"));
    await expect(
      updateJob(JOB_ID, { attachments: legacy.attachments } as never, { email: "a@x.com" } as never),
    ).rejects.toThrow(/write failed/i);
    // Nothing emptied it, so the second URL is still recorded somewhere and a retry can finish.
    expect(mockUpdate.mock.calls.every((c) => (c[1] as { attachments?: string[] }).attachments === undefined)).toBe(true);
  });
});
