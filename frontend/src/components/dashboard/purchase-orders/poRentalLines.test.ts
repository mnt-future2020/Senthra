import { describe, expect, it } from "vitest";

import { blankRentalLine, duplicateRentalRowKeys, rentalDeliveryFallback, savedRentalLineRow, validateRentalLines } from "@/components/dashboard/purchase-requests/rentalLineRows";
import type { PoRentalLine } from "@/types/rental";
import { rentalEstimate, rentalRowsChanged, rentalRowsFromOrder, rentalRowsMissingWarehouse, savedRentalEstimate, toSplitRentalPayload } from "./poRentalLines";

const RNT_ID = "6a1d7f5bfa7d25704f02b963";
const WH_ID = "b".repeat(24);
const WH_ID_2 = "e".repeat(24);

// A saved hire exactly as the API returns it on an order — hire state included, none of which may
// leak back into the row.
const savedLine = (over: Partial<PoRentalLine> = {}): PoRentalLine => ({
  id: "rl1",
  rentalItemId: RNT_ID,
  itemName: "Fibre Tester (old name)",
  baseUnit: "Each",
  quantity: 2,
  hireStartDate: "2026-09-01T00:00:00.000Z",
  hireEndDate: "2026-10-01T00:00:00.000Z",
  hireDays: 30,
  notifyDaysBefore: 5,
  notifyOnDate: "2026-09-26T00:00:00.000Z",
  deliveryAddress: "12 Site Road",
  ratePeriod: "day",
  ratePence: 5500,
  priceOverridden: true,
  returnMode: "other",
  returnAddress: "Unit 4",
  deliveryLocation: { label: "This line's address", address: "12 Site Road" },
  returnLocation: { label: "Other address", address: "Unit 4" },
  unitPricePence: 150000,
  unitPrice: 1500,
  vatRate: 20,
  lineTotalPence: 300000,
  lineTotal: 3000,
  notes: "gate code",
  hireStatus: "awaiting_delivery",
  receivedQuantity: 0,
  fullyReceived: false,
  cancelledQuantity: 0,
  shortClosedAt: null,
  shortClosedBy: null,
  shortCloseReason: null,
  returnedQuantity: 0,
  fullyReturned: false,
  damagedQuantity: 0,
  lostQuantity: 0,
  damagedHeldQuantity: 0,
  issuedQuantity: 0,
  receivedAt: null,
  receivedBy: null,
  extensionChargePence: 0,
  extensionCharge: 0,
  extensions: [],
  unexplainedExtensionCharge: 0,
  returnedAt: null,
  returnedBy: null,
  // The catalogue item has since been renamed AND retired: the row must still be the same hire.
  rentalItem: { id: RNT_ID, code: "RNT-0001", name: "Fibre Tester Mk II", status: "inactive" },
  ...over,
});

const filled = (over: Partial<ReturnType<typeof blankRentalLine>> = {}) => ({
  ...blankRentalLine(),
  rentalItemId: RNT_ID,
  hireStartDate: "2026-09-01",
  hireEndDate: "2026-10-01",
  unitPrice: "150.00",
  ...over,
});

