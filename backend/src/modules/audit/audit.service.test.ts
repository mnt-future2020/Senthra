import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./audit.repository.js", () => ({
  count: vi.fn(),
  findMany: vi.fn(),
  findForExport: vi.fn(),
  distinctActions: vi.fn(),
  distinctActorTypes: vi.fn(),
  distinctTargetTypes: vi.fn(),
}));

// The CSV export renders timestamps in the COMPANY timezone, so it reads Settings — which goes to
// Prisma. Stubbed here to keep this a unit test: without it the file silently needs a live MongoDB
// and passes only on a developer machine that happens to have one running.
vi.mock("#modules/settings/settings.service.js", () => ({
  getRegionalSettings: vi.fn(async () => ({ timezone: "Europe/London", dateFormat: "DD/MM/YYYY", timeFormat: "24h" })),
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

// The export used to emit raw UTC ISO under a hardcoded "When (UTC)" header while Settings offered a
// date format that reached only documents — so an admin who chose DD/MM/YYYY got something else, and
// during BST every timestamp read an hour out of step with the app that produced it.
describe("exportAuditCsv renders timestamps per the company's regional settings", () => {
  const row = {
    createdAt: new Date("2026-06-19T23:30:15Z"), // BST → 20 June, 00:30 London
    action: "user.updated",
    actorType: "user",
    actorEmail: "a@x.com",
    actorId: "u1",
    targetType: "user",
    targetId: "u2",
    targetLabel: "Bob",
    metadata: null,
  };

  it("names the configured zone in the header instead of claiming UTC", async () => {
    vi.mocked(repo.findForExport).mockResolvedValue([row] as never);
    const { csv } = await exportAuditCsv({}, unrestrictedAdmin);
    expect(csv.split("\r\n")[0]).toContain("When (Europe/London)");
    expect(csv).not.toContain("When (UTC)");
  });

  // The row is the load-bearing assertion: 23:30 UTC on the 19th is 00:30 on the 20th in London, so a
  // reviewer chasing "what happened on the 20th" would previously have missed this entry entirely.
  it("converts to the company timezone, keeping seconds for ordering", async () => {
    vi.mocked(repo.findForExport).mockResolvedValue([row] as never);
    const { csv } = await exportAuditCsv({}, unrestrictedAdmin);
    expect(csv.split("\r\n")[1]).toContain("20/06/2026 00:30:15");
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
