import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#modules/rental-item/rental-item.service.js", () => ({
  requireActiveRentalItems: vi.fn(),
  getRentalItemsByIds: vi.fn(),
}));

import * as rentalItemService from "#modules/rental-item/rental-item.service.js";
import { rentalLineSchema } from "./rentalLine.validation.js";
import { agreedUnitPricePence, buildRentalLineRows, committedHireRow, hireLineUntouched } from "./rentalLine.rows.js";

const RNT_ID = "6a1d7f5bfa7d25704f02b963";
const RNT_ID_2 = "6a1d7f5bfa7d25704f02b964";
const RNT_ID_3 = "6a1d7f5bfa7d25704f02b965";

const mockRequire = rentalItemService.requireActiveRentalItems as ReturnType<typeof vi.fn>;
const mockLookup = rentalItemService.getRentalItemsByIds as ReturnType<typeof vi.fn>;

// Through the schema, exactly as the service receives it: dates as UTC-midnight Dates, defaults
// left absent so the builder — not the fixture — is what fills them in.
const parsed = (over: Record<string, unknown> = {}) =>
  rentalLineSchema.parse({
    rentalItemId: RNT_ID,
    quantity: 2,
    hireStartDate: "2026-09-01",
    hireEndDate: "2026-10-01",
    unitPricePence: 15000,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  // The guard RETURNS the rows it validated — that is what the builder snapshots from.
  mockRequire.mockImplementation((ids: string[]) =>
    Promise.resolve(new Map(ids.map((id) => [id, { name: `Tester ${id.slice(-1)}`, baseUnit: "Each" }]))),
  );
  mockLookup.mockResolvedValue(new Map());
});

