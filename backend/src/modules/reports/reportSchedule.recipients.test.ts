import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { roleFindMany, userFindMany } = vi.hoisted(() => ({ roleFindMany: vi.fn(), userFindMany: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  prisma: { role: { findMany: roleFindMany }, user: { findMany: userFindMany } },
}));

import { findEligibleRecipients, findRecipientProfiles } from "./reportSchedule.repository.js";

// ── Who may be sent a scheduled report ─────────────────────────────────────────────────────────
//
// A scheduled report IS the report. Emailing it to somebody who could not open it on screen would be
// an authorization bypass wearing a delivery mechanism, so eligibility is derived from the same
// permission that opens the report — never from a typed address.

const user = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  firstName: "Fin",
  lastName: "Director",
  email: "fd@x.co",
  ...over,
});

beforeEach(() => {
  roleFindMany.mockReset().mockResolvedValue([{ id: "r1" }, { id: "r2" }]);
  userFindMany.mockReset().mockResolvedValue([user()]);
});

describe("role selection", () => {
  // EVERY permission, not any of them. A recipient must hold the report's view right AND the export
  // right — `hasSome` would have qualified somebody on either one alone, which is how a user denied
  // `reports.export` was still being emailed the workbook every month.
  it("requires a role to grant ALL the permissions, or the wildcard that grants everything", async () => {
    await findEligibleRecipients(["reports.finance.view", "reports.export"]);
    expect(roleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { permissions: { hasEvery: ["reports.finance.view", "reports.export"] } },
            { permissions: { has: "*" } },
          ],
        },
      }),
    );
  });

  // `"*"` is its own branch rather than a member of the list: a super-admin role holds the wildcard
  // INSTEAD of the individual keys, so `hasEvery` alone would reject the one role allowed everything.
  it("keeps the wildcard as an alternative, not as one of the required keys", async () => {
    await findEligibleRecipients(["reports.view", "reports.export"]);
    const where = roleFindMany.mock.calls[0]![0].where as { OR: Record<string, unknown>[] };
    expect(where.OR[0]).toEqual({ permissions: { hasEvery: ["reports.view", "reports.export"] } });
    expect(where.OR[1]).toEqual({ permissions: { has: "*" } });
  });

  it("asks for users only from those roles", async () => {
    await findEligibleRecipients(["reports.view"]);
    expect(userFindMany.mock.calls[0]![0].where.roleId).toEqual({ in: ["r1", "r2"] });
  });

  // Not a mapped-to-empty query: `roleId: { in: [] }` would match nothing anyway, but skipping the
  // second round trip is the honest reading of "nobody holds this permission".
  it("returns nobody, without a second query, when no role grants the permission", async () => {
    roleFindMany.mockResolvedValue([]);
    expect(await findEligibleRecipients(["reports.finance.view"])).toEqual([]);
    expect(userFindMany).not.toHaveBeenCalled();
  });
});

describe("user eligibility", () => {
  it("asks only for ACTIVE users", async () => {
    await findEligibleRecipients(["reports.view"]);
    // Suspended and inactive are people who should stop receiving company reports.
    expect(userFindMany.mock.calls[0]![0].where.status).toBe("active");
  });

  it("excludes soft-deleted users, including rows predating the column", async () => {
    await findEligibleRecipients(["reports.view"]);
    // `{ deletedAt: null }` alone misses a document that has no such field at all on Mongo.
    expect(userFindMany.mock.calls[0]![0].where.OR).toEqual([{ deletedAt: null }, { deletedAt: { isSet: false } }]);
  });

  it("drops a user with no usable address rather than scheduling a send that cannot land", async () => {
    userFindMany.mockResolvedValue([
      user(),
      user({ id: "u2", email: "" }),
      user({ id: "u3", email: null }),
      user({ id: "u4", email: "not-an-address" }),
    ]);
    expect((await findEligibleRecipients(["reports.view"])).map((r) => r.id)).toEqual(["u1"]);
  });

  it("returns a name for the picker to show beside the address", async () => {
    userFindMany.mockResolvedValue([user({ firstName: "Ops", lastName: "Lead", email: "ops@x.co" })]);
    expect(await findEligibleRecipients(["reports.view"])).toEqual([{ id: "u1", name: "Ops Lead", email: "ops@x.co" }]);
  });

  // The picker is a list a human reads; unordered would make a long directory unusable.
  it("orders by name", async () => {
    await findEligibleRecipients(["reports.view"]);
    expect(userFindMany.mock.calls[0]![0].orderBy).toEqual([{ firstName: "asc" }, { lastName: "asc" }]);
  });

  // Nothing here selects a password hash, a token or an address history — the picker needs three
  // fields, so it is given three.
  it("selects only what the picker needs", async () => {
    await findEligibleRecipients(["reports.view"]);
    expect(Object.keys(userFindMany.mock.calls[0]![0].select).sort()).toEqual([
      "email",
      "firstName",
      "id",
      "lastName",
    ]);
  });
});

