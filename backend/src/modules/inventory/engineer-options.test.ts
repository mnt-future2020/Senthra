import { beforeEach, describe, expect, it, vi } from "vitest";

// The engineer OPTION list, which every engineer picker in the app is fed from.
//
// It briefly became one page of the (newly paged) engineer lens, and the server clamps pageSize to
// 100 — so a team of more than a hundred silently lost everyone past the hundredth from the transfer
// composer, the movement feed and the custom-report filters, with nothing on screen saying the list
// was partial. An option that cannot be picked is worse than a slow list.

vi.mock("#modules/engineer/engineer.repository.js", () => ({
  findEngineers: vi.fn(),
  findAllBalances: vi.fn(async () => []),
}));
vi.mock("./inventory.repository.js", () => ({ findAllBalancesForAggregation: vi.fn(async () => []) }));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({
  findAllCustomerHoldings: vi.fn(async () => []),
  findAllDamaged: vi.fn(async () => []),
}));
vi.mock("#modules/goods-management/goods-management.service.js", () => ({
  getOverdueSummary: vi.fn(async () => ({ count: 0, days: 14 })),
}));
vi.mock("#modules/customer/customer.repository.js", () => ({ findActiveStockEntries: vi.fn(async () => []) }));
vi.mock("#modules/job/job.repository.js", () => ({ countActiveJobsByEngineer: vi.fn(async () => new Map()) }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getRegionalSettings: vi.fn(async () => ({ timezone: "Europe/London", dateFormat: "dd/MM/yyyy" })),
}));
vi.mock("#modules/document/document.formatter.js", () => ({ formatDateTime: () => "" }));

import * as engineerRepo from "#modules/engineer/engineer.repository.js";
import { listEngineerOptions, listEngineerInventoryPaged } from "./aggregation.service.js";

/** `n` engineers, named so that sort order is checkable and the 101st is findable. */
const roster = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `eng-${i + 1}`,
    firstName: "Engineer",
    lastName: String(i + 1).padStart(4, "0"),
    email: `eng${i + 1}@example.com`,
  }));

beforeEach(() => {
  vi.mocked(engineerRepo.findEngineers).mockResolvedValue(roster(250) as never);
});

describe("engineer options are COMPLETE", () => {
  it("returns every engineer, not one page of them", async () => {
    // The regression returned exactly 100 here.
    expect(await listEngineerOptions()).toHaveLength(250);
  });

  it("includes the 101st engineer and beyond", async () => {
    const ids = new Set((await listEngineerOptions()).map((e) => e.engineerId));
    expect(ids.has("eng-101")).toBe(true);
    expect(ids.has("eng-250")).toBe(true);
  });

  it("is ordered by name so a picker reads alphabetically", async () => {
    const names = (await listEngineerOptions()).map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("carries only what a picker needs — id, name, email", async () => {
    const [first] = await listEngineerOptions();
    expect(Object.keys(first!).sort()).toEqual(["email", "engineerId", "name"]);
  });
});

describe("the LIST view stays paged — the two reads are not the same thing", () => {
  it("pages the lens while the options stay complete", async () => {
    const page = await listEngineerInventoryPaged({ pageSize: 25 });
    expect(page.rows).toHaveLength(25);
    expect(page.total).toBe(250);
    // Same underlying roster, two different contracts: a list must not load everyone, a picker must.
    expect(await listEngineerOptions()).toHaveLength(250);
  });

  it("the lens still filters and counts what it pages", async () => {
    const page = await listEngineerInventoryPaged({ search: "0101", pageSize: 25 });
    expect(page.total).toBe(1);
    expect(page.rows[0]!.engineerId).toBe("eng-101");
  });
});
