import { beforeEach, describe, expect, it, vi } from "vitest";

const mv = vi.hoisted(() => ({ listMovements: vi.fn() }));
const repo = vi.hoisted(() => ({ findMovementJobProjects: vi.fn(), findEngineerHoldings: vi.fn() }));
vi.mock("#modules/inventory/movement.service.js", () => mv);
vi.mock("#modules/inventory/movement.js", () => ({ decodeCursor: (v: string | null) => (v ? { t: 1, id: v } : null) }));
vi.mock("./customReports.repository.js", () => repo);

import { runCustomReport, listAvailableReports, REPORT_MAX_ROWS } from "./customReports.service.js";
import { CUSTOM_REPORTS, findReport, reportsFor } from "./customReports.registry.js";

const STAFF = { id: "u1", type: "user" as const, email: "pm@x.co", permissions: ["reports.view"] };
const CUSTOMER = { id: "c1", type: "customer" as const, email: "bt@x.co", permissions: [] };

const movement = (over: Record<string, unknown> = {}) => ({
  id: "inventory:tx1",
  date: "2026-05-05T09:00:00.000Z",
  label: "Issued to engineer",
  itemName: "SFP-LX",
  itemCode: "IRM-0010",
  quantityDelta: -1,
  locationLabel: "Leeds Depot",
  engineerId: "eng1",
  toLabel: "Karthik",
  fromLabel: null,
  customerName: "BT",
  reference: "GM-0001",
  sourceType: "goods_management",
  sourceId: "jsm1",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mv.listMovements.mockResolvedValue({ movements: [movement()], nextCursor: null, hasMore: false });
  repo.findMovementJobProjects.mockResolvedValue(new Map());
  repo.findEngineerHoldings.mockResolvedValue([]);
});

