import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused unit tests for the composer item-search: IRM catalogue always, plus the JOB'S OWN customer's
// active in-stock consignment entries when a jobId is given. The service module pulls in a lot of
// cross-module deps at import time, so every one it imports is mocked to a no-op — only irmRepo, jobRepo
// and goodsManagementRepo matter for searchItems.
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/job/job.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/job/job.service.js", () => ({}));
vi.mock("#modules/engineer-transfer/engineer-transfer.service.js", () => ({}));
vi.mock("#modules/irm/irm.repository.js", () => ({ findMany: vi.fn() }));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({ searchActiveCustomerStock: vi.fn() }));
vi.mock("#modules/goods-management/goods-management.service.js", () => ({}));
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({}));
vi.mock("#modules/inventory/inventory.repository.js", () => ({}));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({}));
vi.mock("#modules/engineer-transfer/engineer-transfer.repository.js", () => ({}));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn() }));
vi.mock("../../lib/realtime.js", () => ({ emitToUser: vi.fn(), emitToRoom: vi.fn(), OFFICE_JOBS_ROOM: "office:jobs" }));

import * as jobRepo from "#modules/job/job.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import { searchItems } from "./job-kit-request.service.js";

const JOB_ID = "a".repeat(24);
const CUSTOMER_ID = "c".repeat(24);
const OTHER_CUSTOMER_ID = "d".repeat(24);

const irmRow = () => ({ id: "i".repeat(24), code: "IRM-1", name: "CAT6 Cable", sku: "SKU1", baseUnit: "Box" });
const cseRow = () => ({
  id: "e".repeat(24),
  itemName: "mouse123",
  sku: "M1",
  uom: "Each",
  quantity: 4,
  serialNumber: null,
  warehouseId: "w".repeat(24),
  warehouseName: "Testing Ware",
  warehouseCode: "WH-9",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(irmRepo.findMany).mockResolvedValue([]);
  vi.mocked(goodsManagementRepo.searchActiveCustomerStock).mockResolvedValue([]);
  vi.mocked(jobRepo.findById).mockResolvedValue({ id: JOB_ID, customerId: CUSTOMER_ID } as never);
});

describe("searchItems", () => {
  it("returns nothing for a blank term (never enumerates a catalogue)", async () => {
    const out = await searchItems("   ", JOB_ID);
    expect(out).toEqual([]);
    expect(irmRepo.findMany).not.toHaveBeenCalled();
    expect(goodsManagementRepo.searchActiveCustomerStock).not.toHaveBeenCalled();
  });

  it("searches IRM only when no jobId is given (backward-safe)", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    const out = await searchItems("cat");
    expect(goodsManagementRepo.searchActiveCustomerStock).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "irm", name: "CAT6 Cable" });
  });

  it("merges IRM + the job's customer stock, scoped to the job's customerId", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(goodsManagementRepo.searchActiveCustomerStock).mockResolvedValue([cseRow()] as never);
    const out = await searchItems("mouse", JOB_ID);

    // Customer-stock search must be scoped to the job's OWN customer, never a caller-supplied id.
    expect(goodsManagementRepo.searchActiveCustomerStock).toHaveBeenCalledWith(CUSTOMER_ID, "mouse", 20);
    expect(goodsManagementRepo.searchActiveCustomerStock).not.toHaveBeenCalledWith(OTHER_CUSTOMER_ID, expect.anything(), expect.anything());

    const cse = out.find((o) => o.source === "customer_stock");
    expect(cse).toMatchObject({
      source: "customer_stock",
      customerStockEntryId: cseRow().id,
      name: "mouse123",
      qty: 4,
      warehouseName: "Testing Ware",
      warehouseCode: "WH-9",
    });
  });

  it("stays resilient (IRM only) when the job is missing/soft-deleted", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(jobRepo.findById).mockResolvedValue(null);
    const out = await searchItems("cat", JOB_ID);
    expect(goodsManagementRepo.searchActiveCustomerStock).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("irm");
  });
});
