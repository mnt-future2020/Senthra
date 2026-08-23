import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#modules/engineer-rental/engineer-rental.repository.js", () => ({ countHeldRentalsByRentalItem: vi.fn(async () => 0) }));
vi.mock("./rental-item.repository.js", () => ({
  findMany: vi.fn(),
  findById: vi.fn(),
  findByCode: vi.fn(),
  findActiveByIds: vi.fn(),
  createWithCode: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  countByPrfLines: vi.fn(),
  countByPoLines: vi.fn(),
  countByJobKitLines: vi.fn(async () => 0),
}));
vi.mock("#modules/rental-category/rental-category.service.js", () => ({
  requireActiveRentalCategory: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getRentalCodePrefix: vi.fn() }));

import * as rentalRepo from "./rental-item.repository.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import { requireActiveRentalCategory } from "#modules/rental-category/rental-category.service.js";
import { getRentalCodePrefix } from "#modules/settings/settings.service.js";
import {
  createRentalItem,
  deleteRentalItem,
  exportRentalItemsCsv,
  renderBarcode,
  requireActiveRentalItems,
  updateRentalItem,
} from "./rental-item.service.js";

const CATEGORY_ID = "6a1d7f5bfa7d25704f02b963";
const ACTOR = { type: "user" as const, id: "u1", email: "buyer@x.co", permissions: [] };

const findById = vi.mocked(rentalRepo.findById);
const createWithCode = vi.mocked(rentalRepo.createWithCode);
const update = vi.mocked(rentalRepo.update);
const softDelete = vi.mocked(rentalRepo.softDelete);
const countByPrfLines = vi.mocked(rentalRepo.countByPrfLines);
const countByPoLines = vi.mocked(rentalRepo.countByPoLines);
const countByJobKitLines = vi.mocked(rentalRepo.countByJobKitLines);
const countHeldRentals = vi.mocked(rentalCustodyRepo.countHeldRentalsByRentalItem);
const findActiveByIds = vi.mocked(rentalRepo.findActiveByIds);
const requireCategory = vi.mocked(requireActiveRentalCategory);
const rentalCodePrefix = vi.mocked(getRentalCodePrefix);

const row = (over: Record<string, unknown> = {}) =>
  ({
    id: "r1",
    code: "RNT-0001",
    name: "Fibre Tester",
    description: null,
    status: "active",
    rentalCategoryId: CATEGORY_ID,
    rentalCategory: { id: CATEGORY_ID, name: "Test Equipment" },
    baseUnit: "Each",
    notes: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-08-01"),
    updatedAt: new Date("2026-08-01"),
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  requireCategory.mockResolvedValue({ id: CATEGORY_ID, status: "active" } as never);
  createWithCode.mockResolvedValue(row());
  update.mockResolvedValue(row());
  findById.mockResolvedValue(row());
  softDelete.mockResolvedValue(row());
});

describe("createRentalItem", () => {
  it("stores the item and returns its allocated code", async () => {
    const r = await createRentalItem({ name: " Fibre Tester ", rentalCategoryId: CATEGORY_ID, baseUnit: "Each" }, ACTOR);
    expect(createWithCode.mock.calls[0]![0]).toMatchObject({ name: "Fibre Tester" });
    expect(r.code).toBe("RNT-0001");
  });

  it("refuses an inactive category", async () => {
    requireCategory.mockRejectedValue(new Error("Selected rental category is inactive."));
    await expect(
      createRentalItem({ name: "X", rentalCategoryId: CATEGORY_ID, baseUnit: "Each" }, ACTOR),
    ).rejects.toThrow(/inactive/i);
    expect(createWithCode).not.toHaveBeenCalled();
  });

  // The master answers "what can be hired", never "what does it cost" — price, VAT and currency
  // are negotiated per hire and live on the PRF line. A rate here would be a second, staler answer.
  it("stores no pricing of any kind", async () => {
    await createRentalItem({ name: "X", rentalCategoryId: CATEGORY_ID, baseUnit: "Each" }, ACTOR);
    const written = createWithCode.mock.calls[0]![0] as Record<string, unknown>;
    for (const field of ["standardHireRatePence", "hireRatePeriod", "currency", "vatRatePercent"]) {
      expect(written[field], `${field} must not reach the rental master`).toBeUndefined();
    }
  });
});

