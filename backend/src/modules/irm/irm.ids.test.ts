import { beforeEach, describe, expect, it, vi } from "vitest";

// listIrmItems is exercised below for its PAGING rule alone, so the repository is stubbed down to
// the two reads that rule depends on. Everything else in this file is pure.
vi.mock("./irm.repository.js", () => ({
  count: vi.fn(async () => 0),
  findMany: vi.fn(async () => []),
}));

import * as irmRepo from "./irm.repository.js";
import { IRM_PICKER_PERMISSIONS, MAX_IRM_IDS, canReadIrmCost, exportIrmItemsCsv, listIrmItems, sanitiseIrmIds } from "./irm.service.js";

const oid = (n: number) => n.toString(16).padStart(24, "0");

describe("sanitiseIrmIds", () => {
  it("keeps well-formed ObjectIds", () => {
    expect(sanitiseIrmIds([oid(1), oid(2)])).toEqual([oid(1), oid(2)]);
  });

  it("accepts either case, the way Mongo hex is written", () => {
    const upper = "AABBCCDDEEFF001122334455";
    expect(sanitiseIrmIds([upper])).toEqual([upper]);
  });

  // A malformed id reaching Prisma's `in` throws P2023 — a 500 on a query the caller could not
  // have known was bad. Dropped here instead.
  it("drops anything that is not an ObjectId", () => {
    expect(sanitiseIrmIds(["", "abc", "../../etc/passwd", "0".repeat(23), "0".repeat(25), "zz" + "0".repeat(22)])).toEqual([]);
  });

  it("de-duplicates so a repeated id is asked for once", () => {
    expect(sanitiseIrmIds([oid(1), oid(1), oid(2)])).toEqual([oid(1), oid(2)]);
  });

  it("bounds the list so one request cannot sweep the catalogue", () => {
    const many = Array.from({ length: MAX_IRM_IDS + 50 }, (_, i) => oid(i + 1));
    expect(sanitiseIrmIds(many)).toHaveLength(MAX_IRM_IDS);
  });

  /**
   * The load-bearing case. An empty array becomes `id: { in: [] }`, which matches nothing —
   * whereas `undefined` would DROP the filter and answer a lookup for entirely bogus ids with the
   * whole first page of the catalogue. "I asked for nothing valid" must return nothing.
   */
  it("returns an empty list — never undefined — when nothing valid was asked for", () => {
    const out = sanitiseIrmIds(["nonsense"]);
    expect(out).toEqual([]);
    expect(out).not.toBeUndefined();
  });
});

/**
 * An id lookup asks for a KNOWN, bounded set of rows, and must come back with all of them.
 *
 * `paginate` caps an ordinary list request at 100, which is right for browsing and silently wrong
 * here: a caller resolving 150 saved lines got 100 rows and no indication that 50 were missing. In
 * GoodsReceiptForm that meant the overflow items were treated as neither serial- nor batch-tracked,
 * so the receipt never asked for their serial numbers — a silent wrong answer, not a short page.
 */
describe("listIrmItems paging for an id lookup", () => {
  beforeEach(() => {
    vi.mocked(irmRepo.count).mockResolvedValue(500);
    vi.mocked(irmRepo.findMany).mockResolvedValue([]);
  });

  it("lets an id lookup ask for the whole bounded set, past the ordinary 100 cap", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => oid(i + 1));
    const page = await listIrmItems({ ids, pageSize: ids.length });
    expect(page.pageSize).toBe(150);
    expect(vi.mocked(irmRepo.findMany).mock.calls[0][2]).toBe(150);
  });

  it("never lets one lookup exceed the sanitiser's own bound", async () => {
    const ids = Array.from({ length: MAX_IRM_IDS + 100 }, (_, i) => oid(i + 1));
    const page = await listIrmItems({ ids, pageSize: ids.length });
    expect(page.pageSize).toBe(MAX_IRM_IDS);
  });

  // The widened cap belongs to the id lookup, not to the list. A plain browse asking for 150 rows
  // is still a browse, and still clamped.
  it("leaves an ordinary list request clamped at 100", async () => {
    const page = await listIrmItems({ search: "cable", pageSize: 150 });
    expect(page.pageSize).toBe(100);
  });
});

/**
 * Reading the CATALOGUE and reading what it COST are two different things, and this changeset made
 * them one for the first time.
 *
 * The list route is now wider than `irm.view`, for the same reason `/rental-items` and
 * `/suppliers/options` are: a planner who may build a job kit, or a purchaser who may raise a
 * request, has to be able to pick an item, and a role built in Users & Roles from the jobs
 * capability alone holds neither `irm.view` nor `rentals.view`. Their picker was silently empty.
 *
 * But unlike the rental catalogue, whose public shape carries no commercial data at all, an IRM item
 * carries `standardCost` and `totalValuePence`. Widening the route without this would have handed
 * item costs to every role that can open the job form — a new exposure dressed up as a bug fix. The
 * cost fields therefore ride on a SECOND check, and only the callers that already see cost on the
 * document they are filling in (a purchase request, an order) keep them.
 */