describe("buildRentalLineRows — the shared builder", () => {
  it("snapshots the catalogue item's name and unit, and files the sent price on the total basis", async () => {
    const [row] = await buildRentalLineRows([parsed()]);
    expect(row).toMatchObject({
      rentalItemId: RNT_ID,
      itemName: "Tester 3",
      baseUnit: "Each",
      quantity: 2,
      notifyDaysBefore: 3,
      deliveryAddress: null,
      ratePeriod: "total",
      ratePence: null,
      priceOverridden: false,
      returnMode: "delivery",
      returnAddress: null,
      unitPricePence: 15000,
      vatRate: 0,
      lineTotalPence: 30000,
      sortOrder: 0,
      notes: null,
    });
  });

  it("decides the money itself on a rate basis — £55/day × 30 days, whatever price was sent", async () => {
    const [row] = await buildRentalLineRows([parsed({ ratePeriod: "day", ratePence: 5500, unitPricePence: 1 })]);
    expect(row!.unitPricePence).toBe(5500 * 30);
    expect(row!.lineTotalPence).toBe(5500 * 30 * 2);
    expect(row!.ratePence).toBe(5500);
    expect(row!.priceOverridden).toBe(false);
  });

  it("keeps a deliberately overridden price, with the rate still on the line to show the gap", async () => {
    const [row] = await buildRentalLineRows([
      parsed({ ratePeriod: "day", ratePence: 5500, unitPricePence: 150000, priceOverridden: true }),
    ]);
    expect(row!.unitPricePence).toBe(150000);
    expect(row!.ratePence).toBe(5500);
    expect(row!.priceOverridden).toBe(true);
  });

  it("an override means nothing on the total basis — there is no arithmetic to override", async () => {
    const [row] = await buildRentalLineRows([parsed({ priceOverridden: true, ratePence: 5500 })]);
    expect(row!.priceOverridden).toBe(false);
    expect(row!.ratePence).toBeNull();
  });

  it("takes VAT from the LINE with no catalogue fallback, and keeps a collection address only for `other`", async () => {
    const [a, b] = await buildRentalLineRows([
      parsed({ vatRate: 20, returnMode: "warehouse", returnAddress: "typed anyway" }),
      parsed({ hireEndDate: "2026-10-15", returnMode: "other", returnAddress: "Unit 4, Leeds", notes: "  gate code 1234  " }),
    ]);
    expect(a!.vatRate).toBe(20);
    expect(a!.returnAddress).toBeNull();
    expect(b!.returnAddress).toBe("Unit 4, Leeds");
    expect(b!.notes).toBe("gate code 1234");
    expect(b!.sortOrder).toBe(1);
  });

  // The N+1 guard. A document with several hires must cost ONE active-item check and ONE read,
  // not one of each per line.
  it("checks and reads the catalogue ONCE for the whole set, however many lines there are", async () => {
    await buildRentalLineRows([
      parsed(),
      parsed({ rentalItemId: RNT_ID_2 }),
      parsed({ rentalItemId: RNT_ID_3, hireEndDate: "2026-10-15" }),
    ]);
    expect(mockRequire).toHaveBeenCalledTimes(1);
    expect(mockRequire).toHaveBeenCalledWith([RNT_ID, RNT_ID_2, RNT_ID_3]);
    // ONE query, not two: the guard's own result is the snapshot source, so a second identical
    // read would be the same documents fetched twice on every write that carries a hire.
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("refuses an inactive item, so no row is ever built for a retired hire", async () => {
    mockRequire.mockRejectedValue(new Error("One or more rental items are no longer active."));
    await expect(buildRentalLineRows([parsed()])).rejects.toThrow(/no longer active/);
  });

  it("touches nothing for an empty set", async () => {
    expect(await buildRentalLineRows([])).toEqual([]);
    expect(mockRequire).not.toHaveBeenCalled();
  });
});

describe("agreedUnitPricePence", () => {
  const start = new Date("2026-09-01T00:00:00Z");
  const end = new Date("2026-09-11T00:00:00Z"); // 10 days

  it("is the arithmetic on a rate basis, part weeks charged in full", () => {
    expect(agreedUnitPricePence({ ratePeriod: "week", ratePence: 10000, unitPricePence: 1, hireStartDate: start, hireEndDate: end })).toBe(20000);
  });

  it("is the sent figure on the total basis, or when overridden", () => {
    expect(agreedUnitPricePence({ unitPricePence: 777, hireStartDate: start, hireEndDate: end })).toBe(777);
    expect(agreedUnitPricePence({ ratePeriod: "day", ratePence: 100, priceOverridden: true, unitPricePence: 777, hireStartDate: start, hireEndDate: end })).toBe(777);
  });
});

describe("committedHireRow — what a purchase order commits, whichever door the hire came through", () => {
  const requested = {
    rentalItemId: RNT_ID,
    itemName: "Fibre Tester",
    baseUnit: "Each",
    quantity: 2,
    hireStartDate: new Date("2026-09-01T00:00:00Z"),
    hireEndDate: new Date("2026-10-01T00:00:00Z"),
    notifyDaysBefore: 3,
    deliveryAddress: "12 Site Road",
    ratePeriod: "day",
    ratePence: 5500,
    priceOverridden: false,
    returnMode: "other",
    returnAddress: "Unit 4",
    unitPricePence: 165000,
    vatRate: 20,
    lineTotalPence: 330000,
    notes: "gate code",
  };

  it("copies EVERY commercial and logistics field, starts the hire awaiting delivery, and derives the reminder", () => {
    const row = committedHireRow(requested, 4);
    expect(row).toEqual({
      ...requested,
      sortOrder: 4,
      hireStatus: "awaiting_delivery",
      notifyOnDate: new Date("2026-09-28T00:00:00Z"),
    });
  });

  it("clamps the reminder to the start of a short hire rather than before it", () => {
    const row = committedHireRow(
      { ...requested, hireEndDate: new Date("2026-09-03T00:00:00Z"), notifyDaysBefore: 3 },
      0,
    );
    expect(row.notifyOnDate).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  // The parity guard for the two doors. Conversion hands this function a request's STORED line and
  // a direct order hands it a freshly BUILT row; both carry these fields and nothing the other lacks,
  // so the committed row cannot depend on which one it came from.
  it("a freshly built row commits to exactly the same shape as a request's stored line", async () => {
    const [built] = await buildRentalLineRows([parsed({ ratePeriod: "day", ratePence: 5500 })]);
    const { sortOrder: _s, ...asStored } = built!;
    void _s;
    const direct = committedHireRow(built!, 0);
    const viaRequest = committedHireRow(asStored, 0);
    expect(direct).toEqual(viaRequest);
    expect(Object.keys(direct).sort()).toEqual(
      [
        "baseUnit", "deliveryAddress", "hireEndDate", "hireStartDate", "hireStatus", "itemName", "lineTotalPence",
        "notes", "notifyDaysBefore", "notifyOnDate", "priceOverridden", "quantity", "ratePence", "ratePeriod",
        "rentalItemId", "returnAddress", "returnMode", "sortOrder", "unitPricePence", "vatRate",
      ].sort(),
    );
  });
});

describe("hireLineUntouched — may a draft edit rewrite this hire?", () => {
  const fresh = {
    hireStatus: "awaiting_delivery",
    receivedQuantity: 0,
    returnedQuantity: 0,
    issuedQuantity: 0,
    cancelledQuantity: 0,
    lostQuantity: 0,
    extensionChargePence: 0,
  };

  it("yes for a hire nothing has happened to", () => {
    expect(hireLineUntouched(fresh)).toBe(true);
    // A legacy row that predates the awaiting-delivery step is still `on_hire` with nothing received.
    expect(hireLineUntouched({ ...fresh, hireStatus: "on_hire" })).toBe(true);
  });

  it.each([
    ["received", { receivedQuantity: 1 }],
    ["issued to an engineer", { issuedQuantity: 1 }],
    ["returned", { returnedQuantity: 1 }],
    ["closed short", { cancelledQuantity: 1 }],
    ["lost", { lostQuantity: 1 }],
    ["extended", { extensionChargePence: 100 }],
    ["returned (terminal)", { hireStatus: "returned" }],
    ["cancelled (terminal)", { hireStatus: "cancelled" }],
  ])("no once the hire has been %s — its history hangs off the row", (_label, over) => {
    expect(hireLineUntouched({ ...fresh, ...over })).toBe(false);
  });
});