describe("updateRentalItem", () => {
  // Re-checking only on CHANGE keeps an item editable after its category was later deactivated —
  // otherwise a rename would be blocked by an unrelated field.
  it("re-checks the category only when it actually changes", async () => {
    await updateRentalItem("r1", { name: "New name" }, ACTOR);
    expect(requireCategory).not.toHaveBeenCalled();

    await updateRentalItem("r1", { rentalCategoryId: "6a1d7f5bfa7d25704f02b999" }, ACTOR);
    expect(requireCategory).toHaveBeenCalledWith("6a1d7f5bfa7d25704f02b999");
  });

  it("refuses an item that does not exist", async () => {
    findById.mockResolvedValue(null);
    await expect(updateRentalItem("nope", { name: "X" }, ACTOR)).rejects.toThrow(/not found/i);
  });
});

describe("deleteRentalItem", () => {
  it("refuses an item referenced by a purchase request line", async () => {
    countByPrfLines.mockResolvedValue(1);
    countByPoLines.mockResolvedValue(0);
    await expect(deleteRentalItem("r1", ACTOR)).rejects.toThrow(/in use by existing purchase requests/i);
    expect(softDelete).not.toHaveBeenCalled();
  });

  it("refuses an item referenced by a purchase order line", async () => {
    countByPrfLines.mockResolvedValue(0);
    countByPoLines.mockResolvedValue(2);
    await expect(deleteRentalItem("r1", ACTOR)).rejects.toThrow(/in use by existing purchase orders/i);
    expect(softDelete).not.toHaveBeenCalled();
  });

  // Both guards below arrived with hired kit on jobs. Without them a rental item could be retired out
  // from under live work — a kit list left naming a catalogue entry no picker shows any more, or an
  // engineer still physically carrying one.
  it("refuses an item still on a live job's kit list", async () => {
    countByPrfLines.mockResolvedValue(0);
    countByPoLines.mockResolvedValue(0);
    countByJobKitLines.mockResolvedValue(1);
    await expect(deleteRentalItem("r1", ACTOR)).rejects.toThrow(/in use by existing job kit lists/i);
    expect(softDelete).not.toHaveBeenCalled();
  });

  it("refuses an item an engineer is still holding", async () => {
    countByPrfLines.mockResolvedValue(0);
    countByPoLines.mockResolvedValue(0);
    countByJobKitLines.mockResolvedValue(0);
    countHeldRentals.mockResolvedValue(1);
    await expect(deleteRentalItem("r1", ACTOR)).rejects.toThrow(/engineer-held hires/i);
    expect(softDelete).not.toHaveBeenCalled();
  });

  it("soft-deletes when nothing references it", async () => {
    countByPrfLines.mockResolvedValue(0);
    countByPoLines.mockResolvedValue(0);
    countByJobKitLines.mockResolvedValue(0);
    countHeldRentals.mockResolvedValue(0);
    await deleteRentalItem("r1", ACTOR);
    expect(softDelete).toHaveBeenCalledWith("r1", ACTOR.email);
  });
});

describe("requireActiveRentalItems", () => {
  it("passes when every id resolves to a live active item", async () => {
    findActiveByIds.mockResolvedValue([{ id: "a" }, { id: "b" }] as never);
    await expect(requireActiveRentalItems(["a", "b"])).resolves.toBeUndefined();
  });

  it("refuses when one was retired while the request waited", async () => {
    findActiveByIds.mockResolvedValue([{ id: "a" }] as never);
    await expect(requireActiveRentalItems(["a", "b"])).rejects.toThrow(/no longer active/i);
  });

  // Duplicates must not make the count disagree with itself — the same item twice on one request
  // is legitimate (different periods), and it is still ONE item to check.
  it("counts a repeated id once", async () => {
    findActiveByIds.mockResolvedValue([{ id: "a" }] as never);
    await expect(requireActiveRentalItems(["a", "a"])).resolves.toBeUndefined();
    expect(findActiveByIds).toHaveBeenCalledWith(["a"]);
  });

  it("does nothing at all for an empty list", async () => {
    await expect(requireActiveRentalItems([])).resolves.toBeUndefined();
    expect(findActiveByIds).not.toHaveBeenCalled();
  });
});


