import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the service: mock data-access + audit, so these are pure unit tests of the role-write
// rules (capability authorisation + capability-gated permission stripping) with no DB.
vi.mock("./role.repository.js", () => ({
  findById: vi.fn(),
  findByKey: vi.fn(),
  findByName: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock("#modules/user/user.repository.js", () => ({
  countByRole: vi.fn().mockResolvedValue(0),
  countByRoleMap: vi.fn().mockResolvedValue({}),
  findIdsByRole: vi.fn().mockResolvedValue([]),
}));
vi.mock("#modules/engineer-rental/engineer-rental.repository.js", () => ({ countHeldRentalsForEngineers: vi.fn(async () => 0) }));
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({
  countHeldStockForEngineers: vi.fn().mockResolvedValue(0),
}));
vi.mock("#modules/van-stock-request/van-stock-request.repository.js", () => ({
  countOpenForEngineers: vi.fn().mockResolvedValue(0),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as roleRepo from "./role.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as vanStockRequestRepo from "#modules/van-stock-request/van-stock-request.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import { createRole, updateRole } from "./role.service.js";

const ROLE_ID = "r".repeat(24);
const SUPER_ADMIN = { permissions: ["*"] } as never;

function roleRow(over: Record<string, unknown> = {}) {
  return {
    id: ROLE_ID,
    key: "helpdesk",
    name: "Helpdesk",
    description: null,
    isSystem: false,
    permissions: [] as string[],
    canHoldStock: false,
    isWarehouseScoped: false,
    sortOrder: 9,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

// The permissions the repository was asked to write on the last update() call.
function writtenPermissions(): string[] | undefined {
  const call = vi.mocked(roleRepo.update).mock.calls.at(-1);
  const data = call?.[1] as { permissions?: { set: string[] } } | undefined;
  return data?.permissions?.set;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(userRepo.findIdsByRole).mockResolvedValue([]);
  vi.mocked(engineerStockRepo.countHeldStockForEngineers).mockResolvedValue(0);
  vi.mocked(vanStockRequestRepo.countOpenForEngineers).mockResolvedValue(0);
  vi.mocked(roleRepo.findByName).mockResolvedValue(null);
  vi.mocked(roleRepo.findByKey).mockResolvedValue(null);
  vi.mocked(roleRepo.create).mockImplementation(
    async (data) => roleRow(data as Record<string, unknown>) as never,
  );
  vi.mocked(roleRepo.update).mockImplementation(async (_id, data) => {
    const d = data as { permissions?: { set: string[] }; canHoldStock?: boolean };
    return roleRow({
      permissions: d.permissions?.set ?? [],
      canHoldStock: d.canHoldStock ?? false,
    }) as never;
  });
});

describe("role capabilities — only the super-admin may change canHoldStock", () => {
  it("refuses a delegate turning a role into a field role", async () => {
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow() as never);
    await expect(
      updateRole(ROLE_ID, { canHoldStock: true }, { permissions: ["roles.edit"] } as never),
    ).rejects.toThrow(/super-admin/i);
  });

  it("allows the super-admin to turn a role into a field role", async () => {
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow() as never);
    await updateRole(ROLE_ID, { canHoldStock: true }, SUPER_ADMIN);
    expect(vi.mocked(roleRepo.update).mock.calls.at(-1)?.[1]).toMatchObject({
      canHoldStock: true,
    });
  });

  it("does NOT refuse a delegate re-sending the SAME value (a no-op isn't a change)", async () => {
    // The editor shows the toggle read-only to a delegate; a save that carries the unchanged value
    // must not be rejected, or a delegate could never edit a field role's description.
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow({ canHoldStock: true }) as never);
    await expect(
      updateRole(
        ROLE_ID,
        { canHoldStock: true, description: "x" },
        { permissions: ["roles.edit"] } as never,
      ),
    ).resolves.toBeTruthy();
  });

  it("refuses a delegate creating a field role", async () => {
    await expect(
      createRole(
        { name: "Site Engineer", canHoldStock: true },
        { permissions: ["roles.create"] } as never,
      ),
    ).rejects.toThrow(/super-admin/i);
  });
});

describe("role capabilities — Engineer Portal keys are stripped from non-field roles", () => {
  it("strips engineer.* when saving a non-field role", async () => {
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow() as never);
    await updateRole(
      ROLE_ID,
      { permissions: ["users.view", "engineer.dashboard.view", "engineer.jobs.accept"] },
      SUPER_ADMIN,
    );
    expect(writtenPermissions()).toEqual(["users.view"]);
  });

  it("keeps engineer.* when saving a field role", async () => {
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow({ canHoldStock: true }) as never);
    await updateRole(ROLE_ID, { permissions: ["engineer.dashboard.view"] }, SUPER_ADMIN);
    expect(writtenPermissions()).toContain("engineer.dashboard.view");
  });

  it("grants the capability and the portal in ONE save (uses the new flag, not the old)", async () => {
    // The order-of-operations trap: filtering against the role's CURRENT canHoldStock would strip
    // the very keys the same request is enabling.
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow() as never);
    await updateRole(
      ROLE_ID,
      { canHoldStock: true, permissions: ["engineer.dashboard.view"] },
      SUPER_ADMIN,
    );
    expect(writtenPermissions()).toContain("engineer.dashboard.view");
  });

  it("revoking the capability strips the portal keys even with no permissions payload", async () => {
    vi.mocked(roleRepo.findById).mockResolvedValue(
      roleRow({
        canHoldStock: true,
        permissions: ["users.view", "engineer.dashboard.view", "engineer.transfer"],
      }) as never,
    );
    await updateRole(ROLE_ID, { canHoldStock: false }, SUPER_ADMIN);
    expect(writtenPermissions()).toEqual(["users.view"]);
  });

  it("a plain description edit on a clean role doesn't rewrite permissions", async () => {
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow({ permissions: ["users.view"] }) as never);
    await updateRole(ROLE_ID, { description: "just a note" }, SUPER_ADMIN);
    expect(writtenPermissions()).toBeUndefined();
  });

  it("createRole strips engineer.* when the new role isn't a field role", async () => {
    await createRole(
      { name: "Helpdesk", permissions: ["users.view", "engineer.jobs.accept"] },
      SUPER_ADMIN,
    );
    const created = vi.mocked(roleRepo.create).mock.calls.at(-1)?.[0] as {
      permissions: string[];
      canHoldStock: boolean;
    };
    expect(created.permissions).toEqual(["users.view"]);
    expect(created.canHoldStock).toBe(false);
  });

  it("createRole keeps engineer.* for a field role created by the super-admin", async () => {
    await createRole(
      { name: "Site Engineer", canHoldStock: true, permissions: ["engineer.dashboard.view"] },
      SUPER_ADMIN,
    );
    const created = vi.mocked(roleRepo.create).mock.calls.at(-1)?.[0] as {
      permissions: string[];
      canHoldStock: boolean;
    };
    expect(created.permissions).toContain("engineer.dashboard.view");
    expect(created.canHoldStock).toBe(true);
  });

});