describe("canReadIrmCost", () => {
  it("lets the catalogue's own readers see cost", () => {
    expect(canReadIrmCost(["irm.view"])).toBe(true);
  });

  it("lets a purchaser see cost — the PRF line they are filling in prices the item anyway", () => {
    expect(canReadIrmCost(["purchase_requests.create"])).toBe(true);
    expect(canReadIrmCost(["purchase_orders.edit"])).toBe(true);
    expect(canReadIrmCost(["goods_in.create"])).toBe(true);
  });

  it("does NOT give cost to a job planner who was never granted the catalogue", () => {
    expect(canReadIrmCost(["jobs.create", "jobs.edit"])).toBe(false);
  });

  it("honours the wildcard", () => {
    expect(canReadIrmCost(["*"])).toBe(true);
  });

  it("gives nothing to a caller holding none of them", () => {
    expect(canReadIrmCost([])).toBe(false);
    expect(canReadIrmCost(["customers.view"])).toBe(false);
  });

  // The route's own permission list must admit everyone the picker is for; a key present on one
  // and absent from the other is a dropdown that 403s or a cost field with no reader.
  it("opens the picker to every caller the forms need", () => {
    for (const key of ["irm.view", "purchase_requests.create", "jobs.create", "jobs.edit", "goods_in.create"]) {
      expect(IRM_PICKER_PERMISSIONS).toContain(key);
    }
  });
});

describe("listIrmItems cost redaction", () => {
  const row = {
    id: oid(1), code: "IRM-0001", name: "Cable", description: null, brand: null, manufacturer: null, mpn: null,
    typeId: null, irmCategoryId: null, status: "active", sku: null, barcode: null, qrCode: null, barcodeDataUri: null,
    baseUnit: null, packSize: null, reorderLevel: null, maximumStock: null, criticalLevel: null,
    standardCostPence: 12345, currency: "GBP", vatRatePercent: 20,
    trackInventory: true, notes: null,
    createdBy: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(),
    type: null, irmCategory: null, suppliers: [],
  };

  beforeEach(() => {
    vi.mocked(irmRepo.count).mockResolvedValue(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a shaped row is enough for toPublic.
    vi.mocked(irmRepo.findMany).mockResolvedValue([row] as any);
  });

  it("returns cost to a caller allowed to see it", async () => {
    const page = await listIrmItems({});
    expect(page.items[0].standardCost).toBe(123.45);
    expect(page.items[0].standardCostPence).toBe(12345);
  });

  it("blanks cost — never zeroes it — for a caller who is not", async () => {
    const page = await listIrmItems({ includeCost: false });
    // NULL, not 0: a zero is a real price a buyer could read as "this item is free".
    expect(page.items[0].standardCost).toBeNull();
    expect(page.items[0].standardCostPence).toBeNull();
  });

  it("still returns everything the picker actually needs", async () => {
    const page = await listIrmItems({ includeCost: false });
    expect(page.items[0].code).toBe("IRM-0001");
    expect(page.items[0].name).toBe("Cable");
    expect(page.items[0].trackInventory).toBe(true);
  });
});

/**
 * The CSV export shares `listParamsFrom` with the list route, so the cost flag reaches it too — and
 * it must NOT act there.
 *
 * The export has its own dedicated permission (`irm.export`), granted deliberately over this
 * catalogue; it was never part of the picker widening and its behaviour must be exactly what it was
 * before. Letting the flag through would hand an exporter a file with a silently blank "Standard
 * Cost" column and nothing to say the figure was withheld rather than absent — the same
 * short-answer-with-no-warning failure this whole pass exists to remove.
 */
describe("exportIrmItemsCsv", () => {
  beforeEach(() => {
    vi.mocked(irmRepo.count).mockResolvedValue(1);
    vi.mocked(irmRepo.findMany).mockResolvedValue([
      {
        id: oid(1), code: "IRM-0001", name: "Cable", description: null, brand: null, manufacturer: null, mpn: null,
        typeId: null, irmCategoryId: null, status: "active", sku: null, barcode: null, qrCode: null, barcodeDataUri: null,
        baseUnit: null, packSize: null, reorderLevel: null, maximumStock: null, criticalLevel: null,
        standardCostPence: 12345, currency: "GBP", vatRatePercent: 20,
        trackInventory: true, notes: null,
        createdBy: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(),
        type: null, irmCategory: null, suppliers: [],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a shaped row is enough for toPublic.
    ] as any);
  });

  it("still writes the cost column when the caller's list flag says otherwise", async () => {
    const { csv } = await exportIrmItemsCsv({ includeCost: false });
    expect(csv).toContain("123.45");
  });
});