describe("the registry is the only surface — the client never describes a query", () => {
  it("rejects an unknown report key", async () => {
    await expect(runCustomReport(STAFF, { reportKey: "drop_tables", filters: {} })).rejects.toThrow(/isn't available/i);
  });

  it("rejects a filter the report does not declare, rather than ignoring it", async () => {
    // Silently widening is worse than refusing: the user would believe the result was scoped.
    await expect(
      runCustomReport(STAFF, { reportKey: "engineer_stock", filters: { customerId: "c1" } }),
    ).rejects.toThrow(/can't be filtered by customerId/i);
  });

  it("rejects a filter name that is not in the vocabulary at all", async () => {
    await expect(
      runCustomReport(STAFF, { reportKey: "stock_movement", filters: { sortBy: "price" } as never }),
    ).rejects.toThrow(/unknown filter/i);
  });

  it("every registered report declares columns, filters and a source", () => {
    for (const r of CUSTOM_REPORTS) {
      expect(r.columns.length, `${r.key} has no columns`).toBeGreaterThan(0);
      expect(r.filters.length, `${r.key} declares no filters`).toBeGreaterThan(0);
      expect(r.source.length).toBeGreaterThan(0);
    }
  });

  // Money belongs to the Finance module. If a costed report is ever added it must set `financial`,
  // which is what makes the service demand the finance right for it.
  it("ships no financial report today, so none can leak money through this path", () => {
    expect(CUSTOM_REPORTS.filter((r) => r.financial)).toEqual([]);
  });
});

describe("Stock Movement — the FLOW 10B example", () => {
  it("returns the client's columns and passes the date range through", async () => {
    const res = await runCustomReport(STAFF, {
      reportKey: "stock_movement",
      filters: { dateFrom: "2026-05-01", dateTo: "2026-05-31", customerId: "cust1" },
    });
    expect(res.report.columns.map((c) => c.header)).toEqual(
      expect.arrayContaining(["Item", "Quantity", "Date", "Engineer", "Site / Warehouse"]),
    );
    expect(res.rows[0]).toMatchObject({ itemName: "SFP-LX", quantity: -1, engineerName: "Karthik", location: "Leeds Depot" });
    const filters = mv.listMovements.mock.calls[0]![0];
    expect(filters.dateFrom).toEqual(new Date("2026-05-01"));
    // A date-only upper bound must include the whole day — otherwise "to 31 May" silently drops it.
    expect(filters.dateTo?.toISOString()).toBe("2026-05-31T23:59:59.999Z");
  });

  // The unified feed already de-duplicates a physical event that touched two ledgers via its
  // synthetic `${ledger}:${rawId}` id. This report is a projection of those rows, so it inherits that
  // — the test pins that we did NOT re-query the ledgers ourselves and reintroduce the duplicate.
  it("reads the unified feed rather than any individual ledger", async () => {
    await runCustomReport(STAFF, { reportKey: "stock_movement", filters: {} });
    expect(mv.listMovements).toHaveBeenCalledTimes(1);
  });

  // ── Warehouse scope crosses this boundary as the ACTOR ──────────────────────────────────────
  //
  // This assertion used to read `listMovements.mock.calls[0][0].scopeWarehouseIds`, i.e. the scope the
  // report computed and put on the filter object. It passed while the feature was broken, because
  // `listMovements` OVERWRITES `scopeWarehouseIds` from its own 4th argument — an actor the report
  // never passed — so the scope was discarded and every warehouse-scoped user read company-wide.
  // Asserting a mock's input proved the caller's intent and nothing about the result.
  //
  // The contract is therefore pinned here as what it actually is (the actor reaches the movement
  // service, which owns the derivation), and the OUTCOME is pinned in customReports.scope.test.ts,
  // which runs the real movement service against repository spies.
  it("hands the movement service the ACTOR, which is what derives the warehouse scope", async () => {
    await runCustomReport(STAFF, { reportKey: "stock_movement", filters: {} });
    expect(mv.listMovements.mock.calls[0]![3]).toBe(STAFF);
  });

  it("computes no warehouse scope of its own — there is one home for that rule", async () => {
    // A `scopeWarehouseIds` set here would be dead code at best and a second, divergent copy of the
    // authorization rule at worst. It must not appear on the filter at all.
    await runCustomReport(STAFF, { reportKey: "stock_movement", filters: {} });
    expect(mv.listMovements.mock.calls[0]![0]).not.toHaveProperty("scopeWarehouseIds");
  });

  // ── The export must PAGE the feed, not ask it for 5,000 in one go ────────────────────────────
  //
  // `movement.service.clampLimit` caps a single page at 100 — right for the ledger screen it was
  // built for, and silently wrong here. The export asked for `REPORT_MAX_ROWS`, was handed 100, and
  // reported `capped: false` because nothing downstream read `hasMore`: no X-Export-Capped header,
  // and a 100-row file that looked like the whole answer. The scheduled versions mailed that same
  // truncated workbook every month. Found by a live smoke test, not by any of these unit tests.
  it("never asks the feed for more than one page at a time", async () => {
    await runCustomReport(STAFF, { reportKey: "stock_movement", filters: {}, limit: 999_999 });
    for (const call of mv.listMovements.mock.calls) {
      expect(call[2], "a page request above the feed's own clamp is silently truncated").toBeLessThanOrEqual(100);
    }
  });

  it("keeps paging while the feed says there is more, up to the report cap", async () => {
    // Every page full and claiming more — the feed can never satisfy 5,000 in one call.
    mv.listMovements.mockImplementation(async (_f: unknown, _c: unknown, size: number) => ({
      movements: Array.from({ length: size }, (_, i) => movement({ id: `inventory:tx${i}` })),
      nextCursor: "more",
      hasMore: true,
    }));

    const res = await runCustomReport(STAFF, { reportKey: "stock_movement", filters: {}, limit: REPORT_MAX_ROWS });

    expect(res.rows).toHaveLength(REPORT_MAX_ROWS);
    expect(mv.listMovements.mock.calls.length).toBe(REPORT_MAX_ROWS / 100);
    expect(res.capped, "it stopped at the ceiling, and must say so").toBe(true);
  });

  it("stops as soon as the feed runs out, without asking again", async () => {
    mv.listMovements.mockResolvedValue({ movements: [movement()], nextCursor: null, hasMore: false });
    const res = await runCustomReport(STAFF, { reportKey: "stock_movement", filters: {}, limit: REPORT_MAX_ROWS });
    expect(mv.listMovements).toHaveBeenCalledTimes(1);
    expect(res.rows).toHaveLength(1);
    expect(res.capped).toBe(false);
  });

  // The on-screen read is one page and must stay one request.
  it("makes exactly one request for the on-screen limit", async () => {
    await runCustomReport(STAFF, { reportKey: "stock_movement", filters: {}, limit: 100 });
    expect(mv.listMovements).toHaveBeenCalledTimes(1);
  });
});

describe("Project Activity", () => {
  it("resolves movements to their project in ONE batched read, not per row", async () => {
    mv.listMovements.mockResolvedValue({
      movements: [movement({ sourceId: "jsm1" }), movement({ id: "inventory:tx2", sourceId: "jsm2" })],
      nextCursor: null,
      hasMore: false,
    });
    repo.findMovementJobProjects.mockResolvedValue(
      new Map([
        ["jsm1", { jobNumber: "JOB-2026-0001", projectId: "prj1", projectName: "BT Core" }],
        ["jsm2", { jobNumber: "JOB-2026-0002", projectId: "prj1", projectName: "BT Core" }],
      ]),
    );
    const res = await runCustomReport(STAFF, { reportKey: "project_activity", filters: {} });
    expect(repo.findMovementJobProjects).toHaveBeenCalledTimes(1);
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ projectName: "BT Core", jobNumber: "JOB-2026-0001" });
  });

  it("narrows to one project when asked", async () => {
    mv.listMovements.mockResolvedValue({
      movements: [movement({ sourceId: "jsm1" }), movement({ id: "t2", sourceId: "jsm2" })],
      nextCursor: null,
      hasMore: false,
    });
    repo.findMovementJobProjects.mockResolvedValue(
      new Map([
        ["jsm1", { jobNumber: "J1", projectId: "prj1", projectName: "P1" }],
        ["jsm2", { jobNumber: "J2", projectId: "prj2", projectName: "P2" }],
      ]),
    );
    const res = await runCustomReport(STAFF, { reportKey: "project_activity", filters: { projectId: "prj1" } });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.projectName).toBe("P1");
  });

  // A movement with no job is warehouse plumbing, not project activity. Dropping it is correct;
  // bucketing it as "unknown project" would invent an attribution.
  it("drops a movement whose job cannot be resolved rather than inventing a project", async () => {
    repo.findMovementJobProjects.mockResolvedValue(new Map());
    const res = await runCustomReport(STAFF, { reportKey: "project_activity", filters: {} });
    expect(res.rows).toEqual([]);
  });
});

