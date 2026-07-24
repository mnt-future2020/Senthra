import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./audit.repository.js", () => ({
  count: vi.fn(),
  findMany: vi.fn(),
  findForExport: vi.fn(),
  distinctActions: vi.fn(),
  distinctActorTypes: vi.fn(),
  distinctTargetTypes: vi.fn(),
}));

import * as repo from "./audit.repository.js";
import { exportAuditCsv, listAuditLogs, listFacets } from "./audit.service.js";
import type { AuditActor } from "./audit.service.js";

const scopedWm: AuditActor = { type: "user", assignedWarehouseIds: ["w1", "w2"] };
const unrestrictedAdmin: AuditActor = { type: "admin", assignedWarehouseIds: null };

beforeEach(() => {
  vi.clearAllMocks(); // reset call history so each test reads its OWN call at calls[0]
  vi.mocked(repo.count).mockResolvedValue(0);
  vi.mocked(repo.findMany).mockResolvedValue([]);
  vi.mocked(repo.findForExport).mockResolvedValue([]);
  vi.mocked(repo.distinctActions).mockResolvedValue([]);
  vi.mocked(repo.distinctActorTypes).mockResolvedValue([]);
  vi.mocked(repo.distinctTargetTypes).mockResolvedValue([]);
});

// The service is the ONLY place the actor's warehouse scope is turned into a repo filter, so it
// is where we prove that a warehouse-scoped actor never reaches the repository without the scope
// — on the list, the export, AND the facet queries (each is an independent leak surface).

describe("listAuditLogs applies the actor's warehouse scope", () => {
  it("threads the assigned warehouse ids into the repo query for a scoped actor", async () => {
    await listAuditLogs({}, scopedWm);
    expect(vi.mocked(repo.count).mock.calls[0]![0]).toMatchObject({ scopeWarehouseIds: ["w1", "w2"] });
    expect(vi.mocked(repo.findMany).mock.calls[0]![0]).toMatchObject({ scopeWarehouseIds: ["w1", "w2"] });
  });

  it("passes NO scope for an unrestricted actor (admin sees everything)", async () => {
    await listAuditLogs({}, unrestrictedAdmin);
    expect(vi.mocked(repo.count).mock.calls[0]![0]!.scopeWarehouseIds).toBeUndefined();
  });

  it("passes NO scope when there is no actor at all", async () => {
    await listAuditLogs({});
    expect(vi.mocked(repo.count).mock.calls[0]![0]!.scopeWarehouseIds).toBeUndefined();
  });

  it("scopes to an empty set for a warehouse user with zero assignments", async () => {
    await listAuditLogs({}, { type: "user", assignedWarehouseIds: [] });
    expect(vi.mocked(repo.count).mock.calls[0]![0]).toMatchObject({ scopeWarehouseIds: [] });
  });
});

describe("exportAuditCsv applies the actor's warehouse scope", () => {
  it("threads the scope into the export query", async () => {
    await exportAuditCsv({}, scopedWm);
    expect(vi.mocked(repo.findForExport).mock.calls[0]![0]).toMatchObject({ scopeWarehouseIds: ["w1", "w2"] });
  });

  it("passes NO scope for an unrestricted actor", async () => {
    await exportAuditCsv({}, unrestrictedAdmin);
    expect(vi.mocked(repo.findForExport).mock.calls[0]![0]!.scopeWarehouseIds).toBeUndefined();
  });
});

describe("listFacets applies the actor's warehouse scope", () => {
  it("scopes every facet query so the dropdowns never leak other warehouses' values", async () => {
    await listFacets(scopedWm);
    expect(vi.mocked(repo.distinctActions).mock.calls[0]![0]).toEqual(["w1", "w2"]);
    expect(vi.mocked(repo.distinctActorTypes).mock.calls[0]![0]).toEqual(["w1", "w2"]);
    expect(vi.mocked(repo.distinctTargetTypes).mock.calls[0]![0]).toEqual(["w1", "w2"]);
  });

  it("passes NO scope for an unrestricted actor", async () => {
    await listFacets(unrestrictedAdmin);
    expect(vi.mocked(repo.distinctActions).mock.calls[0]![0]).toBeUndefined();
  });
});
