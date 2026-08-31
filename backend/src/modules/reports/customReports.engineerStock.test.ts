import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Engineer Stock is not offered to a warehouse-scoped actor ──────────────────────────────────
//
// WHY, in one line: `EngineerStockBalance` is keyed `@@unique([irmItemId, engineerId])` and carries
// no `warehouseId`. Neither does `EngineerStockTransaction`. Stock on a van is held by a PERSON.
//
// So the question "which engineer holdings belong to Warehouse X?" has no authoritative answer in
// this data model, and the two ways to serve the report anyway are both wrong:
//
//   • unscoped — hands a warehouse-restricted user the company-wide field position, a WIDER
//     disclosure than the scope exists to prevent (and exactly what `movement.service.selectLedgers`
//     already refuses to do with the engineer ledgers, for this same reason);
//   • scoped by a guessed mapping — assigned warehouse, last known site, issuing warehouse — which
//     invents an accounting rule inside a report. `UserWarehouseAssignment` answers "which warehouses
//     may this user ACCESS", a different question that must not be borrowed for this one.
//
// No client requirement asks for scoped engineer visibility: FLOW 10B names exactly one report type
// ("Stock Movement") and says nothing about warehouse-scoped users. Absent a requirement and absent a
// relationship, the report is withheld rather than approximated.
//
// No new permission is introduced. The rule reads the actor's existing warehouse scope through
// `isWarehouseScopedUser`, the helper that already owns that question.

const mv = vi.hoisted(() => ({ listMovements: vi.fn() }));
const repo = vi.hoisted(() => ({ findMovementJobProjects: vi.fn(), findEngineerHoldings: vi.fn() }));
vi.mock("#modules/inventory/movement.service.js", () => mv);
vi.mock("#modules/inventory/movement.js", () => ({ decodeCursor: () => null }));
vi.mock("./customReports.repository.js", () => repo);

import { listAvailableReports, runCustomReport } from "./customReports.service.js";
import { schedulableReports } from "./reportSchedule.service.js";

/** The seeded `warehouse_manager` shape, plus the reporting right an admin could grant it. */
const SCOPED = {
  id: "u1",
  type: "user" as const,
  email: "wm@x.co",
  permissions: ["reports.view", "reports.export"],
  assignedWarehouseIds: ["wh-leeds"],
};
/** Not warehouse-scoped: `assignedWarehouseIds: null` is what unrestricted means. */
const UNRESTRICTED = {
  id: "u2",
  type: "user" as const,
  email: "pm@x.co",
  permissions: ["reports.view", "reports.export"],
  assignedWarehouseIds: null,
};
const SUPER_ADMIN = { id: "u3", type: "user" as const, email: "root@x.co", permissions: ["*"], assignedWarehouseIds: null };
const NO_RIGHTS = { id: "u4", type: "user" as const, email: "hr@x.co", permissions: [], assignedWarehouseIds: null };
const CUSTOMER = { id: "c1", type: "customer" as const, email: "bt@x.co", permissions: [], assignedWarehouseIds: null };

const keys = (actor: Parameters<typeof listAvailableReports>[0]) => listAvailableReports(actor, false).map((r) => r.key);

beforeEach(() => {
  vi.clearAllMocks();
  mv.listMovements.mockResolvedValue({ movements: [], nextCursor: null, hasMore: false });
  repo.findMovementJobProjects.mockResolvedValue(new Map());
  repo.findEngineerHoldings.mockResolvedValue([{ engineerName: "Karthik", itemName: "SFP-LX", itemCode: "IRM-0010", quantity: 3 }]);
});