describe("rentalRowsFromOrder — an order's saved hires back into rows", () => {
  it("rebuilds every editable field, in the units the boxes hold", () => {
    const [row] = rentalRowsFromOrder({ rentalItems: [savedLine()] });
    expect(row).toMatchObject({
      rentalItemId: RNT_ID,
      quantity: "2",
      hireStartDate: "2026-09-01",
      hireEndDate: "2026-10-01",
      notifyDaysBefore: "5",
      deliveryAddress: "12 Site Road",
      returnMode: "other",
      returnAddress: "Unit 4",
      ratePeriod: "day",
      rate: "55.00",
      priceOverridden: true,
      unitPrice: "1500.00",
      vatRate: "20",
      notes: "gate code",
    });
    expect(row!._key).toBeTruthy();
  });

  // The identity guard. The row carries the ID and nothing named after the item, so the item's
  // current name, its historical snapshot and its status cannot change which hire this is.
  it("keys the row on rentalItemId — never on the item's name, current or historical", () => {
    const [row] = rentalRowsFromOrder({ rentalItems: [savedLine()] });
    expect(row!.rentalItemId).toBe(RNT_ID);
    expect(JSON.stringify(row)).not.toContain("Fibre Tester");
  });

  it("carries none of the hire's state — a draft's hires have not moved, and the row is not where state lives", () => {
    const [row] = rentalRowsFromOrder({ rentalItems: [savedLine({ hireStatus: "on_hire", receivedQuantity: 2 })] });
    expect(row).not.toHaveProperty("hireStatus");
    expect(row).not.toHaveProperty("receivedQuantity");
    expect(row).not.toHaveProperty("warehouseId");
  });

  it("falls back to the defaults for a mode or basis the row does not know, as the server reads such a line", () => {
    const [row] = rentalRowsFromOrder({ rentalItems: [savedLine({ returnMode: "teleport", ratePeriod: "fortnight", ratePence: null })] });
    expect(row!.returnMode).toBe("delivery");
    expect(row!.ratePeriod).toBe("total");
    expect(row!.rate).toBe("");
  });

  it("is empty for no order, and for an order with no hires", () => {
    expect(rentalRowsFromOrder(null)).toEqual([]);
    expect(rentalRowsFromOrder({ rentalItems: [] })).toEqual([]);
  });

  // Create → save → reopen → save again must carry the same hire. Rebuilding a row from the saved
  // line and turning it back into a payload has to give the server the figures it stored.
  it("survives a round trip: saved line → row → payload sends the stored hire back", () => {
    const [row] = rentalRowsFromOrder({ rentalItems: [savedLine()] });
    const [payload] = toSplitRentalPayload([row!], () => WH_ID);
    expect(payload).toEqual({
      rentalItemId: RNT_ID,
      quantity: 2,
      hireStartDate: "2026-09-01",
      hireEndDate: "2026-10-01",
      notifyDaysBefore: 5,
      deliveryAddress: "12 Site Road",
      ratePeriod: "day",
      ratePence: 5500,
      priceOverridden: true,
      returnMode: "other",
      returnAddress: "Unit 4",
      unitPricePence: 150000,
      vatRate: 20,
      notes: "gate code",
      warehouseId: WH_ID,
    });
  });
});

describe("savedRentalLineRow — the one mapping both forms reopen a hire through", () => {
  it("is what rentalRowsFromOrder uses, so the request and the order rebuild a hire identically", () => {
    const direct = savedRentalLineRow(savedLine());
    const [viaOrder] = rentalRowsFromOrder({ rentalItems: [savedLine()] });
    const strip = ({ _key: _k, ...rest }: ReturnType<typeof savedRentalLineRow>) => {
      void _k;
      return rest;
    };
    expect(strip(direct)).toEqual(strip(viaOrder!));
  });
});

describe("toSplitRentalPayload — every filled hire names its depot", () => {
  it("attaches the resolved warehouse to each filled row and drops blank rows", () => {
    const rows = [filled(), blankRentalLine(), filled({ rentalItemId: "6a1d7f5bfa7d25704f02b964", warehouseId: WH_ID_2 })];
    const payload = toSplitRentalPayload(rows, (r) => r.warehouseId ?? "");
    expect(payload).toHaveLength(2);
    expect(payload[0]!.warehouseId).toBe("");
    expect(payload[1]!.warehouseId).toBe(WH_ID_2);
  });

  it("a locked depot wins over whatever the row holds — the single-warehouse manager", () => {
    const [p] = toSplitRentalPayload([filled({ warehouseId: WH_ID_2 })], () => WH_ID);
    expect(p!.warehouseId).toBe(WH_ID);
  });

  it("never sends a line total, a reminder date or hire state", () => {
    const [p] = toSplitRentalPayload([filled()], () => WH_ID);
    expect(p).not.toHaveProperty("lineTotalPence");
    expect(p).not.toHaveProperty("notifyOnDate");
    expect(p).not.toHaveProperty("hireStatus");
  });
});

describe("rentalRowsMissingWarehouse", () => {
  it("flags a filled row with no destination, ignores blank rows", () => {
    expect(rentalRowsMissingWarehouse([filled(), blankRentalLine()], (r) => r.warehouseId ?? "")).toBe(true);
    expect(rentalRowsMissingWarehouse([filled({ warehouseId: WH_ID }), blankRentalLine()], (r) => r.warehouseId ?? "")).toBe(false);
    expect(rentalRowsMissingWarehouse([filled()], () => WH_ID)).toBe(false);
  });
});