// Hired kit arrives at our warehouse and gets a sticker. The label is Code128 of the item's permanent
// code and is rendered on read, so there is no image column, no "generate it first" step, and no
// backfill for rows that existed before the feature — the tests below are what pins that.
describe("renderBarcode", () => {
  const findByCode = vi.mocked(rentalRepo.findByCode);

  it("renders a PNG data URI for the item's code", async () => {
    findById.mockResolvedValue(row() as never);
    const r = await renderBarcode("6a1d7f5bfa7d25704f02b111");
    expect(r.code).toBe("RNT-0001");
    expect(r.barcodeDataUri.startsWith("data:image/png;base64,")).toBe(true);
    // Long enough to be an actual barcode rather than an empty buffer.
    expect(r.barcodeDataUri.length).toBeGreaterThan(200);
  });

  // A row that has existed since before this feature is indistinguishable from one added today:
  // both have a code, and the code is all the label needs.
  it("needs nothing on the record but its code — no stored image, no backfill", async () => {
    findById.mockResolvedValue(row({ code: "RNT-0002" }) as never);
    await expect(renderBarcode("6a1d7f5bfa7d25704f02b111")).resolves.toMatchObject({ code: "RNT-0002" });
    // Nothing was written: rendering is a read.
    expect(update).not.toHaveBeenCalled();
  });

  it("accepts a code as well as an id, like every other rental-item read", async () => {
    findByCode.mockResolvedValue(row() as never);
    await expect(renderBarcode("RNT-0001")).resolves.toMatchObject({ code: "RNT-0001" });
    expect(findByCode).toHaveBeenCalledWith("RNT-0001");
    expect(findById).not.toHaveBeenCalled();
  });

  it("404s for an item that does not exist", async () => {
    findById.mockResolvedValue(null as never);
    await expect(renderBarcode("6a1d7f5bfa7d25704f02b111")).rejects.toThrow(/not found/i);
  });

  // The same code must always produce the same sticker — a label printed a year ago has to scan
  // against the one printed today. Keyed on the code, which is allocated once and never freed, so a
  // cache hit can never be stale.
  it("returns a byte-identical image for the same code", async () => {
    findById.mockResolvedValue(row({ code: "RNT-0009" }) as never);
    const first = await renderBarcode("6a1d7f5bfa7d25704f02b111");
    const second = await renderBarcode("6a1d7f5bfa7d25704f02b111");
    expect(second.barcodeDataUri).toBe(first.barcodeDataUri);
  });

  it("gives different codes different images", async () => {
    findById.mockResolvedValue(row({ code: "RNT-0100" }) as never);
    const a = await renderBarcode("6a1d7f5bfa7d25704f02b111");
    findById.mockResolvedValue(row({ code: "RNT-0200" }) as never);
    const b = await renderBarcode("6a1d7f5bfa7d25704f02b111");
    expect(b.barcodeDataUri).not.toBe(a.barcodeDataUri);
  });
});


// The DISPLAY prefix is configurable in Settings → Branding; the numeric sequence is not. The service
// resolves the prefix and hands it to the repository, which owns the counter.
describe("createRentalItem — the configured code prefix", () => {
  it("passes the configured prefix to the allocator", async () => {
    rentalCodePrefix.mockResolvedValue("EQP");
    createWithCode.mockResolvedValue(row({ code: "EQP-0011" }) as never);
    await createRentalItem({ name: "Fibre Tester", rentalCategoryId: CATEGORY_ID, baseUnit: "Each" } as never, ACTOR);
    expect(createWithCode).toHaveBeenCalledWith(expect.objectContaining({ name: "Fibre Tester" }), "EQP");
  });

  it("resolves the prefix at CREATE time, not from the row", async () => {
    rentalCodePrefix.mockResolvedValue("RNT");
    createWithCode.mockResolvedValue(row() as never);
    await createRentalItem({ name: "Splicer", rentalCategoryId: CATEGORY_ID, baseUnit: "Each" } as never, ACTOR);
    expect(rentalCodePrefix).toHaveBeenCalled();
  });
});

// A download taken from the catalogue holds the catalogue. listRentalItems caps a page at 200 for
// anything a client asks for, and the export could not lift that cap — so it asked for 5,000 rows,
// silently received 200, and a 1,000-item catalogue downloaded as 200 rows under a header that gave
// no sign of it. The shared EXPORT_PAGING exists so no export has to remember this.
describe("exportRentalItemsCsv", () => {
  it("asks for the whole filtered catalogue, not one clamped page", async () => {
    vi.mocked(rentalRepo.findMany).mockResolvedValue({ items: [], total: 0 } as never);
    await exportRentalItemsCsv({ page: 3, pageSize: 20 }, ACTOR);
    expect(vi.mocked(rentalRepo.findMany).mock.calls[0]![0].pageSize).toBeGreaterThan(200);
  });
});