describe("customer isolation — FLOW 9", () => {
  it("forces the customer id from the session and ignores the query string", async () => {
    await runCustomReport(CUSTOMER, { reportKey: "stock_movement", filters: { customerId: "SOMEONE-ELSE" } }, {
      isCustomer: true,
      customerId: "my-own-id",
    });
    expect(mv.listMovements.mock.calls[0]![0].customerId).toBe("my-own-id");
  });

  it("restricts a customer to their own consignment stock, never company IRM", async () => {
    await runCustomReport(CUSTOMER, { reportKey: "stock_movement", filters: { itemKind: "irm" } }, {
      isCustomer: true,
      customerId: "c1",
    });
    expect(mv.listMovements.mock.calls[0]![0].ownership).toBe("customer");
  });

  it("refuses a report not marked customer-visible", async () => {
    await expect(
      runCustomReport(CUSTOMER, { reportKey: "project_activity", filters: {} }, { isCustomer: true, customerId: "c1" }),
    ).rejects.toThrow(/don't have access/i);
  });

  it("refuses outright when there is no customer context", async () => {
    await expect(
      runCustomReport(CUSTOMER, { reportKey: "stock_movement", filters: {} }, { isCustomer: true }),
    ).rejects.toThrow(/no customer context/i);
  });

  it("does not echo the customer id back in the applied filters", async () => {
    const res = await runCustomReport(CUSTOMER, { reportKey: "stock_movement", filters: {} }, {
      isCustomer: true,
      customerId: "c1",
    });
    expect(res.appliedFilters.customerId).toBeUndefined();
  });

  // The hard boundary: no customer-visible report may declare a money column, in any report, ever.
  it("no customer-visible report carries a price, cost, VAT or total column", () => {
    const money = /price|cost|vat|net|gross|total|charge|spend|value|amount/i;
    for (const r of reportsFor({ isCustomer: true, canFinance: false })) {
      for (const c of r.columns) {
        expect(money.test(c.header), `${r.key} exposes "${c.header}" to a customer`).toBe(false);
        expect(money.test(c.key), `${r.key} exposes "${c.key}" to a customer`).toBe(false);
      }
      expect(r.financial, `${r.key} is financial and customer-visible`).toBe(false);
    }
  });
});

describe("the catalogue offered to each audience", () => {
  it("offers a customer only the customer-safe subset", () => {
    const keys = listAvailableReports(undefined, true).map((r) => r.key);
    expect(keys).toEqual(["stock_movement"]);
  });

  it("offers staff every non-financial report", () => {
    const keys = listAvailableReports(STAFF, false).map((r) => r.key);
    expect(keys).toEqual(CUSTOM_REPORTS.map((r) => r.key));
  });

  it("findReport resolves a known key and rejects an unknown one", () => {
    expect(findReport("stock_movement")?.label).toBe("Stock Movement");
    expect(findReport("nope")).toBeUndefined();
  });
});

// ── FLOW 9 — the customer-facing surface, end to end ──────────────────────────────────────────
//
// The client requirement is a security boundary, stated twice in the flow: "NO pricing / cost data
// shown in customer reports". These pin the mechanism rather than the wording — a customer-safe
// RESULT from a customer-scoped ROUTE, not an internal result with columns hidden afterwards.
describe("FLOW 9 — customer report results are customer-safe by construction", () => {
  const run = () =>
    runCustomReport(CUSTOMER, { reportKey: "stock_movement", filters: {} }, { isCustomer: true, customerId: "bt" });

  it("returns rows whose every KEY and VALUE is free of financial data", async () => {
    mv.listMovements.mockResolvedValue({ movements: [movement()], nextCursor: null, hasMore: false });
    const res = await run();
    const money = /price|cost|vat|net|gross|total|charge|spend|value|amount|supplier/i;
    for (const row of res.rows) {
      for (const key of Object.keys(row)) {
        expect(money.test(key), `customer row exposes "${key}"`).toBe(false);
      }
    }
    // And the column contract the screen renders from carries none either.
    for (const c of res.report.columns) expect(money.test(c.header)).toBe(false);
  });

  it("cannot be widened to another customer by any filter the caller supplies", async () => {
    await runCustomReport(
      CUSTOMER,
      // Every hostile shape at once: a foreign customer, a warehouse, an engineer.
      { reportKey: "stock_movement", filters: { customerId: "victim", warehouseId: "wh9", engineerId: "eng9" } },
      { isCustomer: true, customerId: "bt" },
    );
    const f = mv.listMovements.mock.calls[0]![0];
    expect(f.customerId).toBe("bt");
    // A customer's own scope is their customer id — warehouse access scoping is a STAFF concept and
    // must not be derived from a customer principal. The actor still crosses the boundary (one rule,
    // one place), and a customer principal is unrestricted there: `actorFrom` gives every non-"user"
    // type `assignedWarehouseIds: null`, so nothing narrows and nothing widens.
    expect(f).not.toHaveProperty("scopeWarehouseIds");
    expect(mv.listMovements.mock.calls[0]![3]).toBe(CUSTOMER);
    expect(CUSTOMER).not.toHaveProperty("assignedWarehouseIds");
  });

  it("offers a customer no internal-only report type, even by direct key", async () => {
    for (const key of ["project_activity", "engineer_stock"]) {
      await expect(
        runCustomReport(CUSTOMER, { reportKey: key, filters: {} }, { isCustomer: true, customerId: "bt" }),
      ).rejects.toThrow(/don't have access/i);
    }
  });

  // The exports render the SAME result object the screen does, so they inherit its safety rather than
  // re-deriving it — which is the difference between "safe" and "safe until someone edits a renderer".
  it("hands the exports the identical customer-safe result", async () => {
    mv.listMovements.mockResolvedValue({ movements: [movement()], nextCursor: null, hasMore: false });
    const res = await run();
    expect(res.report.columns.map((c) => c.key)).toEqual(
      expect.arrayContaining(["itemName", "quantity", "date", "engineerName", "location"]),
    );
    expect(res.rows[0]).not.toHaveProperty("unitPricePence");
    expect(res.rows[0]).not.toHaveProperty("netPence");
  });
});

// ── Engineer Stock pages, and says so when it cannot ──────────────────────────────────────────
//
// A position report with no monotonic key to seek on, so it pages by OFFSET over an already-ordered
// set. It previously took the page size straight into the query and returned whatever came back:
//   • no `nextCursor` and no `hasMore`, so the screen showed 100 rows under a footer reading
//     "100 row(s)" with no control to reach the rest — silent truncation, the one thing a report may
//     never do; and
//   • `capped` counted the PAGE against the 5,000 ceiling, so hitting the ceiling was unreportable.
describe("engineer stock paging", () => {
  const holding = (i: number) => ({
    engineerName: `Engineer ${String(i).padStart(3, "0")}`,
    itemName: `Item ${i}`,
    itemCode: `IRM-${i}`,
    quantity: i + 1,
  });
  const holdings = (n: number) => Array.from({ length: n }, (_, i) => holding(i));

  const run = (over: Record<string, unknown> = {}) =>
    runCustomReport(STAFF, { reportKey: "engineer_stock", filters: {}, limit: 10, cursor: null, ...over });

  it("returns a page and offers the next one when more exist", async () => {
    repo.findEngineerHoldings.mockResolvedValue(holdings(25));
    const res = await run();
    expect(res.rows).toHaveLength(10);
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toBe("10");
  });

  it("continues from the cursor without overlapping or skipping a row", async () => {
    repo.findEngineerHoldings.mockResolvedValue(holdings(25));
    const first = await run();
    const second = await run({ cursor: first.nextCursor });
    const third = await run({ cursor: second.nextCursor });

    expect(second.rows[0]).toMatchObject({ itemCode: "IRM-10" });
    expect(third.rows).toHaveLength(5);
    expect(third.hasMore, "the last page must not offer another").toBe(false);
    expect(third.nextCursor).toBeNull();

    // Every row, exactly once — the property that makes paging trustworthy at all.
    const seen = [...first.rows, ...second.rows, ...third.rows].map((r) => r.itemCode);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it("reads the WHOLE candidate set, not a page, so the ordering is real", async () => {
    repo.findEngineerHoldings.mockResolvedValue(holdings(25));
    await run();
    // The repo is asked for the report cap. Taking a page-sized slice in the query and sorting it
    // afterwards returns an arbitrary N rows in Mongo's own order — "the first 10" of nothing.
    expect(repo.findEngineerHoldings).toHaveBeenCalledWith(expect.anything(), REPORT_MAX_ROWS);
  });

  it("does not offer a next page when everything fits", async () => {
    repo.findEngineerHoldings.mockResolvedValue(holdings(4));
    const res = await run();
    expect(res.rows).toHaveLength(4);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
  });

  // `capped` is judged on the whole set. A page of 10 could never reach a ceiling of 5,000, so
  // counting the page made the ceiling unreportable by construction.
  it("reports the hard ceiling even though a page is far smaller than it", async () => {
    repo.findEngineerHoldings.mockResolvedValue(holdings(REPORT_MAX_ROWS));
    const res = await run();
    expect(res.rows).toHaveLength(10);
    expect(res.capped, "the set hit the cap, so some holdings are not reachable at all").toBe(true);
  });

  it("is not capped when the set merely spans several pages", async () => {
    repo.findEngineerHoldings.mockResolvedValue(holdings(25));
    expect((await run()).capped).toBe(false);
  });

  // A cursor is user input. Garbage restarts the report rather than 500ing on it.
  it("treats an unparseable cursor as the start", async () => {
    repo.findEngineerHoldings.mockResolvedValue(holdings(25));
    for (const bad of ["abc", "", "-5"]) {
      const res = await run({ cursor: bad });
      expect(res.rows[0], `cursor "${bad}"`).toMatchObject({ itemCode: "IRM-0" });
    }
  });

  it("returns an empty last page rather than failing on a cursor past the end", async () => {
    repo.findEngineerHoldings.mockResolvedValue(holdings(5));
    const res = await run({ cursor: "999" });
    expect(res.rows).toEqual([]);
    expect(res.hasMore).toBe(false);
  });
});

// ── project_activity must report the CAP, not the survivor count ──────────────────────────────
//
// This report DROPS movements whose job does not resolve, and drops more again under a project
// filter, so `rows` is always shorter than what was fetched. Counting those survivors against the
// ceiling meant a run that hit the cap reported `capped: false`: the export set no X-Export-Capped
// header and handed over a short file that looked complete.
describe("project_activity cap reporting", () => {
  const movementsAt = (n: number) =>
    Array.from({ length: n }, (_, i) => movement({ id: `inventory:tx${i}`, sourceId: `jm${i}` }));

  it("reports capped when the SOURCE page came back full, even though rows were filtered away", async () => {
    mv.listMovements.mockResolvedValue({ movements: movementsAt(REPORT_MAX_ROWS), nextCursor: null, hasMore: false });
    // Only ONE movement resolves to a job — the other 4,999 are dropped.
    repo.findMovementJobProjects.mockResolvedValue(
      new Map([["jm0", { projectId: "p1", projectName: "Alpha", jobNumber: "JOB-1" }]]),
    );

    const res = await runCustomReport(STAFF, { reportKey: "project_activity", filters: {}, limit: REPORT_MAX_ROWS });

    expect(res.rows).toHaveLength(1);
    expect(res.capped, "the ceiling was reached; one surviving row does not mean it was not").toBe(true);
  });

  it("is not capped when the source page came back short", async () => {
    mv.listMovements.mockResolvedValue({ movements: movementsAt(10), nextCursor: null, hasMore: false });
    repo.findMovementJobProjects.mockResolvedValue(
      new Map([["jm0", { projectId: "p1", projectName: "Alpha", jobNumber: "JOB-1" }]]),
    );
    const res = await runCustomReport(STAFF, { reportKey: "project_activity", filters: {}, limit: REPORT_MAX_ROWS });
    expect(res.rows).toHaveLength(1);
    expect(res.capped).toBe(false);
  });

  // A project filter drops even more rows; the cap is still about what was FETCHED.
  it("still reports the cap when a project filter removes almost everything", async () => {
    mv.listMovements.mockResolvedValue({ movements: movementsAt(REPORT_MAX_ROWS), nextCursor: null, hasMore: false });
    repo.findMovementJobProjects.mockResolvedValue(
      new Map(movementsAt(REPORT_MAX_ROWS).map((_, i) => [`jm${i}`, { projectId: "other", projectName: "Other", jobNumber: `J${i}` }])),
    );
    const res = await runCustomReport(STAFF, { reportKey: "project_activity", filters: { projectId: "p1" }, limit: REPORT_MAX_ROWS });
    expect(res.rows).toHaveLength(0);
    expect(res.capped).toBe(true);
  });
});
