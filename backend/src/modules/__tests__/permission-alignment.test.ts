import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CUSTOMER_OPTION_READERS,
  CUSTOMER_OPTION_UNSCOPED_READERS,
  CUSTOMER_SITE_OPTION_READERS,
  CUSTOMER_STOCK_OPTION_READERS,
  ENGINEER_OPTION_READERS,
  INVENTORY_ENGINEER_OPTION_READERS,
  JOB_OFFICE_PERMISSIONS,
  JOB_SITE_SEARCH_READERS,
  PERMISSION_KEYS,
  STOCK_CHECK_READERS,
  SUPPLIER_OPTION_READERS,
  SYSTEM_ADMIN_PERMISSIONS,
  WAREHOUSE_DELIVERY_OPTION_READERS,
  WAREHOUSE_MANAGER_PERMISSIONS,
  WAREHOUSE_OPTION_READERS,
  closePrerequisites,
  customerCompatAdditions,
  grantsAnyUnlessScoped,
  roleGrants,
} from "#modules/role/permissions.js";
import { CATEGORY_LIST_READERS } from "#modules/category/category.routes.js";
import { IRM_PICKER_PERMISSIONS } from "#modules/irm/irm.service.js";

// ── The permission-mismatch audit, pinned where it is enforced ────────────────────────────────
//
// The bug class: a screen is visible under one permission, and a read it makes on its own (a filter's
// options, a tab's rows) is gated on a DIFFERENT one the viewer may not hold. The result was either an
// alarm nobody could act on — the Finance Director's "Couldn't load customers" on the Jobs list — or an
// empty dropdown that read as "there is no data".
//
// Asserted against the SEEDED ROLES as they really are, not a hand-written guess of them: the bundles
// are read out of db/seed.ts (which connects to Mongo on import, so it is read as text — the same trade
// rental-receipt.routes.test makes) and widened by the startup customer-compat backfill every role gets.
// Each block names the audit item it pins, so a failure reads as the requirement it broke.

const SRC = join(process.cwd(), "src");
const seed = readFileSync(join(SRC, "db", "seed.ts"), "utf8");

const stripLineComments = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

