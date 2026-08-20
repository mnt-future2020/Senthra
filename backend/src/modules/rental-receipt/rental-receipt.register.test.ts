import { beforeEach, describe, expect, it, vi } from "vitest";

// The REGISTER — every hire movement across every order, and the two files it exports.
//
// What these guard is the thing a register gets wrong quietly: showing (or exporting) a different set
// of rows from the one the caller is entitled to, or from the one on screen. Neither failure looks
// like a failure — the file arrives, it just holds the wrong rows.

vi.mock("./rental-receipt.repository.js", () => ({
  findMany: vi.fn(),
  count: vi.fn(),
}));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({
  RECEIVABLE_PO_STATUSES: ["sent", "supplier_accepted", "partially_received"],
}));
vi.mock("#modules/purchase-order/purchase-order.service.js", () => ({ recomputeRentalReceiptStatus: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/attachment/attachment.service.js", () => ({ releaseAsset: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getRegionalSettings: vi.fn().mockResolvedValue({ dateFormat: "DD/MM/YYYY", timezone: "Europe/London" }),
}));
vi.mock("../../lib/realtime.js", () => ({
  emitAttentionChanged: vi.fn(),
  emitToRoom: vi.fn(),
  emitToUser: vi.fn(),
  RENTAL_WATCHERS_ROOM: "rentals:watchers",
}));
// The real scope helper, not a stub: "which warehouses may this actor see" is exactly what these
// tests are about, and a mock that answered `undefined` would make every one of them pass vacuously.
vi.mock("../../lib/warehouse-access.js", async (orig) => ({
  ...(await orig<typeof import("../../lib/warehouse-access.js")>()),
}));

import * as receiptRepo from "./rental-receipt.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import {
  exportRentalReceiptLinesCsv,
  exportRentalReceiptsCsv,
  listRentalReceipts,
} from "./rental-receipt.service.js";

const findMany = vi.mocked(receiptRepo.findMany);
const count = vi.mocked(receiptRepo.count);

const WH = "a".repeat(24);
const ACTOR = { type: "user" as const, id: "u1", email: "pm@x.co", permissions: ["rentals.view"] };

const line = (over: Record<string, unknown> = {}) => ({
  id: "l1",
  purchaseOrderRentalLineId: "h1",
  itemName: "Fibre Tester",
  baseUnit: "Each",
  orderedQuantity: 3,
  previouslyReceived: 0,
  receivedQuantity: 2,
  damagedQuantity: 1,
  assetTags: ["FT-9", "FT-10"],
  notes: null,
  sortOrder: 0,
  ...over,
});

const note = (over: Record<string, unknown> = {}) =>
  ({
    id: "r1",
    code: "HRN-0003",
    direction: "out",
    purchaseOrderId: "p1",
    poCode: "PO-0067",
    supplierId: null,
    supplierName: "Kansha",
    warehouseId: WH,
    warehouse: { id: WH, code: "WH-0003", name: "Leeds" },
    deliveryDate: new Date("2026-07-14T00:00:00.000Z"),
    carrier: "DPD",
    deliveryNoteRef: "SUP-991",
    notes: "left at gate",
    condition: "damaged",
    conditionNotes: "scratched casing",
    receivedBy: "wm@x.co",
    reversedAt: null,
    reversedBy: null,
    reversalReason: null,
    createdBy: "wm@x.co",
    createdAt: new Date("2026-07-14T09:00:00.000Z"),
    updatedAt: new Date("2026-07-14T09:00:00.000Z"),
    lines: [line()],
    attachments: [],
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([note()]);
  count.mockReset().mockResolvedValue(1);
  vi.mocked(audit.record).mockReset();
});

const filtersOf = () => findMany.mock.calls[0][0];

