import { describe, expect, it, vi } from "vitest";

/**
 * FILTER → EXPORT PARITY on the CLIENT side of the wire.
 *
 * The server can only honour a filter it is sent. Every export here is meant to hit the list's own
 * endpoint with the list's own query string minus paging, and the mechanism is that both go through
 * ONE serialiser per service — so a filter added to the list's `qs()` reaches the download for free.
 *
 * These tests hold the URL each export actually requests against the URL its list requests. Asserting
 * the URL rather than the parameters object is the point: the object can be right while the
 * serialiser silently omits a key, which is precisely how Goods In once shipped a date filter that
 * the list sent and the cache key did not.
 */

const requested: string[] = [];

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (url: string) => {
    requested.push(url);
    return { total: 0, page: 1, pageSize: 20, totalPages: 1, users: [], customers: [], jobs: [], suppliers: [], warehouses: [], items: [], goodsReceipts: [], purchaseOrders: [], purchaseRequests: [], inventory: [], entries: [], requests: [], positions: [], rows: [] };
  }),
  apiFile: vi.fn(async (url: string) => {
    requested.push(url);
    return { blob: new Blob([""]), headers: {} };
  }),
  LONG_WRITE_TIMEOUT: 60_000,
}));
vi.mock("@/lib/download", () => ({ downloadBlob: vi.fn(), filenameFromDisposition: () => "x.csv" }));
vi.mock("@/lib/clientCache", () => ({ registerClientCache: vi.fn() }));

import * as customerService from "./customer.service";
import * as goodsInService from "./goods-in.service";
import * as inventoryService from "./inventory.service";
import * as irmService from "./irm.service";
import * as jobService from "./job.service";
import * as poService from "./purchase-order.service";
import * as prfService from "./purchase-request.service";
import * as stockPositionService from "./stockPosition.service";
import * as supplierService from "./supplier.service";
import * as userService from "./user.service";
import * as warehouseService from "./warehouse.service";

const paramsOf = (url = "") => new URLSearchParams(url.slice(url.indexOf("?") + 1));

/** Run a list call and an export call, and return the query string each produced. */
async function pair(list: () => Promise<unknown>, exp: () => Promise<unknown>) {
  requested.length = 0;
  await list();
  await exp();
  const [listed, exported] = requested;
  return { listed: paramsOf(listed), exported: paramsOf(exported), listedUrl: listed ?? "", exportedUrl: exported ?? "" };
}

const PAGING = new Set(["page", "pageSize", "cursor", "limit"]);

/** Every filter the list sent, except paging, must appear identically on the export — and no more. */
function expectSameFilters(listed: URLSearchParams, exported: URLSearchParams) {
  for (const [k, v] of listed) {
    if (PAGING.has(k)) continue;
    expect(exported.get(k), `filter "${k}" is on the list but not on the export`).toBe(v);
  }
  // …and the export must not invent one either — a widening filter is as wrong as a dropped one.
  for (const k of exported.keys()) {
    expect(PAGING.has(k) || listed.has(k), `export sent "${k}", which the list did not`).toBe(true);
  }
  // Paging never travels: an export is the whole filtered set, not the page on screen.
  for (const k of PAGING) expect(exported.has(k), `export inherited "${k}" from the list`).toBe(false);
}

// One distinct value per filter, so a dropped one cannot be masked by another's value.
const P = (over: Record<string, unknown> = {}) => ({ page: 3, pageSize: 25, ...over });