describe("revoking the field capability — stranded-stock guard", () => {
  // Mirrors the per-user deactivation guard: every route that could move van stock back refuses a
  // role that can't hold stock, so revoking while a holder still has stock would strand it.
  //
  // The guard now asks two independent questions (van stock, hired kit). Each test sets the one it is
  // about, so the other must start from a known clean answer — otherwise a value set by one case
  // leaks into the next and every later test fails on the wrong guard.
  beforeEach(() => {
    vi.mocked(engineerStockRepo.countHeldStockForEngineers).mockResolvedValue(0);
    vi.mocked(rentalCustodyRepo.countHeldRentalsForEngineers).mockResolvedValue(0);
  });

  it("blocks the revoke when a holder still has stock on the van", async () => {
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow({ canHoldStock: true }) as never);
    vi.mocked(userRepo.findIdsByRole).mockResolvedValue(["u1", "u2"]);
    vi.mocked(engineerStockRepo.countHeldStockForEngineers).mockResolvedValue(3);

    await expect(updateRole(ROLE_ID, { canHoldStock: false }, SUPER_ADMIN)).rejects.toThrow(
      /still hold field stock/i,
    );
    expect(roleRepo.update).not.toHaveBeenCalled();
  });

  // Hired equipment is a HARDER case than van stock, and it gets its own message. Revoking the
  // capability blocks the job return scan, which is the only way a hire can come back — unlike van
  // stock it cannot be transferred to a colleague to clear.
  it("blocks the revoke when a holder still has rental items", async () => {
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow({ canHoldStock: true }) as never);
    vi.mocked(userRepo.findIdsByRole).mockResolvedValue(["u1"]);
    vi.mocked(engineerStockRepo.countHeldStockForEngineers).mockResolvedValue(0);
    vi.mocked(rentalCustodyRepo.countHeldRentalsForEngineers).mockResolvedValue(1);

    await expect(updateRole(ROLE_ID, { canHoldStock: false }, SUPER_ADMIN)).rejects.toThrow(/still hold rental items/i);
  });

  it("allows the revoke once no holder has stock", async () => {
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow({ canHoldStock: true }) as never);
    vi.mocked(userRepo.findIdsByRole).mockResolvedValue(["u1"]);
    vi.mocked(engineerStockRepo.countHeldStockForEngineers).mockResolvedValue(0);

    await expect(updateRole(ROLE_ID, { canHoldStock: false }, SUPER_ADMIN)).resolves.toBeTruthy();
  });

  it("counts SOFT-DELETED holders too — a deleted engineer's stock is still on the books", async () => {
    // Otherwise the guard is trivially bypassable: delete the holder (which leaves the balance
    // behind), then revoke the capability and the guard reports safe while the stock is unreachable.
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow({ canHoldStock: true }) as never);
    vi.mocked(engineerStockRepo.countHeldStockForEngineers).mockResolvedValue(0);

    await updateRole(ROLE_ID, { canHoldStock: false }, SUPER_ADMIN);

    expect(userRepo.findIdsByRole).toHaveBeenCalledWith(ROLE_ID, { includeDeleted: true });
  });

  it("blocks the revoke when a holder has an OPEN field-stock request", async () => {
    // A zero balance isn't safe on its own: an approved-but-unscanned restock credits the van later,
    // and neither approve nor fulfil re-checks the role.
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow({ canHoldStock: true }) as never);
    vi.mocked(userRepo.findIdsByRole).mockResolvedValue(["u1"]);
    vi.mocked(engineerStockRepo.countHeldStockForEngineers).mockResolvedValue(0);
    vi.mocked(vanStockRequestRepo.countOpenForEngineers).mockResolvedValue(2);

    await expect(updateRole(ROLE_ID, { canHoldStock: false }, SUPER_ADMIN)).rejects.toThrow(
      /open field-stock request/i,
    );
    expect(roleRepo.update).not.toHaveBeenCalled();
  });

  it("persists a revoke on a LEGACY row whose canHoldStock is null", async () => {
    // `Boolean(null) === false` made `false` look like a no-op, so the revoke wrote nothing and the
    // portal keys survived while the admin saw the toggle go off.
    vi.mocked(roleRepo.findById).mockResolvedValue(
      roleRow({ canHoldStock: null, permissions: ["engineer.dashboard.view"] }) as never,
    );
    await updateRole(ROLE_ID, { canHoldStock: false }, SUPER_ADMIN);
    const data = vi.mocked(roleRepo.update).mock.calls.at(-1)?.[1] as {
      canHoldStock?: boolean;
      permissions?: { set: string[] };
    };
    expect(data.canHoldStock).toBe(false);
    expect(data.permissions?.set).toEqual([]);
  });

  it("does NOT run the guard when GRANTING the capability", async () => {
    // Only the destructive direction needs it — granting can't strand anything.
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow() as never);
    vi.mocked(engineerStockRepo.countHeldStockForEngineers).mockResolvedValue(99);

    await expect(updateRole(ROLE_ID, { canHoldStock: true }, SUPER_ADMIN)).resolves.toBeTruthy();
    expect(engineerStockRepo.countHeldStockForEngineers).not.toHaveBeenCalled();
  });
});