describe("resolving stored recipients for DISPLAY", () => {
  it("looks ids and legacy emails up in one query", async () => {
    userFindMany.mockResolvedValue([user()]);
    await findRecipientProfiles(["507f1f77bcf86cd799439011", "ops@x.co"]);
    expect(userFindMany).toHaveBeenCalledTimes(1);
    expect(userFindMany.mock.calls[0]![0].where.OR).toEqual([
      { id: { in: ["507f1f77bcf86cd799439011"] } },
      { email: { in: ["ops@x.co"] } },
    ]);
  });

  // Prisma throws "Malformed ObjectID" on a non-hex id, and a legacy email row is exactly that.
  it("never puts a non-ObjectId string into an id filter", async () => {
    await findRecipientProfiles(["ops@x.co"]);
    expect(userFindMany.mock.calls[0]![0].where.OR).toEqual([{ email: { in: ["ops@x.co"] } }]);
  });

  it("does not query when there is nothing resolvable", async () => {
    expect(await findRecipientProfiles([])).toEqual([]);
    expect(await findRecipientProfiles(["not-an-id-or-email"])).toEqual([]);
    expect(userFindMany).not.toHaveBeenCalled();
  });

  // Deliberately UNFILTERED, unlike findEligibleRecipients: the list should still name somebody who
  // has since been deactivated, because that is who was selected and the operator needs to recognise
  // the row. Whether they are actually SENT to is answered elsewhere, at send time.
  it("does not filter by status or soft-delete — it answers who, not whether", async () => {
    await findRecipientProfiles(["507f1f77bcf86cd799439011"]);
    const where = userFindMany.mock.calls[0]![0].where;
    expect(where.status).toBeUndefined();
    expect(where.deletedAt).toBeUndefined();
  });

  it("de-duplicates the keys it was handed", async () => {
    await findRecipientProfiles(["ops@x.co", "ops@x.co"]);
    expect(userFindMany.mock.calls[0]![0].where.OR).toEqual([{ email: { in: ["ops@x.co"] } }]);
  });
});

// ── The RBAC data behind the picker ───────────────────────────────────────────────────────────
//
// The bug that prompted this: the Finance Summary recipient list showed ONLY the Super Admin. The
// query was right; the DATA was not. `reports.finance.view` and `reports.export` were defined in the
// permission catalogue but granted to NO role, so the only principal holding them was a Super Admin
// via "*" — and the Finance Director could not open the Finance page either.
//
// Asserted on the seed's own role table rather than on a live database, because that table IS the
// grant: it seeds a fresh DB and feeds the idempotent backfill for an existing one.
describe("seeded roles hold the permissions the Reports module needs", () => {
  // A source scan, not an import: seed.ts pulls in Prisma at module load, and the role table IS the
  // grant — it seeds a fresh database and feeds the idempotent backfill for an existing one. Same
  // build-time approach reports.security.test.ts uses for the route guards.
  const seed = readFileSync(join(process.cwd(), "src", "db", "seed.ts"), "utf8");
  /** The single source line a role (or a grant) is declared on. */
  const lineFrom = (needle: string) => seed.slice(seed.indexOf(needle)).split("\n")[0];
  const roleRow = (key: string) => lineFrom(`key: "${key}"`);

  it("defines the Finance reporting grant as one named set", () => {
    expect(seed).toMatch(/const FINANCE_REPORTING_PERMISSIONS = \[[^\]]*"reports\.finance\.view"/);
    expect(seed).toMatch(/const FINANCE_REPORTING_PERMISSIONS = \[[^\]]*"reports\.export"/);
  });

  it("gives it to the Finance Director on a fresh database", () => {
    expect(roleRow("finance_director")).toContain("FINANCE_REPORTING_PERMISSIONS");
  });

  // Without this an EXISTING database keeps a Finance Director who cannot open the Finance page —
  // which is exactly how the recipient list came to show only the Super Admin.
  it("backfills it onto a database that already exists", () => {
    expect(lineFrom("finance_director: [")).toContain("FINANCE_REPORTING_PERMISSIONS");
  });

  it("keeps the Super Admin eligible through the wildcard rather than an explicit grant", () => {
    expect(roleRow("super_admin")).toContain('permissions: ["*"]');
  });

  // Permission-based, never role-name-based: these roles are absent from the Finance picker only
  // because they do not hold the key, which an administrator can change without a code change.
  it("does not grant Finance reporting to the operational roles", () => {
    for (const key of ["warehouse_manager", "project_manager", "field_engineer", "system_admin"]) {
      expect(roleRow(key), `${key} must not hold reports.finance.view`).not.toContain("reports.finance.view");
      expect(roleRow(key)).not.toContain("FINANCE_REPORTING_PERMISSIONS");
    }
  });

  // Deliberately ungranted: who may run stock/project/engineer reports is a business decision nobody
  // has made, and inventing it in a seed would be inventing an access grant.
  it("grants the general reports.view to nobody, pending a business decision", () => {
    expect(seed).not.toContain('"reports.view"');
  });
});
