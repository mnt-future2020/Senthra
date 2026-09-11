import { describe, expect, it, vi } from "vitest";

// requireAuth's collaborators are irrelevant to the guard under test — stub them so importing the
// middleware module touches no repository and no database.
vi.mock("#modules/auth/admin.repository.js", () => ({}));
vi.mock("#modules/user/user.repository.js", () => ({}));
vi.mock("#modules/user/user-warehouse.repository.js", () => ({}));
vi.mock("#modules/customer/customer.repository.js", () => ({}));
vi.mock("#modules/auth/session.service.js", () => ({}));
vi.mock("../utils/jwt.js", () => ({ verifyAccessToken: vi.fn() }));

import { requireAnyPermissionUnlessScoped } from "./auth.middleware.js";

// requireAnyPermissionUnlessScoped: `anyOf` keys admit anyone who holds them; `unscopedOnly` keys admit
// only a principal whose data is NOT warehouse-scoped. It exists for the customer / project / site
// pickers a report permission opens — a warehouse-scoped user's reports are scoped to their own
// warehouses, so `reports.view` must not hand them the company's whole customer list.

function run(principal: unknown) {
  const guard = requireAnyPermissionUnlessScoped(["customers.view", "jobs.view"], ["reports.view"]);
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  guard({ principal } as never, res as never, next);
  return { status: res.status.mock.calls[0]?.[0] as number | undefined, next: next.mock.calls.length > 0 };
}

const user = (permissions: string[], assignedWarehouseIds: string[] | null = null) => ({
  type: "user",
  mustResetPassword: false,
  permissions,
  isWarehouseScoped: assignedWarehouseIds !== null,
  assignedWarehouseIds,
});

describe("requireAnyPermissionUnlessScoped", () => {
  it("401s without a principal", () => {
    expect(run(undefined)).toEqual({ status: 401, next: false });
  });

  it("always admits the super-admin", () => {
    expect(run({ type: "admin" })).toEqual({ status: undefined, next: true });
  });

  it("walls off a user who has not set their password yet", () => {
    expect(run({ ...user(["customers.view"]), mustResetPassword: true }).status).toBe(403);
  });

  it("admits an `anyOf` key whether or not the user is warehouse-scoped", () => {
    expect(run(user(["jobs.view"])).next).toBe(true);
    expect(run(user(["jobs.view"], ["w1"])).next).toBe(true);
  });

  it("admits an `unscopedOnly` key for an UNSCOPED user", () => {
    expect(run(user(["reports.view"])).next).toBe(true);
  });

  it("refuses the same key for a WAREHOUSE-SCOPED user — the data-scoping rule", () => {
    expect(run(user(["reports.view"], ["w1"]))).toEqual({ status: 403, next: false });
    // An empty assignment is still scoped (it matches nothing), never "unrestricted".
    expect(run(user(["reports.view"], []))).toEqual({ status: 403, next: false });
  });

  it("refuses a user holding neither list", () => {
    expect(run(user(["suppliers.view"])).status).toBe(403);
  });

  it("honours the '*' wildcard like every other guard", () => {
    expect(run(user(["*"], ["w1"])).next).toBe(true);
  });
});
