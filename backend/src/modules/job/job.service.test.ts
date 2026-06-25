import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────────────────────────
vi.mock("./job.repository.js", () => ({
  findById: vi.fn(),
  findByIdForEngineer: vi.fn(),
  findManyByEngineer: vi.fn(),
  startIfAccepted: vi.fn(),
  completeIfInProgressTx: vi.fn(),
  acceptIfAssigned: vi.fn(),
  rejectIfAssigned: vi.fn(),
  update: vi.fn(),
  createWithCode: vi.fn(),
  replaceKitLines: vi.fn(),
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
vi.mock("#modules/user/user.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/email/email.service.js", () => ({ sendTemplatedEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("#modules/role/permissions.js", () => ({ roleGrants: vi.fn().mockReturnValue(false) }));

import * as jobRepo from "./job.repository.js";
import * as goodsManagementService from "#modules/goods-management/goods-management.service.js";
import { startJobForEngineer, completeJobForEngineer } from "./job.service.js";

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
  address: null,
  postcode: null,
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
