import { describe, expect, it, vi } from "vitest";

// FILTER → EXPORT PARITY at the CONTROLLER boundary.
//
// This is where the two inventory exports were actually broken, and neither service nor repository
// could have caught it: the list and the export each read `req.query` with their own literal, and
// the export's copy was the shorter one. `irmItem` was in the list's and not the export's, so a
// request narrowed to ONE item downloaded every item's per-warehouse balances.
//
// Both now go through one parser per screen. These tests assert the PARAMS OBJECT the service is
// handed, because that is the only place a dropped filter is visible — the rendered CSV of a mocked
// service looks identical either way.

vi.mock("./inventory.service.js", () => ({
  listInventory: vi.fn(async () => ({ inventory: [], total: 0, page: 1, pageSize: 20, totalPages: 1, totalValuePence: 0, totalValue: 0 })),
  exportInventoryCsv: vi.fn(async () => ({ csv: "", count: 0, capped: false })),
}));
vi.mock("./aggregation.service.js", () => ({
  listStockPositions: vi.fn(async () => ({ positions: [], total: 0, page: 1, pageSize: 25, totalPages: 1 })),
  exportAllPositionsCsv: vi.fn(async () => ({ csv: "", count: 0, capped: false })),
}));
vi.mock("./movement.service.js", () => ({
  listMovements: vi.fn(),
  exportMovementsCsv: vi.fn(async () => ({ csv: "", capped: false })),
  movementFiltersFrom: vi.fn((q: Record<string, unknown>) => q),
}));

import * as inventoryService from "./inventory.service.js";
import * as aggregation from "./aggregation.service.js";
import { exportAllPositionsCsv, exportInventoryCsv, listInventory, listPositions } from "./inventory.controller.js";

/** A request carrying `query`, and a response that records nothing we assert on. */
const call = async (handler: unknown, query: Record<string, string>) => {
  const req = { query, params: {}, user: undefined } as never;
  const res = { json: vi.fn(), send: vi.fn(), setHeader: vi.fn() } as never;
  await (handler as (q: never, r: never, n: () => void) => Promise<void>)(req, res, () => {});
};

// Every filter the Inventory list offers, with a distinct value each so a dropped one is unambiguous.
const INVENTORY_QUERY = {
  search: "CAT6",
  warehouse: "w".repeat(24),
  irmItem: "i".repeat(24),
  category: "c".repeat(24),
  status: "low_stock",
  page: "3",
  pageSize: "20",
};

describe("inventory export carries the list's filters", () => {
  it("forwards irmItem — the filter that used to be dropped", async () => {
    await call(exportInventoryCsv, INVENTORY_QUERY);
    expect(vi.mocked(inventoryService.exportInventoryCsv).mock.calls.at(-1)?.[0]).toMatchObject({ irmItem: INVENTORY_QUERY.irmItem });
  });

  it("hands the export EXACTLY the list's filters, minus paging", async () => {
    await call(listInventory, INVENTORY_QUERY);
    await call(exportInventoryCsv, INVENTORY_QUERY);
    const listed = { ...(vi.mocked(inventoryService.listInventory).mock.calls.at(-1)?.[0] as Record<string, unknown>) };
    const exported = vi.mocked(inventoryService.exportInventoryCsv).mock.calls.at(-1)?.[0];
    // The page on screen is the one thing an export must NOT inherit.
    delete listed.page;
    delete listed.pageSize;
    expect(exported).toEqual(listed);
  });

  it("does not smuggle paging into the export, even when the query string carries it", async () => {
    await call(exportInventoryCsv, INVENTORY_QUERY);
    const params = vi.mocked(inventoryService.exportInventoryCsv).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(params.page).toBeUndefined();
    expect(params.pageSize).toBeUndefined();
  });
});

// Every filter the Stock Positions screen offers. `engineerSearch` is the engineer lens's own, which
// the field-stock download used to send NONE of. `holding` is in the query string on purpose: the
// positions surface must IGNORE it (see positions.engineer-filter.test.ts for why).
const POSITION_QUERY = {
  ownership: "company",
  location: "engineer",
  warehouse: "w".repeat(24),
  category: "Cables",
  search: "CAT6",
  status: "in_stock",
  customer: "c".repeat(24),
  engineerSearch: "kansha",
  holding: "1",
  page: "2",
  pageSize: "25",
};

describe("stock positions export carries the list's filters", () => {
  it("hands the export EXACTLY the list's filters, minus paging", async () => {
    await call(listPositions, POSITION_QUERY);
    await call(exportAllPositionsCsv, POSITION_QUERY);
    const listed = { ...(vi.mocked(aggregation.listStockPositions).mock.calls.at(-1)?.[0] as Record<string, unknown>) };
    const exported = vi.mocked(aggregation.exportAllPositionsCsv).mock.calls.at(-1)?.[0];
    delete listed.page;
    delete listed.pageSize;
    expect(exported).toEqual(listed);
  });

  it("forwards the engineer lens's search", async () => {
    await call(exportAllPositionsCsv, POSITION_QUERY);
    expect(vi.mocked(aggregation.exportAllPositionsCsv).mock.calls.at(-1)?.[0]).toMatchObject({
      engineerSearch: "kansha",
      locationType: "engineer",
    });
  });

  it("does NOT forward `holding` — it is a lens filter, not a position filter", async () => {
    // It used to be read here as `queryStr(q.holding) ? true : undefined`, which made `?holding=false`
    // mean TRUE and, worse, silently restricted the whole positions set to engineer-held rows. The
    // parser no longer reads it at all; the lens's own endpoint still does, through queryBool.
    await call(exportAllPositionsCsv, { ...POSITION_QUERY, holding: "false" });
    const params = vi.mocked(aggregation.exportAllPositionsCsv).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(params.holdingOnly).toBeUndefined();
    expect(params.holding).toBeUndefined();
  });

  it("collapses a DUPLICATED query parameter rather than passing an array to the filter", async () => {
    // `?warehouse=a&warehouse=b` arrives as an array. The list has always read these through the
    // shared `queryStr`; the export's old literal cast them straight through as `string`.
    await call(exportAllPositionsCsv, { warehouse: ["a".repeat(24), "b".repeat(24)] } as never);
    expect((vi.mocked(aggregation.exportAllPositionsCsv).mock.calls.at(-1)?.[0] as Record<string, unknown>).warehouseId).toBe("a".repeat(24));
  });
});
