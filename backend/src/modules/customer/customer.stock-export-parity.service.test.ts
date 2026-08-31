import { beforeEach, describe, expect, it, vi } from "vitest";

// FILTER → EXPORT PARITY for a customer's consignment stock.
//
// The list and the download are two functions over one repository call, and the only thing keeping
// them honest is that they hand it the SAME filters object. They did not: the export omitted
// `receivedWindow` entirely while both list paths applied it, so the admin Stock tab's date range
// narrowed the screen and not the file — filter to one week, export, and the spreadsheet held the
// customer's whole consignment history with nothing in it to say so.
//
// Asserting the FILTERS ARGUMENT rather than the rendered rows is deliberate. A row assertion passes
// on a mock that ignores the filter it was handed, which is exactly the bug; the argument is the
// contract with the database and is the only thing that proves the window actually travelled.

vi.mock("./customer.repository.js", () => ({
  findById: vi.fn(),
  findStockEntriesByCustomer: vi.fn(),
  countStockEntriesByCustomer: vi.fn(),
}));
vi.mock("#modules/settings/settings.service.js", () => ({
  getCompanyTimezone: vi.fn(async () => "Europe/London"),
  getRegionalSettings: vi.fn(async () => ({ dateFormat: "dd/MM/yyyy", timezone: "Europe/London" })),
  getCloudinaryCreds: vi.fn(),
  getStockCodePrefix: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as customerRepo from "./customer.repository.js";
import {
  exportCustomerStockCsv,
  exportOwnStockCsv,
  listCustomerStockEntries,
  listCustomerStockEntriesPaged,
} from "./customer.service.js";

const CUST = "c".repeat(24);
const repo = vi.mocked(customerRepo);

/** The filters object the repository was handed on the Nth call. */
const filtersOnCall = (n = 0) => repo.findStockEntriesByCustomer.mock.calls[n]?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  repo.findById.mockResolvedValue({ id: CUST, deletedAt: null } as never);
  repo.countStockEntriesByCustomer.mockResolvedValue(0 as never);
  repo.findStockEntriesByCustomer.mockResolvedValue([] as never);
});

const FILTERS = {
  status: "in_stock",
  search: "CAT6",
  warehouseId: "w".repeat(24),
  receivedFrom: "2026-08-01",
  receivedTo: "2026-08-31",
};

describe("the received-date window reaches the export", () => {
  it("sends a resolved window, not the raw strings and not nothing", async () => {
    await exportOwnStockCsv(CUST, FILTERS);
    const f = filtersOnCall();
    expect(f.receivedWindow).toBeDefined();
    // Resolved to real instants by the shared date engine, in COMPANY time. August is BST (UTC+1),
    // so the inclusive day 2026-08-01 starts at 23:00 UTC on 31 July — the off-by-one-day trap that
    // makes a naive UTC boundary drop a whole day of a customer's stock.
    const w = f.receivedWindow as { gte: Date; lt: Date };
    expect(w.gte.toISOString()).toBe("2026-07-31T23:00:00.000Z");
    // `to` is inclusive AS A CALENDAR DAY: the bound is the start of the day AFTER it.
    expect(w.lt.toISOString()).toBe("2026-08-31T23:00:00.000Z");
  });

  it("carries every other filter alongside it", async () => {
    await exportOwnStockCsv(CUST, FILTERS);
    expect(filtersOnCall()).toMatchObject({ status: "in_stock", search: "CAT6", warehouseId: FILTERS.warehouseId });
  });

  it("leaves the window UNBOUNDED when no dates were given — an export is not silently narrowed either", async () => {
    await exportOwnStockCsv(CUST, { status: "in_stock" });
    // The shared engine's "no dates" answer is an empty window, not a pair of bounds. Asserting the
    // shape rather than `undefined` pins the contract the list already relies on: absent means
    // absent, never a window that quietly excludes rows at one end.
    expect(filtersOnCall().receivedWindow).toEqual({});
  });
});

describe("the export's filters are the LIST's filters", () => {
  it("matches the admin list byte for byte", async () => {
    await listCustomerStockEntries(CUST, { ...FILTERS, page: 2, pageSize: 25 });
    await exportCustomerStockCsv(CUST, FILTERS);
    // Paging is the ONLY difference — an export is the whole filtered set, never the page on screen.
    expect(filtersOnCall(1)).toEqual(filtersOnCall(0));
  });

  it("matches the portal list byte for byte", async () => {
    await listCustomerStockEntriesPaged(CUST, { ...FILTERS, page: 3, pageSize: 20 });
    await exportOwnStockCsv(CUST, FILTERS);
    expect(filtersOnCall(1)).toEqual(filtersOnCall(0));
  });

  it("does not inherit the list's paging — it asks for the whole set", async () => {
    await exportOwnStockCsv(CUST, { ...FILTERS, page: 4, pageSize: 20 });
    expect(repo.findStockEntriesByCustomer.mock.calls[0]?.[2]).toMatchObject({ skip: 0 });
    expect((repo.findStockEntriesByCustomer.mock.calls[0]?.[2] as { take: number }).take).toBeGreaterThan(20);
  });
});