describe("identity on the order create is per warehouse", () => {
  it("the same hire to two depots is two lines, not a duplicate", () => {
    const a = filled({ warehouseId: WH_ID });
    const b = filled({ warehouseId: WH_ID_2 });
    expect(duplicateRentalRowKeys([a, b]).size).toBe(0);
    expect(validateRentalLines([a, b])).toBeUndefined();
  });

  it("the same hire to the same depot twice is still a duplicate", () => {
    const a = filled({ warehouseId: WH_ID });
    const b = filled({ warehouseId: WH_ID, ratePeriod: "week", rate: "300" });
    expect(duplicateRentalRowKeys([a, b]).has(b._key)).toBe(true);
    expect(validateRentalLines([a, b])).toMatch(/can only be added once/);
  });

  it("rows with no warehouse at all — the request form — keep their old identity", () => {
    const a = filled();
    const b = filled();
    expect(duplicateRentalRowKeys([a, b]).has(b._key)).toBe(true);
  });
});

describe("the hire half of the estimate", () => {
  it("prices a rate-basis row by its agreed price, not its empty price box", () => {
    const row = filled({ quantity: "2", ratePeriod: "day", rate: "55", unitPrice: "", vatRate: "20" });
    // £55/day × 30 days = £1,650 per unit × 2.
    expect(rentalEstimate([row])).toEqual({ subtotal: 3300, vat: 660 });
  });

  it("sums filled rows only", () => {
    expect(rentalEstimate([filled({ quantity: "1", unitPrice: "100", vatRate: "0" }), blankRentalLine()])).toEqual({ subtotal: 100, vat: 0 });
    expect(rentalEstimate([])).toEqual({ subtotal: 0, vat: 0 });
  });

  it("from SAVED lines, for an edit that cannot show them, matches the server's roll-up", () => {
    expect(savedRentalEstimate([{ lineTotal: 3000, vatRate: 20 }, { lineTotal: 100, vatRate: 0 }])).toEqual({ subtotal: 3100, vat: 600 });
  });
});

// The placeholder on a rental line's address box must name where a BLANK address actually goes —
// the same chain the server resolves (line → order override → warehouse).
describe("rentalDeliveryFallback — what a blank line address means", () => {
  it("names the warehouse when the order has no override — and on a request, which never has one", () => {
    expect(rentalDeliveryFallback()).toBe("the selected warehouse");
    expect(rentalDeliveryFallback(null)).toBe("the selected warehouse");
    expect(rentalDeliveryFallback("")).toBe("the selected warehouse");
  });

  it("names the order's delivery address once the order overrides it", () => {
    expect(rentalDeliveryFallback("12 Site Road")).toBe("the order's delivery address");
  });

  it("treats a whitespace override as no override, exactly as the server does", () => {
    expect(rentalDeliveryFallback("   ")).toBe("the selected warehouse");
  });
});

// Sending the hires makes the server REPLACE them — a delete and a re-create of every row. A save
// that did not touch them must not do that.
describe("rentalRowsChanged — do the hires need sending at all?", () => {
  const order = { rentalItems: [savedLine()] };

  it("is false when the rows are exactly what the order stores", () => {
    expect(rentalRowsChanged(rentalRowsFromOrder(order), order)).toBe(false);
  });

  it("is false when only a BLANK spare row was added — the payload drops it", () => {
    expect(rentalRowsChanged([...rentalRowsFromOrder(order), blankRentalLine()], order)).toBe(false);
  });

  it.each([
    ["quantity", { quantity: "3" }],
    ["the hire period", { hireEndDate: "2026-11-01" }],
    ["the delivery address", { deliveryAddress: "9 Other Road" }],
    ["notes", { notes: "call ahead" }],
  ])("is true once %s changed", (_what, over) => {
    const rows = rentalRowsFromOrder(order).map((r) => ({ ...r, ...over }));
    expect(rentalRowsChanged(rows, order)).toBe(true);
  });

  it("is true when a hire is removed, or one is added", () => {
    expect(rentalRowsChanged([], order)).toBe(true);
    expect(rentalRowsChanged([...rentalRowsFromOrder(order), { ...rentalRowsFromOrder(order)[0]!, deliveryAddress: "elsewhere" }], order)).toBe(true);
  });

  it("an order with no hires and no rows on screen is unchanged", () => {
    expect(rentalRowsChanged([], { rentalItems: [] })).toBe(false);
    expect(rentalRowsChanged([blankRentalLine()], null)).toBe(false);
  });
});