/** A seed-local bundle's keys. Comments are stripped first: several quote a tab name in prose. */
function bundle(name: string): string[] {
  const m = seed.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`no ${name} in db/seed.ts`);
  return [...stripLineComments(m[1]!).matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

/** The literal SEED_ROLES row for a role key. */
function roleRow(key: string): string {
  const line = seed.split("\n").find((l) => l.includes(`key: "${key}"`) && l.includes("permissions:"));
  if (!line) throw new Error(`no SEED_ROLES row for ${key}`);
  return line;
}

// What a seeded role actually holds at runtime: its bundle plus the additive customer-compat backfill
// the seed applies to EVERY role on startup (seed.ts — customerCompatAdditions).
const effective = (keys: readonly string[]) => [...new Set([...keys, ...customerCompatAdditions([...keys])])];

type Role = { perms: string[]; scoped: boolean };
const ROLES: Record<string, Role> = {
  finance_director: {
    perms: effective([...bundle("FINANCE_PROCUREMENT_PERMISSIONS"), ...bundle("FINANCE_REPORTING_PERMISSIONS")]),
    scoped: false,
  },
  project_manager: { perms: effective([...JOB_OFFICE_PERMISSIONS, ...bundle("PM_PROCUREMENT_PERMISSIONS")]), scoped: false },
  warehouse_manager: {
    perms: effective([
      ...WAREHOUSE_MANAGER_PERMISSIONS,
      ...bundle("GOODS_MANAGEMENT_PERMISSIONS"),
      ...bundle("VAN_STOCK_REQUEST_PERMISSIONS"),
      ...bundle("ENGINEER_STOCK_ADMIN_PERMISSIONS"),
    ]),
    scoped: true,
  },
  system_admin: { perms: effective([...SYSTEM_ADMIN_PERMISSIONS, ...bundle("ENGINEER_STOCK_ADMIN_PERMISSIONS")]), scoped: false },
  field_engineer: { perms: effective(bundle("ENGINEER_PORTAL_PERMISSIONS")), scoped: false },
};
const FD = ROLES.finance_director!;
const PM = ROLES.project_manager!;
const WM = ROLES.warehouse_manager!;
const SA = ROLES.system_admin!;

/** Would this role pass a guard of `anyOf` (+ keys that only count when not warehouse-scoped)? */
const passes = (role: Role, anyOf: readonly string[], unscopedOnly: readonly string[] = []) =>
  grantsAnyUnlessScoped(role.perms, role.scoped, anyOf, unscopedOnly);
const holds = (role: Role, key: string) => roleGrants(role.perms, key);
/** A role assembled in Users & Roles. */
const custom = (perms: string[], scoped = false): Role => ({ perms, scoped });

/** A route file's source, comments stripped. */
const routes = (rel: string) => stripLineComments(readFileSync(join(SRC, "modules", rel), "utf8"));

/** The middleware chain one GET route declares, up to its handler. */
function getGuard(rel: string, router: string, path: string): string {
  const src = routes(rel);
  const esc = path.replace(/[/:.-]/g, (c) => `\\${c}`);
  const m = src.match(new RegExp(`${router}\\.get\\(\\s*"${esc}",([\\s\\S]*?)\\);`));
  if (!m) throw new Error(`no GET ${path} in ${rel}`);
  return m[1]!;
}
/** The quoted permission keys an inline guard names. */
const keysIn = (guard: string) => [...guard.matchAll(/"([a-z_]+\.[a-z_.]+)"/g)].map((x) => x[1]!);

describe("the seeded roles are read the way the seed composes them", () => {
  it.each([
    ["finance_director", ["FINANCE_PROCUREMENT_PERMISSIONS", "FINANCE_REPORTING_PERMISSIONS"]],
    ["project_manager", ["JOB_OFFICE_PERMISSIONS", "PM_PROCUREMENT_PERMISSIONS"]],
    ["warehouse_manager", ["WAREHOUSE_MANAGER_PERMISSIONS", "GOODS_MANAGEMENT_PERMISSIONS", "VAN_STOCK_REQUEST_PERMISSIONS", "ENGINEER_STOCK_ADMIN_PERMISSIONS"]],
    ["system_admin", ["SYSTEM_ADMIN_PERMISSIONS", "ENGINEER_STOCK_ADMIN_PERMISSIONS"]],
  ])("%s", (key, parts) => {
    for (const p of parts) expect(roleRow(key)).toContain(`...${p}`);
  });

  it("only the warehouse manager is warehouse-scoped", () => {
    expect(seed).toMatch(/const WAREHOUSE_SCOPED_ROLE_KEYS = \["warehouse_manager"\];/);
  });
});

describe("every new reader list names only real catalogue keys", () => {
  it.each([
    ["CUSTOMER_OPTION_READERS", CUSTOMER_OPTION_READERS],
    ["CUSTOMER_OPTION_UNSCOPED_READERS", CUSTOMER_OPTION_UNSCOPED_READERS],
    ["CUSTOMER_SITE_OPTION_READERS", CUSTOMER_SITE_OPTION_READERS],
    ["CUSTOMER_STOCK_OPTION_READERS", CUSTOMER_STOCK_OPTION_READERS],
    ["JOB_SITE_SEARCH_READERS", JOB_SITE_SEARCH_READERS],
    ["SUPPLIER_OPTION_READERS", SUPPLIER_OPTION_READERS],
    ["WAREHOUSE_OPTION_READERS", WAREHOUSE_OPTION_READERS],
    ["WAREHOUSE_DELIVERY_OPTION_READERS", WAREHOUSE_DELIVERY_OPTION_READERS],
    ["ENGINEER_OPTION_READERS", ENGINEER_OPTION_READERS],
    ["INVENTORY_ENGINEER_OPTION_READERS", INVENTORY_ENGINEER_OPTION_READERS],
    ["STOCK_CHECK_READERS", STOCK_CHECK_READERS],
    ["CATEGORY_LIST_READERS", CATEGORY_LIST_READERS],
    ["IRM_PICKER_PERMISSIONS", IRM_PICKER_PERMISSIONS],
  ])("%s", (_name, list) => {
    // A key the catalogue never declares can never be ticked in the role editor — a guard on it
    // admits nobody but the super-admin.
    expect(list.filter((k) => !PERMISSION_KEYS.includes(k))).toEqual([]);
  });
});

// ── P1: seeded roles that saw an error ──────────────────────────────────────────────────────────

describe("#1 Jobs list customer filter — Finance Director", () => {
  it("reads the lean customer options with jobs.view", () => {
    expect(passes(FD, CUSTOMER_OPTION_READERS, CUSTOMER_OPTION_UNSCOPED_READERS)).toBe(true);
  });
  it("is fixed WITHOUT handing the Finance Director the customer directory", () => {
    expect(holds(FD, "customers.view")).toBe(false);
  });
  it("the route enforces the shared list", () => {
    expect(getGuard("customer/customer.routes.ts", "adminRouter", "/options")).toContain(
      "requireAnyPermissionUnlessScoped(CUSTOMER_OPTION_READERS, CUSTOMER_OPTION_UNSCOPED_READERS)",
    );
  });
});

describe("#2 Purchase Orders list filters — Warehouse Manager", () => {
  it("reads supplier and warehouse options with purchase_orders.view", () => {
    expect(holds(WM, "suppliers.view")).toBe(false); // why the old full-list read refused them
    expect(passes(WM, SUPPLIER_OPTION_READERS)).toBe(true);
    expect(passes(WM, WAREHOUSE_OPTION_READERS)).toBe(true);
  });
  it("both routes enforce the shared lists", () => {
    expect(getGuard("supplier/supplier.routes.ts", "router", "/options")).toContain("requireAnyPermission(...SUPPLIER_OPTION_READERS)");
    expect(getGuard("warehouse/warehouse.routes.ts", "router", "/options")).toContain("requireAnyPermission(...WAREHOUSE_OPTION_READERS)");
  });
});

// Items 3-10 are fixed by HIDING the panel for the roles below (frontend). These pin the premise —
// that those roles really cannot read what the panel needs — so the hide is never "fixed" by granting.
describe("#3-#10 the panels hidden in the UI really are unreadable for those roles", () => {
  it("#3 #22 System Admin cannot read hire movements (rentals.view)", () => {
    expect(holds(SA, "rentals.view")).toBe(false);
  });
  it("#4-#7 System Admin cannot read the audit trail (audit.view)", () => {
    expect(holds(SA, "audit.view")).toBe(false);
  });
  it("#8 Finance Director cannot read a warehouse's customer stock (stock_requests.view)", () => {
    expect(holds(FD, "stock_requests.view")).toBe(false);
    // …and the panel the tab now falls back to IS readable for them.
    expect(holds(FD, "rentals.view")).toBe(true);
  });
  it("#9 Project Manager cannot read the damaged pool (goods_management.view)", () => {
    expect(holds(PM, "goods_management.view")).toBe(false);
  });
  it("#10 Project Manager cannot read the movement ledger (inventory.history)", () => {
    expect(holds(PM, "inventory.history")).toBe(false);
  });
});

describe("#11 Stock entry category — Project Manager", () => {
  it("reads the category names on the read-only entry page", () => {
    expect(passes(PM, CATEGORY_LIST_READERS)).toBe(true);
  });
});

// ── P2: seeded roles that saw an empty filter ───────────────────────────────────────────────────

describe("#12-#14 the type filters", () => {
  const supplierTypes = keysIn(getGuard("supplier-type/supplier-type.routes.ts", "router", "/"));
  const warehouseTypes = keysIn(getGuard("warehouse-type/warehouse-type.routes.ts", "router", "/"));
  const irmTypes = keysIn(getGuard("irm-type/irm-type.routes.ts", "router", "/"));

  it("#12 Suppliers → Type: Finance Director and Project Manager", () => {
    expect(passes(FD, supplierTypes)).toBe(true);
    expect(passes(PM, supplierTypes)).toBe(true);
  });
  it("#13 Warehouses → Type: Finance Director and Project Manager", () => {
    expect(passes(FD, warehouseTypes)).toBe(true);
    expect(passes(PM, warehouseTypes)).toBe(true);
  });
  it("#14 IRM → Type: Project Manager and Warehouse Manager", () => {
    expect(passes(PM, irmTypes)).toBe(true);
    expect(passes(WM, irmTypes)).toBe(true);
  });
  it("still refuses a role with none of those modules", () => {
    expect(passes(ROLES.field_engineer!, supplierTypes)).toBe(false);
    expect(passes(ROLES.field_engineer!, warehouseTypes)).toBe(false);
    expect(passes(ROLES.field_engineer!, irmTypes)).toBe(false);
  });
});

describe("#15-#18 supplier filters — Warehouse Manager", () => {
  it.each([
    ["#15 IRM catalogue", "irm.view"],
    ["#16 Rentals → On hire", "rentals.view"],
    ["#17 Expected deliveries", "purchase_orders.view"],
    ["#18 Goods receipts", "goods_in.view"],
  ])("%s (%s)", (_where, key) => {
    expect(holds(WM, key)).toBe(true);
    expect(SUPPLIER_OPTION_READERS).toContain(key);
  });
  it("#18 the GRN list's warehouse filter too", () => {
    expect(WAREHOUSE_OPTION_READERS).toContain("goods_in.view");
  });
});

describe("#19-#21 Warehouse Manager customer/site filters stay HIDDEN, not widened", () => {
  // The fix for these three is to hide the filter: the warehouse manager is warehouse-scoped, and the
  // customer/site lists are company-wide. These pin that no option endpoint was opened to them.
  it("cannot read the customer options", () => {
    expect(passes(WM, CUSTOMER_OPTION_READERS, CUSTOMER_OPTION_UNSCOPED_READERS)).toBe(false);
  });
  it("cannot search sites", () => {
    expect(passes(WM, JOB_SITE_SEARCH_READERS, CUSTOMER_OPTION_UNSCOPED_READERS)).toBe(false);
    expect(passes(WM, CUSTOMER_SITE_OPTION_READERS)).toBe(false);
  });
  it("still does not hold the customer directory", () => {
    expect(holds(WM, "customers.view")).toBe(false);
  });
});

describe("#23 Jobs list project filter — Finance Director", () => {
  it("reads the lean project options with jobs.view", () => {
    expect(passes(FD, CUSTOMER_OPTION_READERS, CUSTOMER_OPTION_UNSCOPED_READERS)).toBe(true);
    expect(getGuard("customer/customer.routes.ts", "adminRouter", "/:id/project-options")).toContain(
      "requireAnyPermissionUnlessScoped(CUSTOMER_OPTION_READERS, CUSTOMER_OPTION_UNSCOPED_READERS)",
    );
  });
  it("the paged detail-tab read keeps its customers.view gate", () => {
    expect(getGuard("customer/customer.routes.ts", "adminRouter", "/:id/projects")).toContain('requirePermission("customers.view")');
    expect(getGuard("customer/customer.routes.ts", "adminRouter", "/:id/sites")).toContain('requirePermission("customers.view")');
  });
});

// ── P3: roles assembled in Users & Roles ────────────────────────────────────────────────────────

describe("#24-#26 a job planner holding only the jobs keys", () => {
  const planner = custom(["jobs.view", "jobs.create", "jobs.edit"]);

  it("#24 can pick the customer, its project and search its sites", () => {
    expect(passes(planner, CUSTOMER_OPTION_READERS)).toBe(true);
    expect(passes(planner, CUSTOMER_SITE_OPTION_READERS)).toBe(true);
    expect(getGuard("customer/customer.routes.ts", "adminRouter", "/:id/site-options")).toContain(
      "requireAnyPermission(...CUSTOMER_SITE_OPTION_READERS)",
    );
  });
  it("#25 can draw kit from the customer's own stock", () => {
    expect(passes(planner, CUSTOMER_STOCK_OPTION_READERS)).toBe(true);
    expect(getGuard("customer/customer.routes.ts", "adminRouter", "/:id/stock-options")).toContain(
      "requireAnyPermission(...CUSTOMER_STOCK_OPTION_READERS)",
    );
  });
  it("#26 keeps its stock checks: availability, per-item warehouse stock, cross-job demand", () => {
    expect(passes(planner, STOCK_CHECK_READERS)).toBe(true);
    expect(passes(custom(["jobs.kit_request.review", "jobs.view"]), STOCK_CHECK_READERS)).toBe(true);
    expect(getGuard("inventory/inventory.routes.ts", "router", "/availability")).toContain("requireAnyPermission(...STOCK_CHECK_READERS)");
    expect(getGuard("inventory/inventory.routes.ts", "router", "/items/:irmItemId/warehouse-stock")).toContain(
      "requireAnyPermission(...STOCK_CHECK_READERS)",
    );
    expect(getGuard("goods-management/goods-management.routes.ts", "router", "/demand")).toContain(
      "requireAnyPermission(...STOCK_CHECK_READERS)",
    );
  });
  it("gains no stock READ beyond the checks — the inventory list and its values stay inventory.view", () => {
    expect(getGuard("inventory/inventory.routes.ts", "router", "/")).toContain('requirePermission("inventory.view")');
  });
});

describe("#27 hire pages require purchase_orders.view", () => {
  it.each(["rentals.hire.receive", "rentals.hire.settle", "rentals.hire.manage"])("%s pulls purchase_orders.view in", (key) => {
    expect(closePrerequisites([key])).toContain("purchase_orders.view");
  });
  // Before changing the catalogue: every seeded role that holds a hire key must already hold the PO
  // read, or it would silently gain a permission on its next save — or worse, a stored role would
  // disagree with its own closure.
  it("no seeded role that uses hires loses — or newly gains — anything", () => {
    for (const [key, role] of Object.entries(ROLES)) {
      if (role.perms.some((p) => p.startsWith("rentals.hire."))) {
        expect(holds(role, "purchase_orders.view"), key).toBe(true);
      }
    }
    expect(holds(WM, "rentals.hire.receive")).toBe(true);
    expect(holds(PM, "rentals.hire.manage")).toBe(true);
  });
});

describe("#28 Custom Reports filters for a reports.view role", () => {
  const reporter = custom(["reports.view"]);
  const scopedReporter = custom(["reports.view"], true);

  it("an unscoped reporter reads every picker", () => {
    expect(passes(reporter, CUSTOMER_OPTION_READERS, CUSTOMER_OPTION_UNSCOPED_READERS)).toBe(true); // customers + projects
    expect(passes(reporter, JOB_SITE_SEARCH_READERS, CUSTOMER_OPTION_UNSCOPED_READERS)).toBe(true); // sites
    expect(passes(reporter, WAREHOUSE_OPTION_READERS)).toBe(true);
    expect(passes(reporter, INVENTORY_ENGINEER_OPTION_READERS)).toBe(true);
    expect(passes(reporter, IRM_PICKER_PERMISSIONS)).toBe(true);
  });
  // Data scoping: a warehouse-scoped user's reports are scoped to their warehouses, so the same key
  // must NOT open the company-wide customer, project and site lists to them.
  it("a WAREHOUSE-SCOPED reporter does not get the company-wide customer/project/site lists", () => {
    expect(passes(scopedReporter, CUSTOMER_OPTION_READERS, CUSTOMER_OPTION_UNSCOPED_READERS)).toBe(false);
    expect(passes(scopedReporter, JOB_SITE_SEARCH_READERS, CUSTOMER_OPTION_UNSCOPED_READERS)).toBe(false);
  });
  it("the site search enforces the same rule", () => {
    expect(getGuard("job/job.routes.ts", "router", "/site-options")).toContain(
      "requireAnyPermissionUnlessScoped(JOB_SITE_SEARCH_READERS, CUSTOMER_OPTION_UNSCOPED_READERS)",
    );
  });
});

describe("#29-#31 and #33 the remaining custom-role pickers", () => {
  it("#29 a finance-reporting role reads the supplier options", () => {
    expect(passes(custom(["reports.finance.view"]), SUPPLIER_OPTION_READERS)).toBe(true);
  });
  it("#30 the Purchase Requests list filters read with purchase_requests.view", () => {
    expect(passes(custom(["purchase_requests.view"]), SUPPLIER_OPTION_READERS)).toBe(true);
    expect(passes(custom(["purchase_requests.view"]), WAREHOUSE_OPTION_READERS)).toBe(true);
  });
  it("#30 a requester picks the delivery warehouse without warehouse.view", () => {
    for (const key of ["purchase_requests.create", "purchase_requests.edit", "purchase_orders.create", "purchase_orders.edit"]) {
      expect(passes(custom([key]), WAREHOUSE_DELIVERY_OPTION_READERS), key).toBe(true);
    }
    expect(getGuard("warehouse/warehouse.routes.ts", "router", "/delivery-options")).toContain(
      "requireAnyPermission(...WAREHOUSE_DELIVERY_OPTION_READERS)",
    );
  });
  it("#30 the delivery list is NOT opened to viewers — only to those who fill in a delivery warehouse", () => {
    expect(WAREHOUSE_DELIVERY_OPTION_READERS).not.toContain("purchase_requests.view");
    expect(WAREHOUSE_DELIVERY_OPTION_READERS).not.toContain("purchase_orders.view");
  });
  it.each(["stock_requests.approve", "customer_stock.create", "customer_stock.view"])(
    "#31 the customer-stock warehouse pickers read with %s",
    (key) => {
      expect(passes(custom([key]), WAREHOUSE_OPTION_READERS)).toBe(true);
    },
  );
  it("#33 the engineer-transfer board reads the engineer list", () => {
    expect(passes(custom(["engineer_stock.view"]), ENGINEER_OPTION_READERS)).toBe(true);
    expect(getGuard("warehouse/warehouse.routes.ts", "router", "/engineer-options")).toContain(
      "requireAnyPermission(...ENGINEER_OPTION_READERS)",
    );
  });
});

// ── No privilege escalation ─────────────────────────────────────────────────────────────────────

describe("the widened readers only ever guard READS", () => {
  const moduleDir = join(SRC, "modules");
  const routeFiles = readdirSync(moduleDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(join(moduleDir, d.name))
        .filter((f) => f.endsWith(".routes.ts"))
        .map((f) => join(moduleDir, d.name, f)),
    );
  const NAMES = [
    "CUSTOMER_OPTION_READERS",
    "CUSTOMER_OPTION_UNSCOPED_READERS",
    "CUSTOMER_SITE_OPTION_READERS",
    "CUSTOMER_STOCK_OPTION_READERS",
    "JOB_SITE_SEARCH_READERS",
    "SUPPLIER_OPTION_READERS",
    "WAREHOUSE_OPTION_READERS",
    "WAREHOUSE_DELIVERY_OPTION_READERS",
    "ENGINEER_OPTION_READERS",
    "INVENTORY_ENGINEER_OPTION_READERS",
    "STOCK_CHECK_READERS",
  ];

  it.each(NAMES)("%s is used only on GET routes", (name) => {
    const methods: string[] = [];
    for (const file of routeFiles) {
      const src = stripLineComments(readFileSync(file, "utf8"));
      for (const m of src.matchAll(/\.(get|post|put|patch|delete)\(\s*"[^"]*",([\s\S]*?)\);/g)) {
        if (new RegExp(`\\b${name}\\b`).test(m[2]!)) methods.push(m[1]!);
      }
    }
    expect(methods.length, `${name} guards no route`).toBeGreaterThan(0);
    expect([...new Set(methods)]).toEqual(["get"]);
  });

  it("no seeded role gained a module view permission from this work", () => {
    // The fix widens READERS of lean option lists; it grants no role anything.
    expect(holds(FD, "customers.view")).toBe(false);
    expect(holds(FD, "inventory.view")).toBe(false);
    expect(holds(WM, "suppliers.view")).toBe(false);
    expect(holds(WM, "customers.view")).toBe(false);
    expect(holds(SA, "audit.view")).toBe(false);
    expect(holds(SA, "rentals.view")).toBe(false);
  });
});