describe("a warehouse-scoped actor is not offered Engineer Stock", () => {
  it("leaves it out of the catalogue the report picker is built from", () => {
    expect(keys(SCOPED)).not.toContain("engineer_stock");
  });

  it("refuses a DIRECT request for it — the picker is a convenience, not the gate", async () => {
    // The frontend is never the boundary. A crafted `?report=engineer_stock` must be refused here.
    await expect(runCustomReport(SCOPED, { reportKey: "engineer_stock", filters: {} })).rejects.toThrow(
      /don't have access to that report/i,
    );
  });

  it("does not reach the holdings read at all when it refuses", async () => {
    await expect(runCustomReport(SCOPED, { reportKey: "engineer_stock", filters: {} })).rejects.toThrow();
    expect(repo.findEngineerHoldings).not.toHaveBeenCalled();
  });

  it("refuses it however the filters are dressed up", async () => {
    // There is no filter combination that makes the report scopable — the column does not exist.
    await expect(
      runCustomReport(SCOPED, { reportKey: "engineer_stock", filters: { engineerId: "eng1", irmItemId: "i1" } }),
    ).rejects.toThrow(/don't have access to that report/i);
  });

  it("says nothing about WHY, so the refusal does not describe the catalogue", async () => {
    // Same message a missing permission gets. "That exists but is not scopable for you" would tell an
    // unauthorised user what reports exist.
    await expect(runCustomReport(SCOPED, { reportKey: "engineer_stock", filters: {} })).rejects.toThrow(
      /don't have access to that report/i,
    );
  });

  it("cannot reach it by the slower route either — scheduling is running plus emailing", () => {
    // A scheduled report IS the report. Refused on screen and delivered by email every week would be
    // an authorization bypass wearing a delivery mechanism.
    expect(schedulableReports(SCOPED).map((r) => r.key)).not.toContain("engineer_stock");
  });
});

describe("the scoped actor keeps every report that CAN be scoped", () => {
  it("is still offered Stock Movement and Project Activity", () => {
    expect(keys(SCOPED)).toEqual(["stock_movement", "project_activity"]);
  });

  it("can actually run them", async () => {
    await expect(runCustomReport(SCOPED, { reportKey: "stock_movement", filters: {} })).resolves.toBeDefined();
    await expect(runCustomReport(SCOPED, { reportKey: "project_activity", filters: {} })).resolves.toBeDefined();
  });

  it("can still schedule them", () => {
    expect(schedulableReports(SCOPED).map((r) => r.key)).toEqual(["stock_movement", "project_activity"]);
  });
});

describe("unrestricted behaviour is unchanged", () => {
  it("an unrestricted holder of reports.view is still offered all three", () => {
    expect(keys(UNRESTRICTED)).toEqual(["stock_movement", "project_activity", "engineer_stock"]);
  });

  it("an unrestricted holder can still RUN Engineer Stock", async () => {
    const res = await runCustomReport(UNRESTRICTED, { reportKey: "engineer_stock", filters: {} });
    expect(res.report.key).toBe("engineer_stock");
    expect(res.rows).toHaveLength(1);
    expect(repo.findEngineerHoldings).toHaveBeenCalled();
  });

  it("a Super Admin wildcard is unaffected", async () => {
    expect(keys(SUPER_ADMIN)).toContain("engineer_stock");
    await expect(runCustomReport(SUPER_ADMIN, { reportKey: "engineer_stock", filters: {} })).resolves.toBeDefined();
  });

  it("an unrestricted holder can still schedule it", () => {
    expect(schedulableReports(UNRESTRICTED).map((r) => r.key)).toContain("engineer_stock");
  });

  it("an actor with an EMPTY warehouse set is still scoped, not unrestricted", () => {
    // `[]` means "restricted to no warehouses" and must not read as `null`.
    expect(keys({ ...SCOPED, assignedWarehouseIds: [] })).not.toContain("engineer_stock");
  });
});

describe("the other principals are unchanged", () => {
  it("a customer is offered only the customer-safe report, as before", () => {
    expect(listAvailableReports(CUSTOMER, true).map((r) => r.key)).toEqual(["stock_movement"]);
  });

  it("a customer is never treated as warehouse-scoped", async () => {
    // `actorFrom` gives every non-"user" principal a null warehouse set, so nothing here narrows for
    // them — their isolation is `customerId` and stays that way.
    await expect(
      runCustomReport(CUSTOMER, { reportKey: "stock_movement", filters: {} }, { isCustomer: true, customerId: "c1" }),
    ).resolves.toBeDefined();
  });

  it("a customer still cannot reach Engineer Stock by direct key", async () => {
    await expect(
      runCustomReport(CUSTOMER, { reportKey: "engineer_stock", filters: {} }, { isCustomer: true, customerId: "c1" }),
    ).rejects.toThrow(/don't have access to that report/i);
  });

  it("holding no reporting right opens nothing — the route gate is separate and still applies", () => {
    // `reports.view` is enforced at the route; this asserts the catalogue itself grants nothing extra.
    expect(schedulableReports(NO_RIGHTS)).toEqual([]);
  });
});

describe("the registry states scopability as a fact about each report's source", () => {
  it("marks only the reports whose source carries a warehouseId as scopable", async () => {
    const { CUSTOM_REPORTS } = await import("./customReports.registry.js");
    const byKey = Object.fromEntries(CUSTOM_REPORTS.map((r) => [r.key, r.warehouseScopable]));
    // Stock Movement and Project Activity both come from the unified movement feed, which narrows the
    // warehouse ledgers by `scopeWarehouseIds` and drops the van ledgers for a scoped caller.
    expect(byKey).toEqual({ stock_movement: true, project_activity: true, engineer_stock: false });
  });

  it("every report declares it, so a new one cannot be added without answering the question", async () => {
    const { CUSTOM_REPORTS } = await import("./customReports.registry.js");
    for (const r of CUSTOM_REPORTS) {
      expect(typeof r.warehouseScopable, `${r.key} does not declare warehouseScopable`).toBe("boolean");
    }
  });
});
