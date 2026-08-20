import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PERMISSION_KEYS, WAREHOUSE_MANAGER_PERMISSIONS } from "#modules/role/permissions.js";
import { UPLOAD_PURPOSES } from "#modules/upload/upload.catalog.js";

// The hire permission SPLIT, pinned where it is actually enforced.
//
// Two jobs sit behind these routes and they are done by different people in different buildings. The
// FLOOR books equipment in, hands it back and photographs what is broken — dozens of times a week,
// scanner in hand. The COMMERCIAL side extends a hire (which commits money) and reverses a record (which
// rewrites what already happened). A warehouse receiver needs the first and must not be handed the
// second just to do their job.
//
// Asserted against the route FILE rather than by booting Express: what matters is which guard sits on
// which path, and reading the source says exactly that without a server, a database or a session.
const routes = readFileSync(
  join(process.cwd(), "src", "modules", "rental-receipt", "rental-receipt.routes.ts"),
  "utf8",
);

/** The middleware chain declared for one path, up to the controller. */
function guardFor(method: string, path: string): string {
  const escaped = path.replace(/[/:]/g, (c) => `\\${c}`);
  const m = routes.match(new RegExp(`router\\.${method}\\(\\s*"${escaped}",([\\s\\S]*?)\\n\\);`, "m"));
  expect(m, `no ${method.toUpperCase()} ${path} route`).toBeTruthy();
  return m![1]!;
}

describe("both hire permissions exist in the catalog", () => {
  // A route guarded on a key the catalog never declares is a route nobody can be granted: the role
  // editor cannot tick a box that is not there, so only the super-admin would ever pass it.
  it("declares rentals.hire.receive and rentals.hire.manage", () => {
    expect(PERMISSION_KEYS).toContain("rentals.hire.receive");
    expect(PERMISSION_KEYS).toContain("rentals.hire.manage");
  });
});

describe("the warehouse floor's routes accept either key", () => {
  // `manage` is a SUPERSET, accepted everywhere `receive` is — which is what lets an existing role
  // that only ever held "Manage hires" keep working with no migration, and no warehouse that silently
  // stops being able to receive.
  it.each([
    ["post", "/"],
    ["post", "/returns"],
    ["post", "/damage"],
    ["delete", "/:id/photos/:attachmentId"],
  ])("%s %s", (method, path) => {
    const guard = guardFor(method, path);
    expect(guard).toContain("requireAnyPermission(...HIRE_FLOOR)");
    expect(guard).not.toContain('requirePermission("rentals.hire.manage")');
  });

  it("HIRE_FLOOR is exactly the two hire keys", () => {
    expect(routes).toContain('const HIRE_FLOOR = ["rentals.hire.receive", "rentals.hire.manage"] as const;');
  });
});

describe("reversing stays commercial", () => {
  // Reversing rewrites how much of a hire moved, after the fact. That is a correction to a committed
  // record, not a floor operation, and it is the one write here the receiver does not get.
  it("requires rentals.hire.manage alone", () => {
    const guard = guardFor("patch", "/:id/reverse");
    expect(guard).toContain('requirePermission("rentals.hire.manage")');
    expect(guard).not.toContain("HIRE_FLOOR");
  });
});

describe("reading is gated on the catalogue's own view key", () => {
  it("both reads take rentals.view", () => {
    expect(guardFor("get", "/purchase-order/:id")).toContain('requirePermission("rentals.view")');
    expect(routes).toContain('router.get("/:id", requirePermission("rentals.view")');
  });
});

// The role the split was drawn for. Without these two keys the warehouse page's hire-receiving queue,
// its attention badge and the Rental (hired in) pool all 403 or render with no actions — for the role
// whose whole job is the equipment standing in the yard.
describe("the seeded warehouse manager can work its own hires", () => {
  it("holds rentals.view and the floor key", () => {
    expect(WAREHOUSE_MANAGER_PERMISSIONS).toContain("rentals.view");
    expect(WAREHOUSE_MANAGER_PERMISSIONS).toContain("rentals.hire.receive");
  });

  // Granting the commercial key here would collapse the split on the very role it exists for.
  it("does NOT hold the commercial key", () => {
    expect(WAREHOUSE_MANAGER_PERMISSIONS).not.toContain("rentals.hire.manage");
  });
});

// The three seeded roles a hire actually passes through, pinned against the source of the seed.
//
// Read from the file rather than imported: the bundles live in db/seed.ts, which connects to Mongo on
// import. What is being asserted is which keys the array names, and reading it says that without a
// database — the same trade the route assertions above make.
const seed = readFileSync(join(process.cwd(), "src", "db", "seed.ts"), "utf8");

/** The literal array body of one bundle. */
function bundle(name: string): string {
  const m = seed.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`, "m"));
  expect(m, `no ${name}`).toBeTruthy();
  return m![1]!;
}

describe("a hire's three roles can each do their own part", () => {
  // Finance raises the request. A purchase request can carry HIRE lines, and its item picker reads
  // /rental-items — which gates on rentals.view. Every picker in these forms swallows its rejection,
  // so a missing read shows up as a silently EMPTY dropdown rather than an error. That is exactly why
  // `irm.view` is pinned in the same array's comments, and why this one is pinned here.
  it("finance can see the rental catalogue it raises requests from", () => {
    expect(bundle("FINANCE_PROCUREMENT_PERMISSIONS")).toContain('"rentals.view"');
  });

  // The PM routes and sends the order, then owns the live hire on it: the PO detail's Hire movements
  // panel reads /rental-receipts (rentals.view), and extending or reversing is the commercial half of
  // the split.
  it("the PM holds the commercial half of the hire split", () => {
    const pm = bundle("PM_PROCUREMENT_PERMISSIONS");
    expect(pm).toContain('"rentals.view"');
    expect(pm).toContain('"rentals.hire.manage"');
  });

  // And the floor half stays where the equipment is. Asserted from the catalog array rather than the
  // seed file because that is where the warehouse manager's bundle lives.
  it("the warehouse manager holds the floor half and not the commercial one", () => {
    expect(WAREHOUSE_MANAGER_PERMISSIONS).toContain("rentals.hire.receive");
    expect(WAREHOUSE_MANAGER_PERMISSIONS).not.toContain("rentals.hire.manage");
  });
});

// The photographs are the stated reason the record exists in this form, and they go through the shared
// direct-upload path rather than these routes — so the catalog has to agree with them.
describe("condition photos accept the same keys the routes do", () => {
  const spec = UPLOAD_PURPOSES.hire_delivery_photo;

  // `assertPermitted` reads `anyPermission: false` as `.every()`. The two hire keys are deliberately
  // never held together (warehouse manager gets `receive`, PM gets `manage`), so requiring both left
  // EVERY seeded role unable to attach a photo and only a `*` super-admin able to — which is what dev
  // testing runs as, so it looked fine.
  it("is any-of, not all-of", () => {
    expect(spec.permissions).toEqual(["rentals.hire.receive", "rentals.hire.manage"]);
    expect(spec.anyPermission).toBe(true);
  });

  // Pinned as a rule, not as one entry: a multi-key purpose that demands ALL of them is almost always
  // a slip, and this one shipped because the comment above it said the opposite of the code.
  it("no purpose in the catalog demands every one of several permissions", () => {
    const allOf = Object.entries(UPLOAD_PURPOSES)
      .filter(([, p]) => p.permissions.length > 1 && !p.anyPermission)
      .map(([k]) => k);
    expect(allOf).toEqual([]);
  });
});
