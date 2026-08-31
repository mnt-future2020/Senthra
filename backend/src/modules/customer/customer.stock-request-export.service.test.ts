import { beforeEach, describe, expect, it, vi } from "vitest";

// The customer's submissions CSV. Two things are worth pinning here and neither is cosmetic:
//
//   1. COLUMN ALIGNMENT. The export builds a header array and body rows in two separate places. A
//      value added to one and not the other does not fail to compile and does not throw — every
//      column silently shifts by one, so "Status" starts printing dates. Asserting header width
//      against EVERY row width is the only thing that catches it.
//   2. The preferred warehouse is present. The detail modal shows it; an export that omitted it
//      contradicted the screen it was taken from, and the CSV is the copy people reconcile offline.
vi.mock("./customer.repository.js", () => ({
  findStockRequestsByCustomer: vi.fn(),
}));
vi.mock("#modules/settings/settings.service.js", () => ({
  getRegionalSettings: vi.fn(async () => ({ dateFormat: "dd/MM/yyyy", timezone: "Europe/London" })),
  getCompanyTimezone: vi.fn(async () => "Europe/London"),
  getCloudinaryCreds: vi.fn(),
  getStockCodePrefix: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as customerRepo from "./customer.repository.js";
import { exportOwnStockRequestsCsv } from "./customer.service.js";

const CUST_ID = "c".repeat(24);
const repo = vi.mocked(customerRepo);

/** One submission row in the shape the repository returns (relations included). */
function row(over: Record<string, unknown> = {}) {
  return {
    id: "r".repeat(24),
    name: "CAT6 Cable",
    editedName: null,
    catalogueItemId: null,
    linkedStockEntryId: null,
    quantity: 10,
    reason: null,
    notes: null,
    status: "assigned",
    requestedByUserId: null,
    requestedByName: null,
    reviewedBy: null,
    adminResponse: null,
    reviewedAt: null,
    preferredWarehouseId: null,
    preferredWarehouse: null,
    warehouseAssignments: [],
    createdAt: new Date("2026-08-31T09:00:00Z"),
    updatedAt: new Date("2026-08-31T09:00:00Z"),
    ...over,
  } as never;
}

const leg = (warehouseName: string, quantity: number, receivedQuantity: number, status = "pending") => ({
  id: "l".repeat(24),
  warehouseId: "w".repeat(24),
  warehouse: { id: "w".repeat(24), name: warehouseName, code: "WH-0005" },
  quantity,
  receivedQuantity,
  status,
  receivedBy: null,
  receivedAt: null,
  notes: null,
});

const preferred = (name: string) => ({ id: "p".repeat(24), name, code: "WH-0011", status: "active", deletedAt: null });

/** Split the CSV into cells, tolerating quoted fields (values here contain no embedded commas). */
const lines = (csv: string) => csv.trim().split(/\r?\n/).map((l) => l.split(","));

beforeEach(() => vi.clearAllMocks());

describe("exportOwnStockRequestsCsv — column alignment", () => {
  it("gives every body row exactly as many cells as the header", async () => {
    // Both branches at once: one unassigned submission (the null-padded row) and one split across
    // two warehouses (a row per leg). If a value is ever added to `base` without a matching header,
    // this fails for all of them.
    repo.findStockRequestsByCustomer.mockResolvedValue([
      row({ name: "Unassigned item" }),
      row({
        name: "Split item",
        preferredWarehouseId: "p".repeat(24),
        preferredWarehouse: preferred("Nezuko Warehouse"),
        warehouseAssignments: [leg("TESTING WARE", 6, 6, "received"), leg("London Logistics Hub", 4, 0)],
      }),
    ] as never);

    const { csv } = await exportOwnStockRequestsCsv(CUST_ID);
    const rows = lines(csv);
    const width = rows[0].length;
    expect(rows).toHaveLength(4); // header + unassigned + 2 legs
    for (const r of rows) expect(r).toHaveLength(width);
  });
});

describe("exportOwnStockRequestsCsv — preferred warehouse", () => {
  it("carries a 'Preferred warehouse' column, positioned beside the actual warehouse", async () => {
    repo.findStockRequestsByCustomer.mockResolvedValue([row()] as never);
    const [header] = lines((await exportOwnStockRequestsCsv(CUST_ID)).csv);
    const pref = header.indexOf("Preferred warehouse");
    expect(pref).toBeGreaterThan(-1);
    // Asked-for then actual, read as a pair rather than separated by unrelated columns.
    expect(header[pref + 1]).toBe("Warehouse");
  });

  it("prints the preferred warehouse on EVERY leg of a split, not just the first", async () => {
    // Each leg is its own row, and a row that dropped the preference would read as "no preference"
    // for that warehouse — the export is filtered and sorted by the reader, so per-row truth matters.
    repo.findStockRequestsByCustomer.mockResolvedValue([
      row({
        preferredWarehouseId: "p".repeat(24),
        preferredWarehouse: preferred("Nezuko Warehouse"),
        warehouseAssignments: [leg("TESTING WARE", 6, 6, "received"), leg("London Logistics Hub", 4, 0)],
      }),
    ] as never);

    const rows = lines((await exportOwnStockRequestsCsv(CUST_ID)).csv);
    const pref = rows[0].indexOf("Preferred warehouse");
    expect(rows[1][pref]).toBe("Nezuko Warehouse");
    expect(rows[2][pref]).toBe("Nezuko Warehouse");
    // ...while the ACTUAL warehouse column still differs per leg — the whole point of the pairing.
    expect(rows[1][pref + 1]).toBe("TESTING WARE");
    expect(rows[2][pref + 1]).toBe("London Logistics Hub");
  });

  it("leaves the cell empty when the customer expressed no preference", async () => {
    repo.findStockRequestsByCustomer.mockResolvedValue([row()] as never);
    const rows = lines((await exportOwnStockRequestsCsv(CUST_ID)).csv);
    const pref = rows[0].indexOf("Preferred warehouse");
    expect(rows[1][pref]).toBe("");
  });
});
