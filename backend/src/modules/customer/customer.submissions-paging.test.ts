import { beforeEach, describe, expect, it, vi } from "vitest";

// The Stock Submissions tab's server-side migration, finished.
//
// The table was paged first but the tab still built its status MENU and its empty-state counts from
// `customer.stockRequests` — the whole collection, embedded in the customer detail payload. So the
// payload still carried every submission an account had ever made, the migration's whole point was
// unrealised, and the menu and the table were two states that could drift.
//
// The counts are page metadata now. The rule that makes the menu navigable: `statusCounts` ignores
// the STATUS filter, because a menu that only counted the selected status could not tell you what
// the others hold — the same failure the damaged-pool switcher had.

vi.mock("./customer.repository.js", () => ({
  findById: vi.fn(),
  findStockRequestsByCustomer: vi.fn(),
  countStockRequestsByCustomer: vi.fn(),
  countStockRequestsByStatus: vi.fn(),
}));
vi.mock("#modules/settings/settings.service.js", () => ({ getCompanyTimezone: vi.fn(async () => "Europe/London") }));

import * as customerRepo from "./customer.repository.js";
import { listStockRequests } from "./customer.service.js";

const CUST = "aaaaaaaaaaaaaaaaaaaaaaaa";

const submissions = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `req-${i + 1}`,
    name: `Submission ${i + 1}`,
    editedName: null,
    status: i % 2 === 0 ? "pending" : "completed",
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
    warehouseAssignments: [],
  }));

beforeEach(() => {
  vi.mocked(customerRepo.findById).mockResolvedValue({ id: CUST, deletedAt: null } as never);
  vi.mocked(customerRepo.countStockRequestsByCustomer).mockResolvedValue(250 as never);
  vi.mocked(customerRepo.countStockRequestsByStatus).mockResolvedValue({ pending: 125, completed: 125 } as never);
  vi.mocked(customerRepo.findStockRequestsByCustomer).mockResolvedValue(submissions(20) as never);
});

describe("submissions are paged at the database", () => {
  it("returns ONE page of a large set, with the true total", async () => {
    const res = await listStockRequests(CUST, { page: 1, pageSize: 20 });
    expect(res.requests).toHaveLength(20);
    expect(res.total).toBe(250);
    expect(res.totalPages).toBe(13);
  });

  it("asks the repository for the requested slice, not the whole history", async () => {
    await listStockRequests(CUST, { page: 3, pageSize: 20 });
    const [, , page] = vi.mocked(customerRepo.findStockRequestsByCustomer).mock.calls.at(-1)!;
    expect(page).toEqual({ skip: 40, take: 20 });
  });

  it("counts and pages the SAME filter set — the paginator cannot walk off the end", async () => {
    await listStockRequests(CUST, { status: "pending", search: "widget", page: 1 });
    const countFilters = vi.mocked(customerRepo.countStockRequestsByCustomer).mock.calls.at(-1)![1];
    const pageFilters = vi.mocked(customerRepo.findStockRequestsByCustomer).mock.calls.at(-1)![1];
    expect(countFilters).toEqual(pageFilters);
  });
});

describe("the status menu is page METADATA, not the collection", () => {
  it("returns per-status counts alongside the page", async () => {
    const res = await listStockRequests(CUST, { page: 1 });
    expect(res.statusCounts).toEqual({ pending: 125, completed: 125 });
  });

  it("counts ignore the STATUS filter, so the menu can still offer the others", async () => {
    await listStockRequests(CUST, { status: "pending" });
    const filters = vi.mocked(customerRepo.countStockRequestsByStatus).mock.calls.at(-1)![1];
    // The status is deliberately dropped for this query — picking "Pending" must not make every
    // other option read zero and disappear.
    expect(filters?.status).toBeUndefined();
  });

  it("counts DO respect search and the date window — they describe the searched set", async () => {
    await listStockRequests(CUST, { search: "widget", raisedFrom: "2026-08-01", raisedTo: "2026-08-31" });
    const filters = vi.mocked(customerRepo.countStockRequestsByStatus).mock.calls.at(-1)![1];
    expect(filters?.search).toBe("widget");
    expect(filters?.raisedWindow?.gte).toBeInstanceOf(Date);
  });

  it("an empty result still reports the counts, so the menu survives it", async () => {
    vi.mocked(customerRepo.findStockRequestsByCustomer).mockResolvedValue([] as never);
    vi.mocked(customerRepo.countStockRequestsByCustomer).mockResolvedValue(0 as never);
    vi.mocked(customerRepo.countStockRequestsByStatus).mockResolvedValue({ completed: 12 } as never);
    const res = await listStockRequests(CUST, { status: "pending" });
    expect(res.requests).toEqual([]);
    expect(res.total).toBe(0);
    // There is nothing pending, but the tab can still say twelve are completed — and get back to them.
    expect(res.statusCounts).toEqual({ completed: 12 });
  });
});
