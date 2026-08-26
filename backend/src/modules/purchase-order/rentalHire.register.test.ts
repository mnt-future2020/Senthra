import { beforeEach, describe, expect, it, vi } from "vitest";

// What a hire COST and what actually happened to it — the columns a period report is built from.
//
// The billed window (`hireStartDate` → `hireEndDate`) was already on the row. What was missing is the
// other half of every hire review: when the equipment physically moved, and how that compares. Billed
// 70 days, held 62 is the whole conversation, and neither number was reportable.

vi.mock("./purchase-order.repository.js", () => ({
  listOnHire: vi.fn(),
  findManyExtensions: vi.fn(),
  countExtensions: vi.fn(),
  ON_HIRE_STATUSES: ["all", "expiring", "overdue", "awaiting", "late", "returned", "cancelled"],
}));
vi.mock("#modules/rental-receipt/rental-receipt.repository.js", () => ({ movementDatesByHireLine: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getCompanyTimezone: vi.fn().mockResolvedValue("Europe/London"),
  getRegionalSettings: vi.fn().mockResolvedValue({ dateFormat: "DD/MM/YYYY", timezone: "Europe/London" }),
  getCloudinaryCreds: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("../../lib/realtime.js", () => ({
  emitAttentionChanged: vi.fn(),
  emitToRoom: vi.fn(),
  emitToUser: vi.fn(),
  PURCHASE_ORDER_WATCHERS_ROOM: "purchase_orders:watchers",
  RENTAL_WATCHERS_ROOM: "rentals:watchers",
}));

import * as poRepo from "./purchase-order.repository.js";
import * as receiptRepo from "#modules/rental-receipt/rental-receipt.repository.js";
import { exportHireExtensionsCsv, exportOnHireCsv, listHireExtensions, listOnHire } from "./purchase-order.service.js";

const LINE = "a".repeat(24);
const ACTOR = { type: "user" as const, id: "u1", email: "pm@x.co", permissions: ["rentals.view"] };

const listRepo = vi.mocked(poRepo.listOnHire);
const movementDates = vi.mocked(receiptRepo.movementDatesByHireLine);

const hireRow = (over: Record<string, unknown> = {}) =>
  ({
    id: LINE,
    purchaseOrder: { id: "p1", code: "PO-0067", status: "closed", supplierName: "Kansha", warehouseId: null, deliveryAddress: null, warehouse: null },
    rentalItem: { id: "r1", code: "RNT-0004", name: "Fibre Tester" },
    rentalItemId: "r1",
    itemName: "Fibre Tester",
    quantity: 3,
    // Billed 1 June → 10 August.
    hireStartDate: new Date("2026-06-01T00:00:00.000Z"),
    hireEndDate: new Date("2026-08-10T00:00:00.000Z"),
    notifyOnDate: new Date("2026-08-07T00:00:00.000Z"),
    notifyDaysBefore: 3,
    deliveryAddress: null,
    returnMode: "delivery",
    returnAddress: null,
    ratePeriod: "day",
    ratePence: 5500,
    priceOverridden: false,
    unitPricePence: 385000,
    lineTotalPence: 1155000,
    extensionChargePence: 27500,
    receivedQuantity: 3,
    fullyReceived: true,
    returnedQuantity: 3,
    fullyReturned: true,
    damagedQuantity: 1,
    hireStatus: "returned",
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

beforeEach(() => {
  listRepo.mockReset().mockResolvedValue({ rows: [hireRow()], total: 1 });
  movementDates.mockReset().mockResolvedValue(
    // Delivered 3 June, collected 4 August — a week later and six days early against the paperwork.
    new Map([[LINE, { deliveredOn: new Date("2026-06-03T00:00:00.000Z"), collectedOn: new Date("2026-08-04T00:00:00.000Z") }]]),
  );
});

// ── What the row tells a WAREHOUSE ─────────────────────────────────────────────────────────────
//
// Two fields the warehouse's on-hire pane needs and the row did not carry.
//
// `issuedQuantity` is the difference between what we owe the provider and what is actually on the
// shelf. Without it the pane showed one number, so a row reading "3 held" invited someone to hand
// three units to a collecting driver when one was in a van — and `createRentalReturn` answered with a
// 409 explaining the difference, correctly and too late to be useful.
//
// `deliveryAtWarehouse` says which arm of the delivery chain fired. The pane is scoped to one depot,
// so without it every ordinary row printed that depot's own name, burying the hires that genuinely go
// straight to a site.
describe("the row a warehouse reads", () => {
  it("carries what is out with an engineer, so the shelf figure can be derived", async () => {
    listRepo.mockResolvedValue({ rows: [hireRow({ receivedQuantity: 3, returnedQuantity: 0, issuedQuantity: 1 })], total: 1 });
    const { rows } = await listOnHire({ status: "all" }, ACTOR);
    expect(rows[0].issuedQuantity).toBe(1);
    // The number the pane prints beside it: 3 on hire − 1 on a job = 2 that a driver could take today.
    expect(rows[0].receivedQuantity - rows[0].returnedQuantity - rows[0].issuedQuantity).toBe(2);
  });

  // A row written before the counter existed carries no value at all. Absent is zero — the same
  // reading the atomic issue guard gives a missing counter — so the pane degrades to "all of it is
  // here" rather than rendering NaN.
  it("reads an absent counter as zero rather than undefined", async () => {
    const row = hireRow();
    delete row.issuedQuantity;
    listRepo.mockResolvedValue({ rows: [row], total: 1 });
    const { rows } = await listOnHire({ status: "all" }, ACTOR);
    expect(rows[0].issuedQuantity).toBe(0);
  });

  it("says the delivery fell through to the warehouse when neither address is set", async () => {
    const { rows } = await listOnHire({ status: "all" }, ACTOR);
    expect(rows[0].deliveryAtWarehouse).toBe(true);
  });

  it("says it did NOT when the line carries its own address", async () => {
    listRepo.mockResolvedValue({ rows: [hireRow({ deliveryAddress: "Site A, Leeds" })], total: 1 });
    const { rows } = await listOnHire({ status: "all" }, ACTOR);
    expect(rows[0].deliveryAtWarehouse).toBe(false);
  });

  // The case the pane got visibly wrong before: an ORDER-level override is a real destination, but
  // the line's own `deliveryAddress` is null, so a column reading that field alone printed the literal
  // words "Order delivery address" while the kit went somewhere definite.
  it("says it did NOT when the ORDER overrides the destination", async () => {
    listRepo.mockResolvedValue({
      rows: [hireRow({ purchaseOrder: { ...hireRow().purchaseOrder, deliveryAddress: "12 Site Road" } })],
      total: 1,
    });
    const { rows } = await listOnHire({ status: "all" }, ACTOR);
    expect(rows[0].deliveryAtWarehouse).toBe(false);
    expect(rows[0].deliveryLocation.address).toBe("12 Site Road");
  });
});

describe("the finished-hire row", () => {
  it("carries the price it committed and the charge added since, separately", async () => {
    const { rows } = await listOnHire({ status: "returned" }, ACTOR);
    expect(rows[0].unitPrice).toBe(3850);
    expect(rows[0].lineTotal).toBe(11550);
    // An extension is money agreed AFTER the order was sent and is not part of its totals. Summed
    // into `lineTotal` it would silently overstate what the order committed.
    expect(rows[0].extensionCharge).toBe(275);
  });

  // The window comes off the NOTES, not off `receivedAt` / `returnedAt` — those are stamped when
  // somebody typed the record in, and a supplier invoices from the day the kit changed hands.
  it("reports when the equipment actually moved, and for how long", async () => {
    const { rows } = await listOnHire({ status: "returned" }, ACTOR);
    expect(rows[0].deliveredOn).toBe("2026-06-03T00:00:00.000Z");
    expect(rows[0].collectedOn).toBe("2026-08-04T00:00:00.000Z");
    // Same convention as `hireDays`: the collection day is the day it goes back and is not charged.
    expect(rows[0].daysOnHire).toBe(62);
    expect(rows[0].hireDays).toBe(70);
  });

  // A hire still out has no length yet. 0 would read as "held for no time" on a row that is out now.
  it("has no length until the loop is closed at both ends", async () => {
    movementDates.mockResolvedValue(new Map([[LINE, { deliveredOn: new Date("2026-06-03T00:00:00.000Z") }]]));
    const { rows } = await listOnHire({ status: "all" }, ACTOR);
    expect(rows[0].daysOnHire).toBeNull();
    expect(rows[0].collectedOn).toBeNull();
  });

  // A collection dated before the delivery is bad data entry, not a hire that ran backwards.
  it("never reports a negative length", async () => {
    movementDates.mockResolvedValue(
      new Map([[LINE, { deliveredOn: new Date("2026-06-03T00:00:00.000Z"), collectedOn: new Date("2026-06-01T00:00:00.000Z") }]]),
    );
    const { rows } = await listOnHire({ status: "returned" }, ACTOR);
    expect(rows[0].daysOnHire).toBe(0);
  });

  // One batched query for the whole page, keyed on the hire lines it just read — not one per row.
  it("reads every row's movements in a single query", async () => {
    listRepo.mockResolvedValue({ rows: [hireRow(), hireRow({ id: "b".repeat(24) })], total: 2 });
    await listOnHire({ status: "returned" }, ACTOR);
    expect(movementDates).toHaveBeenCalledTimes(1);
    expect(movementDates).toHaveBeenCalledWith([LINE, "b".repeat(24)]);
  });
});

// A search must NARROW the window the caller asked for, never widen it. Written as an AND arm for
// exactly that reason: an OR at the top level would sit beside the deadline predicate instead of
// inside it, and "Fibre" under the Overdue filter would return every matching hire on every order.
describe("searching the hire list", () => {
  it("keeps the window and adds the text as a narrowing arm", async () => {
    await listOnHire({ status: "overdue", search: "Fibre" }, ACTOR);
    const passed = listRepo.mock.calls[0][0];
    expect(passed.status).toBe("overdue");
    expect(passed.search).toBe("Fibre");
  });

  // A box holding only spaces is not a filter. Passed through, it would narrow the list to nothing
  // while the screen showed an empty-looking search.
  it("ignores a box holding only spaces", async () => {
    await listOnHire({ search: "   " }, ACTOR);
    expect(listRepo.mock.calls[0][0].search).toBeUndefined();
  });
});

describe("the hire export", () => {
  const cells = async () => {
    const { csv } = await exportOnHireCsv({ status: "returned" }, ACTOR);
    const [header, row] = csv.split(/\r?\n/);
    return { header: header.split(","), row: row.split(",") };
  };
  const valueOf = async (column: string) => {
    const { header, row } = await cells();
    const i = header.indexOf(column);
    expect(i, `no "${column}" column`).toBeGreaterThan(-1);
    return row[i];
  };

  // An export renders the whole filtered set, not the first page of it. listOnHire clamps pageSize
  // with its own hand-written Math.min(200, ...), which EXPORT_PAGING cannot lift — so the export
  // asked for 50,000 rows, silently received 200, and measured `capped` against that same clamped
  // length, reporting a 200-row file as complete. A short download nobody is told is short: the
  // exact failure `paginate(maxPageSize)` and EXPORT_PAGING were written to end.
  it("asks for the whole filtered set, not one clamped page", async () => {
    await exportOnHireCsv({ status: "all" }, ACTOR);
    expect(listRepo.mock.calls[0]![0].pageSize).toBeGreaterThan(200);
  });

  it("prices in pounds, never in the pence integer it stores", async () => {
    // 385000 pence in a column headed "Unit Price" is a £3,850 hire reported as £385,000.
    expect(await valueOf("Unit Price")).toBe("3850.00");
    expect(await valueOf("Line Total")).toBe("11550.00");
    expect(await valueOf("Extension Charge")).toBe("275.00");
  });

  it("puts the billed period beside the one that happened", async () => {
    expect(await valueOf("Hire Days")).toBe("70");
    expect(await valueOf("Days On Hire")).toBe("62");
    expect(await valueOf("Delivered")).toBe("03/06/2026");
    expect(await valueOf("Collected")).toBe("04/08/2026");
  });

  // A hire priced as a lump sum has no per-period rate. 0.00 there would average into a rate report
  // as a free hire — blank is the honest cell, and it is why this is not simply `?? 0`.
  it("leaves the rate blank when the hire was priced as a total, rather than calling it zero", async () => {
    listRepo.mockResolvedValue({ rows: [hireRow({ ratePence: null, ratePeriod: "total" })], total: 1 });
    expect(await valueOf("Rate")).toBe("");
    expect(await valueOf("Rate Basis")).toBe("");
  });

  it("leaves the movement dates blank while the kit is still out", async () => {
    movementDates.mockResolvedValue(new Map());
    expect(await valueOf("Delivered")).toBe("");
    expect(await valueOf("Days On Hire")).toBe("");
  });

  // Both are computed against TODAY. On a hire that is already back that is a countdown to a deadline
  // nobody is waiting for — and "-1" in a column headed Days Remaining reads as overdue, which is the
  // one thing a returned hire is not.
  it("stops counting down on a hire that has already come back", async () => {
    expect(await valueOf("Days Remaining")).toBe("");
    expect(await valueOf("Reminder Due (Europe/London)")).toBe("");
  });

  // The same is true of a CANCELLED hire, and more so: nothing ever arrived, so there was never a
  // deadline to be past. A row reading "Days Remaining -14" in the register is the countdown of a
  // hire that did not happen.
  it("stops counting down on a hire that never happened either", async () => {
    listRepo.mockResolvedValue({ rows: [hireRow({ hireStatus: "cancelled" })], total: 1 });
    expect(await valueOf("Days Remaining")).toBe("");
    expect(await valueOf("Reminder Due (Europe/London)")).toBe("");
  });

  it("still counts down on a live one", async () => {
    listRepo.mockResolvedValue({ rows: [hireRow({ hireStatus: "on_hire" })], total: 1 });
    expect(await valueOf("Days Remaining")).not.toBe("");
  });

  // Without these the file has the same hole the screen had before the badge was added: a row
  // ordering 5 and receiving 2, off the receiving queue, with nothing saying where the other 3 went.
  // The board shows it; a period report reconciled against a supplier invoice needs it more.
  it("carries the shortfall and the reason it was written off", async () => {
    listRepo.mockResolvedValue({
      rows: [hireRow({ quantity: 5, receivedQuantity: 2, cancelledQuantity: 3, shortCloseReason: "Supplier cannot supply" })],
      total: 1,
    });
    expect(await valueOf("Cancelled Qty")).toBe("3");
    expect(await valueOf("Short Close Reason")).toBe("Supplier cannot supply");
  });

  it("reports what arrived, what went back and what came back broken", async () => {
    expect(await valueOf("Received Qty")).toBe("3");
    expect(await valueOf("Returned Qty")).toBe("3");
    expect(await valueOf("Damaged Qty")).toBe("1");
  });
});

// ── The extension register ────────────────────────────────────────────────────────────────────
//
// `extensionChargePence` on a hire line is the SUM of these. Extend three times for £275, £300 and
// £150 and it reads £725 — correct, and unanswerable: "how much extension did we agree in July"
// cannot be asked of a number that carries no dates.

const findExtensions = vi.mocked(poRepo.findManyExtensions);
const countExtensions = vi.mocked(poRepo.countExtensions);

const extension = (over: Record<string, unknown> = {}) =>
  ({
    id: "e1",
    purchaseOrderId: "p1",
    poCode: "PO-0067",
    supplierName: "Kansha",
    itemName: "Fibre Tester",
    previousEndDate: new Date("2026-08-10T00:00:00.000Z"),
    newEndDate: new Date("2026-08-20T00:00:00.000Z"),
    addedDays: 10,
    chargePence: 27_500,
    calculatedChargePence: 30_000,
    priceOverridden: true,
    quantity: 1,
    ratePeriod: "day",
    ratePence: 5_500,
    createdBy: "pm@x.co",
    createdAt: new Date("2026-07-05T14:30:00.000Z"),
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe("every extension agreed in a period", () => {
  beforeEach(() => {
    findExtensions.mockReset().mockResolvedValue([extension()]);
    countExtensions.mockReset().mockResolvedValue(1);
  });

  // `agreedAt` is a TIMESTAMP, not a calendar day like a movement date. An upper bound of the last
  // day's midnight would drop every extension agreed after midnight on that day — which is all of
  // them, so a July report would silently lose the whole of the 31st.
  it("includes the whole of the last day of the period", async () => {
    await listHireExtensions({ from: "2026-07-01", to: "2026-07-31" });
    const f = findExtensions.mock.calls[0][0];
    expect(f.dateFrom).toEqual(new Date("2026-07-01T00:00:00.000Z"));
    expect(f.dateTo).toEqual(new Date("2026-07-31T23:59:59.999Z"));
  });

  it("ignores a period it cannot read rather than answering with an empty month", async () => {
    await listHireExtensions({ from: "last tuesday" });
    expect(findExtensions.mock.calls[0][0].dateFrom).toBeUndefined();
  });

  it("adds up what is on the page", async () => {
    findExtensions.mockResolvedValue([extension(), extension({ id: "e2", chargePence: 30_000 })]);
    const res = await listHireExtensions({});
    expect(res.totalCharge).toBe(575);
  });

  it("exports the whole filtered period, not one page", async () => {
    await exportHireExtensionsCsv({ from: "2026-07-01", page: 3, pageSize: 20 });
    expect(findExtensions.mock.calls[0][2]).toBeGreaterThan(20);
  });

  it("writes what the rate said beside what was agreed, and marks the gap", async () => {
    const { csv } = await exportHireExtensionsCsv({});
    const [header, row] = csv.split(/\r?\n/).map((l) => l.split(","));
    const at = (c: string) => row[header.indexOf(c)];
    expect(at("Calculated Charge")).toBe("300.00");
    expect(at("Agreed Charge")).toBe("275.00");
    expect(at("Negotiated")).toBe("yes");
    expect(at("Days Added")).toBe("10");
    expect(at("Previous End")).toBe("10/08/2026");
  });

  // A hire priced as a lump sum has no per-period rate — 0.00 would average into a rate report as a
  // free extension.
  it("leaves the rate blank on the total basis rather than calling it zero", async () => {
    findExtensions.mockResolvedValue([extension({ ratePence: null, ratePeriod: "total", calculatedChargePence: null })]);
    const { csv } = await exportHireExtensionsCsv({});
    const [header, row] = csv.split(/\r?\n/).map((l) => l.split(","));
    expect(row[header.indexOf("Rate")]).toBe("");
    expect(row[header.indexOf("Calculated Charge")]).toBe("");
  });
});