describe("audit trail records WHAT changed", () => {
  it("records the capability change", async () => {
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow() as never);
    await updateRole(ROLE_ID, { canHoldStock: true }, SUPER_ADMIN);
    expect(vi.mocked(audit.record).mock.calls.at(-1)?.[0]).toMatchObject({
      action: "role.updated",
      metadata: { canHoldStock: true },
    });
  });

  it("records permissions dropped by the capability filter, measured against STORED keys", async () => {
    // Measured against what the role HELD, not what the client sent — the editor pre-strips, so a
    // payload-based diff would report nothing on exactly the save that removes access.
    vi.mocked(roleRepo.findById).mockResolvedValue(
      roleRow({ permissions: ["users.view", "engineer.dashboard.view"] }) as never,
    );
    await updateRole(ROLE_ID, { permissions: ["users.view"] }, SUPER_ADMIN);
    expect(vi.mocked(audit.record).mock.calls.at(-1)?.[0]).toMatchObject({
      metadata: { permissionsRemovedByCapability: ["engineer.dashboard.view"] },
    });
  });

  it("leaves metadata off an ordinary edit (no noise in the audit log)", async () => {
    vi.mocked(roleRepo.findById).mockResolvedValue(roleRow({ permissions: ["users.view"] }) as never);
    await updateRole(ROLE_ID, { description: "just a note" }, SUPER_ADMIN);
    expect(vi.mocked(audit.record).mock.calls.at(-1)?.[0].metadata).toBeUndefined();
  });
});