describe("the hire movement register", () => {
  // The SHARED widening rule (utils/filter-date), not a local one — the "To" edge covers the whole
  // last day. This module had written its own copy, which is the exact duplication that helper's
  // header exists to prevent.
  it("widens the period to cover the whole last day", async () => {
    await listRentalReceipts({ from: "2026-07-01", to: "2026-07-31" }, ACTOR);
    expect(filtersOf().dateFrom).toEqual(new Date("2026-07-01T00:00:00.000Z"));
    expect(filtersOf().dateTo).toEqual(new Date("2026-07-31T23:59:59.999Z"));
  });

  // A period that cannot be parsed must not narrow the register to nothing and must not 500 — either
  // one reads to the user as "there were no movements in July", which is a different answer.
  it("ignores a period it cannot read rather than answering with an empty month", async () => {
    await listRentalReceipts({ from: "last tuesday" }, ACTOR);
    expect(filtersOf().dateFrom).toBeUndefined();
  });

  // A direction the client invented would select nothing while the screen showed a filter that
  // looked applied.
  it("ignores a direction that is not one of the three legs", async () => {
    await listRentalReceipts({ direction: "sideways" }, ACTOR);
    expect(filtersOf().direction).toBeUndefined();
    await listRentalReceipts({ direction: "damage" }, ACTOR);
    expect(findMany.mock.calls[1][0].direction).toBe("damage");
  });

  // The whole point of the default: a note that was corrected is still a fact about the period, and
  // a register that hides it stops matching the order page it was taken from.
  it("keeps reversed notes unless the caller asks for them out", async () => {
    await listRentalReceipts({}, ACTOR);
    expect(filtersOf().includeReversed).toBeUndefined();
    await listRentalReceipts({ includeReversed: false }, ACTOR);
    expect(findMany.mock.calls[1][0].includeReversed).toBe(false);
  });

  // The rule the GRN register states and this one has to keep: a chosen filter narrows what the
  // caller may already see. A warehouse-scoped actor asking for a warehouse outside their scope must
  // get nothing, never that warehouse's movements.
  it("applies the actor's warehouse scope alongside every other filter", async () => {
    const scoped = { ...ACTOR, assignedWarehouseIds: ["b".repeat(24)] };
    await listRentalReceipts({ warehouse: WH }, scoped);
    expect(filtersOf().warehouseId).toBe(WH);
    expect(filtersOf().warehouseIds).toEqual(["b".repeat(24)]);
  });
});

describe("the register's exports", () => {
  // EXPORT_PAGING, not the screen's page size: `paginate` clamps anything a client can ask for, so
  // without it an export stops at one page AND reports itself complete.
  it("asks for the whole filtered set, not one page", async () => {
    await exportRentalReceiptsCsv({ from: "2026-07-01", page: 3, pageSize: 20 }, ACTOR);
    expect(count.mock.calls[0][0].dateFrom).toEqual(new Date("2026-07-01T00:00:00.000Z"));
    expect(findMany.mock.calls[0][2]).toBeGreaterThan(20);
  });

  it("writes the movement in words, with the units and the damage beside it", async () => {
    const { csv } = await exportRentalReceiptsCsv({}, ACTOR);
    const [header, row] = csv.split(/\r?\n/);
    expect(header).toContain("Damaged Units");
    expect(row).toContain("HRN-0003");
    expect(row).toContain("Returned to supplier");
    // 2 units moved, 1 of them damaged — summed off the note's own lines.
    expect(row).toContain(",2,1,");
  });

  // A reversed note moved NOTHING. Its quantities still print (the row has to be readable), so the
  // column that says so is what stops them being summed — it is not optional in this file.
  it("marks a reversed note so its quantities are not summed by mistake", async () => {
    findMany.mockResolvedValue([note({ reversedAt: new Date("2026-07-20T00:00:00.000Z"), reversalReason: "wrong order" })]);
    const { csv } = await exportRentalReceiptsCsv({}, ACTOR);
    expect(csv.split(/\r?\n/)[1]).toContain("yes");
  });

  // Staff free text about a delivery — and sometimes about the supplier who sent it — never travels
  // in a file somebody forwards. Every other export in this codebase holds the same line.
  it("leaves the free-text notes out of the file", async () => {
    const { csv } = await exportRentalReceiptsCsv({}, ACTOR);
    expect(csv).not.toContain("left at gate");
    expect(csv).not.toContain("scratched casing");
  });

  it("carries the supplier's asset tags on the line export — the units a dispute is about", async () => {
    const { csv } = await exportRentalReceiptLinesCsv({}, ACTOR);
    expect(csv.split(/\r?\n/)[1]).toContain("FT-9 | FT-10");
  });

  it("records the extraction, as every export in this codebase does", async () => {
    await exportRentalReceiptsCsv({}, ACTOR);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "rental_receipt.exported" }));
  });
});