describe("each export requests the list's filters, minus paging", () => {
  it("Users — search, status, role and the added-date window", async () => {
    const f = P({ search: "kansha", status: "active", roleId: "r".repeat(24), addedFrom: "2026-08-01", addedTo: "2026-08-31", sort: "name" });
    const { listed, exported } = await pair(() => userService.listUsers(f), () => userService.exportUsersCsv(f));
    expectSameFilters(listed, exported);
    expect(exported.get("addedFrom")).toBe("2026-08-01");
  });

  it("Jobs — every one of the eleven, including engineer, site and both date windows", async () => {
    const f = P({
      search: "fibre",
      status: "completed",
      customer: "c".repeat(24),
      engineer: "e".repeat(24),
      project: "p".repeat(24),
      site: "s".repeat(24),
      priority: "high",
      dueFrom: "2026-08-01",
      dueTo: "2026-08-31",
      createdFrom: "2026-07-01",
      createdTo: "2026-07-31",
      sort: "oldest",
    });
    const { listed, exported } = await pair(() => jobService.listJobs(f), () => jobService.exportJobsCsv(f));
    expectSameFilters(listed, exported);
    for (const k of ["engineer", "site", "dueFrom", "dueTo", "createdFrom", "createdTo"]) {
      expect(exported.has(k), `jobs export dropped "${k}"`).toBe(true);
    }
  });

  it("Inventory — including irmItem, the filter the server used to drop", async () => {
    const f = P({ search: "CAT6", warehouse: "w".repeat(24), irmItem: "i".repeat(24), category: "c".repeat(24), status: "low_stock" });
    const { listed, exported } = await pair(() => inventoryService.listInventory(f), () => inventoryService.exportInventoryCsv(f));
    expectSameFilters(listed, exported);
    expect(exported.get("irmItem")).toBe("i".repeat(24));
  });

  it("Purchase Orders — supplier, warehouse, status, PM, job and BOTH date windows", async () => {
    const f = P({
      search: "PO", status: "issued", priority: "high", supplier: "s".repeat(24), warehouse: "w".repeat(24),
      pm: "u".repeat(24), job: "j".repeat(24),
      orderedFrom: "2026-08-01", orderedTo: "2026-08-31", expectedFrom: "2026-09-01", expectedTo: "2026-09-30",
      sort: "oldest",
    });
    const headers = await pair(() => poService.listPurchaseOrders(f), () => poService.exportPurchaseOrdersCsv(f));
    expectSameFilters(headers.listed, headers.exported);
    for (const k of ["orderedFrom", "orderedTo", "expectedFrom", "expectedTo", "supplier", "warehouse"]) {
      expect(headers.exported.has(k), `PO export dropped "${k}"`).toBe(true);
    }
    // The per-LINE file is a different SHAPE, never a different SET.
    const lines = await pair(() => poService.listPurchaseOrders(f), () => poService.exportPurchaseOrderLinesCsv(f));
    expectSameFilters(lines.listed, lines.exported);
  });

  it("Purchase Requests — header and line exports both", async () => {
    const f = P({
      search: "PRF", status: "approved", supplier: "s".repeat(24), warehouse: "w".repeat(24), job: "j".repeat(24),
      requiredFrom: "2026-08-01", requiredTo: "2026-08-31", validFrom: "2026-07-01", validTo: "2026-07-31",
    });
    const headers = await pair(() => prfService.listPurchaseRequests(f), () => prfService.exportPurchaseRequestsCsv(f));
    expectSameFilters(headers.listed, headers.exported);
    for (const k of ["requiredFrom", "requiredTo", "validFrom", "validTo"]) {
      expect(headers.exported.has(k), `PRF export dropped "${k}"`).toBe(true);
    }
    const lines = await pair(() => prfService.listPurchaseRequests(f), () => prfService.exportPurchaseRequestLinesCsv(f));
    expectSameFilters(lines.listed, lines.exported);
  });

  it("Goods In — the received-date window, on both files", async () => {
    const f = P({ search: "GRN", status: "posted", supplier: "s".repeat(24), warehouse: "w".repeat(24), receivedFrom: "2026-08-01", receivedTo: "2026-08-31" });
    const headers = await pair(() => goodsInService.listGoodsReceipts(f), () => goodsInService.exportGoodsReceiptsCsv(f));
    expectSameFilters(headers.listed, headers.exported);
    expect(headers.exported.get("receivedFrom")).toBe("2026-08-01");
    const lines = await pair(() => goodsInService.listGoodsReceipts(f), () => goodsInService.exportGoodsReceiptLinesCsv(f));
    expectSameFilters(lines.listed, lines.exported);
  });

  it("Suppliers, Warehouses and the IRM catalogue", async () => {
    const sf = P({ search: "a", status: "active", type: "t" });
    const s = await pair(() => supplierService.listSuppliers(sf), () => supplierService.exportSuppliersCsv(sf));
    expectSameFilters(s.listed, s.exported);

    const wf = P({ search: "b", status: "active", type: "main" });
    const w = await pair(() => warehouseService.listWarehouses(wf), () => warehouseService.exportWarehousesCsv(wf));
    expectSameFilters(w.listed, w.exported);

    const inf = P({ search: "CAT6", status: "active", type: "t".repeat(24), category: "c".repeat(24), supplier: "s".repeat(24) });
    const irm = await pair(() => irmService.listIrmItems(inf), () => irmService.exportIrmItemsCsv(inf));
    expectSameFilters(irm.listed, irm.exported);
  });

  it("Customers", async () => {
    const f = P({ search: "acme", status: "active" });
    const { listed, exported } = await pair(() => customerService.listCustomers(f), () => customerService.exportCustomersCsv(f));
    expectSameFilters(listed, exported);
  });

  it("Stock positions — every dimension, plus the engineer lens's own two", async () => {
    const f = P({
      ownership: "company",
      location: "engineer",
      warehouse: "w".repeat(24),
      category: "Cables",
      search: "CAT6",
      status: "in_stock",
      customer: "c".repeat(24),
      engineerSearch: "kansha",
    });
    const { listed, exported } = await pair(() => stockPositionService.listPositions(f), () => stockPositionService.exportPositionsCsv(f));
    expectSameFilters(listed, exported);
    // The lens filter the field-stock download used to send NONE of.
    expect(exported.get("engineerSearch")).toBe("kansha");
    // `holding` is deliberately absent from PositionParams: it cannot change which positions exist,
    // and reading it server-side dragged the location scope with it. Its presence here would mean
    // the type had regrown it.
    expect(exported.has("holding")).toBe(false);
  });

  it("Stock movements — the whole ledger filter set, with no cursor", async () => {
    const f = {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      irmItem: "i".repeat(24),
      warehouse: "w".repeat(24),
      engineer: "e".repeat(24),
      customer: "c".repeat(24),
      ownership: "company",
      location: "engineer",
      type: "issue",
      sourceType: "job",
    };
    const { listed, exported } = await pair(
      () => stockPositionService.listMovements({ ...f, cursor: "abc", limit: 50 }),
      () => stockPositionService.exportMovementsCsv(f),
    );
    expectSameFilters(listed, exported);
  });

  it("Customer stock (admin tab) — the received-date window the server used to drop", async () => {
    const id = "c".repeat(24);
    requested.length = 0;
    await customerService.exportCustomerStockCsv(id, {
      q: "CAT6",
      status: "in_stock",
      warehouseId: "w".repeat(24),
      receivedFrom: "2026-08-01",
      receivedTo: "2026-08-31",
      page: 2,
      pageSize: 20,
    });
    const exported = paramsOf(requested[0]);
    expect(exported.get("receivedFrom")).toBe("2026-08-01");
    expect(exported.get("receivedTo")).toBe("2026-08-31");
    expect(exported.get("warehouseId")).toBe("w".repeat(24));
    expect(exported.has("page")).toBe(false);
  });

  it("Portal jobs — filters by the query, tenancy by the session", async () => {
    const f = { q: "fibre", status: "completed", dueFrom: "2026-08-01", dueTo: "2026-08-31", site: "s".repeat(24), sort: "oldest" };
    const { listed, exported, exportedUrl } = await pair(
      () => jobService.getOwnJobs({ ...f, page: 2, pageSize: 20 }),
      () => jobService.exportOwnJobsCsv(f),
    );
    expectSameFilters(listed, exported);
    // The customer id is NEVER in the query string — it comes from the session, so no export
    // parameter can reach another tenant's rows.
    expect(exportedUrl.split("?")[0]).toBe("/customer/jobs/export.csv");
    expect(exported.has("customerId")).toBe(false);
  });
});

describe("the export hits the list's own endpoint", () => {
  it("uses the matching export path, never a second unfiltered one", async () => {
    const f = P({ search: "x" });
    const { listedUrl, exportedUrl } = await pair(() => jobService.listJobs(f), () => jobService.exportJobsCsv(f));
    expect(listedUrl.split("?")[0]).toBe("/jobs");
    expect(exportedUrl.split("?")[0]).toBe("/jobs/export.csv");
  });
});
