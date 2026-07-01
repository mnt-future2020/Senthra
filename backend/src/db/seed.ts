import { env } from "../config/env.js";
import * as adminRepo from "#modules/auth/admin.repository.js";
import * as categoryRepo from "#modules/category/category.repository.js";
import * as emailTemplateRepo from "#modules/email/emailTemplate.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as irmTypeRepo from "#modules/irm-type/irm-type.repository.js";
import * as irmCategoryRepo from "#modules/irm-category/irm-category.repository.js";
import * as roleRepo from "#modules/role/role.repository.js";
import * as supplierTypeRepo from "#modules/supplier-type/supplier-type.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as warehouseTypeRepo from "#modules/warehouse-type/warehouse-type.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as settingsRepo from "#modules/settings/settings.repository.js";
import { LEGACY_PERMISSION_EXPANSION, PERMISSION_KEYS, customerCompatAdditions } from "#modules/role/permissions.js";
import { DEFAULT_EMAIL_TEMPLATES } from "#modules/email/emailTemplate.defaults.js";
import { renderBodyToHtml } from "../utils/email-html.js";
import { hashPassword } from "../utils/password.js";
import { slugify } from "../utils/slugify.js";

// The Senthra domain roles (business-flow doc, FLOW 14). Only super_admin is
// seeded as a system role (locked — undeletable + unrenamable, and its "*" is
// permanently protected by key in role.service). The other seven are ordinary
// roles the admin fully controls — rename or delete them from the UI. Seeded only
// on a fresh DB (see below), so admin edits are never overwritten on restart.
// Default permissions: super_admin holds everything ("*"), system_admin gets the
// granular Users + Customers + Warehouses + Categories permissions + roles.view
// (IT/HR onboarding + customer & stock master-data setup); the rest start empty and
// gain permissions as feature modules ship. NOTE: external customers are NOT a role — they're a separate read-only
// `customer` principal type (see types/principal.ts), so there is no customer role.
// Field-operations role keys — members may HOLD field stock (Job Pack issue recipient +
// engineer-to-engineer transfers). Used both to seed `canHoldStock` on a fresh DB and to
// backfill it idempotently on every startup.
const FIELD_OPS_ROLE_KEYS = [
  "field_engineer",
  "senior_engineer",
  "lead_engineer",
  "technician",
  "field_supervisor",
];

// Engineer Portal permission keys granted to field-operations roles (so a field role gives portal
// access out of the box). Seeded on field_engineer + backfilled idempotently below.
const ENGINEER_PORTAL_PERMISSIONS = [
  "engineer.dashboard.view",
  "engineer.inventory.view",
  "engineer.settings.edit",
  // Engineer-side Job access — see their assigned jobs + accept one. Seeded on field
  // roles + backfilled idempotently via the Engineer Portal block below.
  "engineer.jobs.view",
  "engineer.jobs.accept",
  "engineer.jobs.reject",
  "engineer.jobs.start",
  "engineer.jobs.complete",
  // Engineer-to-engineer stock transfer (self-service).
  "engineer.transfer",
];

// Admin-side engineer stock transfer permissions granted to super_admin and operations roles.
const ENGINEER_STOCK_ADMIN_PERMISSIONS = [
  "engineer_stock.view",
  "engineer_stock.transfer",
];

// Office-side Job module permissions for roles that create/assign/track job packs (the
// project_manager is the natural owner). Seeded on project_manager + backfilled idempotently.
const JOB_OFFICE_PERMISSIONS = [
  "jobs.view",
  "jobs.create",
  "jobs.edit",
  "jobs.assign",
  "jobs.cancel",
  "jobs.delete",
];

// Goods Management permissions for warehouse-side roles (issue/receive/reconcile). Seeded on the
// warehouse_manager + backfilled idempotently below.
const GOODS_MANAGEMENT_PERMISSIONS = [
  "goods_management.view",
  "goods_management.issue",
  "goods_management.receive_return",
  "goods_management.reconcile",
];

// Warehouse-scoped role keys — members may ONLY access their explicitly-assigned warehouses
// (UserWarehouseAssignment). Used to seed Role.isWarehouseScoped on a fresh DB and backfill it
// idempotently on every startup. The warehouse-access layer turns the flag into real enforcement.
const WAREHOUSE_SCOPED_ROLE_KEYS = ["warehouse_manager"];

// Operational permissions that make the Warehouse Manager role usable end-to-end. EVERY one stays
// scoped to the user's assigned warehouses by the warehouse-access layer (a WM never gets global
// reach). Mapped to the real permission keys: "transaction/movement view" = inventory.view +
// inventory.history; "transfer / move stock" = inventory.move; "add stock" = inventory.adjust;
// "PO update" = purchase_orders.edit. Seeded on warehouse_manager + backfilled idempotently below.
const WAREHOUSE_MANAGER_PERMISSIONS = [
  "warehouse.view",
  "warehouse.edit",
  "warehouse_types.view",
  "inventory.view",
  "inventory.history",
  "inventory.adjust",
  "inventory.move",
  // Day-to-day receiving: a manager creates, corrects, completes (posts stock) and cancels a mistaken
  // DRAFT goods receipt for their assigned warehouse. `cancel` is state-machine-limited to drafts (a
  // completed GRN is terminal); `delete` is intentionally withheld — deletion isn't a warehouse op.
  "goods_in.view",
  "goods_in.create",
  "goods_in.edit",
  "goods_in.complete",
  "goods_in.cancel",
  "purchase_orders.view",
  "purchase_orders.create",
  "purchase_orders.edit",
];

const SEED_ROLES: {
  key: string;
  name: string;
  description: string;
  sortOrder: number;
  permissions: string[];
  canHoldStock?: boolean;
  isWarehouseScoped?: boolean;
}[] = [
  { key: "super_admin", name: "Super Admin", description: "Full system owner. Manages users, roles and all settings.", sortOrder: 0, permissions: ["*"] },
  { key: "system_admin", name: "System Admin", description: "IT / HR administrator who creates and manages user accounts and customers.", sortOrder: 1, permissions: ["users.view", "users.create", "users.edit", "users.delete", "roles.view", "customers.view", "customers.create", "customers.edit", "customers.delete", "warehouse.view", "warehouse.create", "warehouse.edit", "warehouse.delete", "warehouse_types.view", "warehouse_types.create", "warehouse_types.edit", "warehouse_types.delete", "categories.view", "categories.create", "categories.edit", "categories.delete", "suppliers.view", "suppliers.create", "suppliers.edit", "suppliers.delete", "supplier_types.view", "supplier_types.create", "supplier_types.edit", "supplier_types.delete", "irm.view", "irm.create", "irm.edit", "irm.delete", "irm_types.view", "irm_types.create", "irm_types.edit", "irm_types.delete", "irm_categories.view", "irm_categories.create", "irm_categories.edit", "irm_categories.delete", "purchase_orders.view", "purchase_orders.create", "purchase_orders.edit", "purchase_orders.delete", "purchase_orders.submit", "purchase_orders.approve", "purchase_orders.send", "purchase_orders.cancel", "purchase_orders.close", "goods_in.view", "goods_in.create", "goods_in.edit", "goods_in.delete", "goods_in.complete", "goods_in.cancel", "inventory.view", "inventory.move", "inventory.history", "inventory.export", "inventory.adjust", "inventory.stock_take", "jobs.view", "jobs.create", "jobs.edit", "jobs.assign", "jobs.cancel", "jobs.delete", ...ENGINEER_STOCK_ADMIN_PERMISSIONS] },
  { key: "project_manager", name: "Project Manager", description: "Creates job packs, authorises dispatch and tracks projects.", sortOrder: 2, permissions: [...JOB_OFFICE_PERMISSIONS] },
  { key: "project_coordinator", name: "Project Coordinator", description: "Supports project managers with day-to-day coordination.", sortOrder: 3, permissions: [] },
  { key: "warehouse_manager", name: "Warehouse Manager", description: "Receives goods, scans stock in/out and manages a warehouse.", sortOrder: 4, permissions: [...WAREHOUSE_MANAGER_PERMISSIONS, ...GOODS_MANAGEMENT_PERMISSIONS, ...ENGINEER_STOCK_ADMIN_PERMISSIONS], isWarehouseScoped: true },
  { key: "field_engineer", name: "Field Engineer", description: "Collects stock, installs on site and updates job status.", sortOrder: 5, permissions: [...ENGINEER_PORTAL_PERMISSIONS], canHoldStock: true },
  { key: "finance_director", name: "Finance Director", description: "Views spend, purchase orders and finance reports.", sortOrder: 6, permissions: [] },
  { key: "hr_manager", name: "HR Manager", description: "Manages people-related records and onboarding.", sortOrder: 7, permissions: [] },
];

// Ensure the Settings singleton, system roles, default email templates and the
// initial Admin (from env) exist. Runs on startup; safe to run repeatedly — each
// step only creates what's missing (upserts never overwrite admin edits).
export async function seedDatabase(): Promise<void> {
  if ((await settingsRepo.count()) === 0) {
    await settingsRepo.create({});
    console.log("Seeded default settings.");
  }

  // Seed the starter roles ONLY on a fresh DB. They're created as ordinary
  // (non-system) roles so the admin keeps full control: once seeded, renames and
  // deletes stick and nothing here touches the roles again on later restarts.
  if ((await roleRepo.count()) === 0) {
    for (const r of SEED_ROLES) {
      await roleRepo.create({
        key: r.key,
        name: r.name,
        description: r.description,
        // Only Super Admin is locked as a system role; the rest stay fully editable.
        isSystem: r.key === "super_admin",
        sortOrder: r.sortOrder,
        permissions: r.permissions,
        canHoldStock: r.canHoldStock ?? false,
        isWarehouseScoped: r.isWarehouseScoped ?? false,
      });
    }
    console.log(`Seeded ${SEED_ROLES.length} roles.`);
  }

  // Backfill the field-operations capability idempotently (covers DBs seeded before
  // `canHoldStock` existed). Only grants it to the known field-ops role keys, and only
  // when not already set — never revokes an admin's manual grant.
  {
    let granted = 0;
    for (const role of await roleRepo.findMany()) {
      if (FIELD_OPS_ROLE_KEYS.includes(role.key) && !role.canHoldStock) {
        await roleRepo.update(role.id, { canHoldStock: true });
        granted++;
      }
    }
    if (granted > 0) console.log(`Granted stock-holding capability to ${granted} field-operations role(s).`);
  }

  // Backfill Engineer Portal access to field-operations roles idempotently (so roles seeded before
  // the portal shipped gain it). Additive + never revokes; skips "*" roles (they already cover it).
  {
    let granted = 0;
    for (const role of await roleRepo.findMany()) {
      if (!FIELD_OPS_ROLE_KEYS.includes(role.key) || role.permissions.includes("*")) continue;
      const missing = ENGINEER_PORTAL_PERMISSIONS.filter((p) => !role.permissions.includes(p));
      if (missing.length) {
        await roleRepo.update(role.id, { permissions: [...role.permissions, ...missing] });
        granted++;
      }
    }
    if (granted > 0) console.log(`Granted Engineer Portal access to ${granted} field-operations role(s).`);
  }

  // Backfill the warehouse-scoping capability idempotently (covers DBs seeded before
  // `isWarehouseScoped` existed). Only the known warehouse-scoped role keys, only when not already
  // set — never revokes an admin's manual grant.
  {
    let granted = 0;
    for (const role of await roleRepo.findMany()) {
      if (WAREHOUSE_SCOPED_ROLE_KEYS.includes(role.key) && !role.isWarehouseScoped) {
        await roleRepo.update(role.id, { isWarehouseScoped: true });
        granted++;
      }
    }
    if (granted > 0) console.log(`Granted warehouse-scoping capability to ${granted} role(s).`);
  }

  // Backfill the Warehouse Manager operational permissions idempotently (so a warehouse_manager role
  // seeded before this expansion becomes usable end-to-end). Additive + never revokes; skips "*" roles.
  {
    let granted = 0;
    for (const role of await roleRepo.findMany()) {
      if (!WAREHOUSE_SCOPED_ROLE_KEYS.includes(role.key) || role.permissions.includes("*")) continue;
      const missing = WAREHOUSE_MANAGER_PERMISSIONS.filter((p) => !role.permissions.includes(p));
      if (missing.length) {
        await roleRepo.update(role.id, { permissions: [...role.permissions, ...missing] });
        granted++;
      }
    }
    if (granted > 0) console.log(`Granted Warehouse Manager operational permissions to ${granted} role(s).`);
  }

  // Backfill the office-side Job module permissions onto the project_manager role idempotently
  // (so a role seeded before the Job module shipped becomes usable). Additive + never revokes; skips "*".
  {
    let granted = 0;
    for (const role of await roleRepo.findMany()) {
      if (role.key !== "project_manager" || role.permissions.includes("*")) continue;
      const missing = JOB_OFFICE_PERMISSIONS.filter((p) => !role.permissions.includes(p));
      if (missing.length) {
        await roleRepo.update(role.id, { permissions: [...role.permissions, ...missing] });
        granted++;
      }
    }
    if (granted > 0) console.log(`Granted Job module permissions to ${granted} role(s).`);
  }

  // Backfill Goods Management permissions onto warehouse-side roles idempotently. Additive; skips "*".
  {
    let granted = 0;
    for (const role of await roleRepo.findMany()) {
      if (role.key !== "warehouse_manager" || role.permissions.includes("*")) continue;
      const missing = GOODS_MANAGEMENT_PERMISSIONS.filter((p) => !role.permissions.includes(p));
      if (missing.length) {
        await roleRepo.update(role.id, { permissions: [...role.permissions, ...missing] });
        granted++;
      }
    }
    if (granted > 0) console.log(`Granted Goods Management permissions to ${granted} role(s).`);
  }

  // Backfill admin-side engineer stock transfer permissions onto system_admin and warehouse_manager
  // idempotently (covers DBs seeded before the engineer-transfer module shipped). super_admin already
  // holds "*" and is skipped. Also seeded directly into the base role literals above for fresh DBs.
  {
    const adminRoleKeys = ["system_admin", "warehouse_manager"];
    let granted = 0;
    for (const role of await roleRepo.findMany()) {
      if (role.permissions.includes("*")) continue; // super_admin already covers everything
      if (!adminRoleKeys.includes(role.key)) continue;
      const missing = ENGINEER_STOCK_ADMIN_PERMISSIONS.filter((p) => !role.permissions.includes(p));
      if (missing.length) {
        await roleRepo.update(role.id, { permissions: [...role.permissions, ...missing] });
        granted++;
      }
    }
    if (granted > 0) console.log(`Granted engineer stock transfer admin permissions to ${granted} role(s).`);
  }

  // Seed a starter global stock-category list ONLY on a fresh DB. These are ordinary
  // admin-managed categories (no system flag) — once seeded, renames/deletes stick and
  // nothing here touches them again. Stock entries reference a category by id.
  if ((await categoryRepo.findMany()).length === 0) {
    const SEED_CATEGORIES = ["Optical", "Fiber", "Core", "Router", "Switch", "Cable", "Connector"];
    for (let i = 0; i < SEED_CATEGORIES.length; i++) {
      const name = SEED_CATEGORIES[i];
      await categoryRepo.create({ key: slugify(name), name, status: "active", sortOrder: i });
    }
    console.log(`Seeded ${SEED_CATEGORIES.length} categories.`);
  }

  // Seed the starter Warehouse Type master ONLY on a fresh DB. Names map 1:1 from the
  // old hardcoded `Warehouse.type` enum so the backfill below can translate cleanly.
  if ((await warehouseTypeRepo.findMany()).length === 0) {
    const SEED_WAREHOUSE_TYPES = [
      "Main Depot",
      "Regional Hub",
      "Transit Point",
      "Engineer Van",
      "Returns Centre",
      "Virtual",
    ];
    for (let i = 0; i < SEED_WAREHOUSE_TYPES.length; i++) {
      const name = SEED_WAREHOUSE_TYPES[i];
      await warehouseTypeRepo.create({ key: slugify(name), name, status: "active", sortOrder: i });
    }
    console.log(`Seeded ${SEED_WAREHOUSE_TYPES.length} warehouse types.`);
  }

  // Seed the starter Supplier Type master ONLY on a fresh DB. Ordinary admin-managed
  // types (no system flag) — once seeded, renames/deletes stick and nothing here touches
  // them again. Suppliers reference a type by id.
  if ((await supplierTypeRepo.findMany()).length === 0) {
    const SEED_SUPPLIER_TYPES = [
      "Manufacturer",
      "Distributor",
      "Vendor",
      "Service Partner",
      "Logistics Partner",
      "Repair Partner",
    ];
    for (let i = 0; i < SEED_SUPPLIER_TYPES.length; i++) {
      const name = SEED_SUPPLIER_TYPES[i];
      await supplierTypeRepo.create({ key: slugify(name), name, status: "active", sortOrder: i });
    }
    console.log(`Seeded ${SEED_SUPPLIER_TYPES.length} supplier types.`);
  }

  // Seed the starter IRM Type + IRM Category masters ONLY on a fresh DB. Ordinary
  // admin-managed records (no system flag) — once seeded, renames/deletes stick.
  if ((await irmTypeRepo.findMany()).length === 0) {
    const SEED_IRM_TYPES = [
      "Consumable",
      "Asset",
      "Tool",
      "Spare Part",
      "Accessory",
      "Equipment",
      "Packaging",
      "Rental Item",
    ];
    for (let i = 0; i < SEED_IRM_TYPES.length; i++) {
      const name = SEED_IRM_TYPES[i];
      await irmTypeRepo.create({ key: slugify(name), name, status: "active", sortOrder: i });
    }
    console.log(`Seeded ${SEED_IRM_TYPES.length} IRM types.`);
  }
  if ((await irmCategoryRepo.findMany()).length === 0) {
    const SEED_IRM_CATEGORIES = [
      "Fibre",
      "Cable",
      "Connectors",
      "Network Hardware",
      "Power",
      "Test Equipment",
      "Consumables",
      "Safety",
    ];
    for (let i = 0; i < SEED_IRM_CATEGORIES.length; i++) {
      const name = SEED_IRM_CATEGORIES[i];
      await irmCategoryRepo.create({ key: slugify(name), name, status: "active", sortOrder: i });
    }
    console.log(`Seeded ${SEED_IRM_CATEGORIES.length} IRM categories.`);
  }

  // Enforce GLOBAL-FOREVER SKU uniqueness for IRM items at the DB with a partial unique
  // index (Prisma can't express partial/sparse indexes for MongoDB — see the repository).
  // Idempotent — a no-op once the index exists, so it runs safely on every boot.
  await irmRepo.ensureSkuUniqueIndex();

  // One-time migration: backfill Warehouse.typeId from the legacy `type` string, then
  // ensure EVERY warehouse has a typeId (so it can become the single source of truth).
  // Idempotent — only touches rows where typeId is still null. The legacy-string read
  // is removed in pass 2 once this has run (the fallback safety net stays).
  await backfillWarehouseTypeIds();

  // Migrate any role still holding a pre-granular "coarse" permission (e.g.
  // "users.manage") to the new per-action keys. Idempotent: "*" (super-admin) is
  // left alone and a role is only rewritten when its expanded set actually differs,
  // so this is a no-op on every boot after the one-time upgrade.
  let migratedRoles = 0;
  for (const role of await roleRepo.findMany()) {
    if (role.permissions.includes("*")) continue;
    const expanded = new Set<string>();
    for (const perm of role.permissions) {
      const mapped = LEGACY_PERMISSION_EXPANSION[perm];
      if (mapped) mapped.forEach((p) => expanded.add(p));
      else expanded.add(perm);
    }
    const next = [...expanded];
    const unchanged =
      next.length === role.permissions.length &&
      next.every((p) => role.permissions.includes(p));
    if (!unchanged) {
      await roleRepo.update(role.id, { permissions: { set: next } });
      migratedRoles++;
    }
  }
  if (migratedRoles > 0) {
    console.log(`Migrated ${migratedRoles} role(s) to granular permissions.`);
  }

  // Prune any permission a role still holds that no longer exists in the catalog (e.g. a module whose
  // permissions were removed, like the retired Goods Out). Without this, an orphaned key sits harmlessly
  // on the role but the role editor re-submits it and the strict `sanitizePermissions` check then rejects
  // the save. Idempotent: "*" (super-admin) is skipped and a role is only rewritten when a stale key is
  // actually present, so this is a no-op on every boot after the one-time cleanup.
  const catalogKeys = new Set(PERMISSION_KEYS);
  let prunedRoles = 0;
  for (const role of await roleRepo.findMany()) {
    if (role.permissions.includes("*")) continue;
    const kept = role.permissions.filter((p) => catalogKeys.has(p));
    if (kept.length !== role.permissions.length) {
      await roleRepo.update(role.id, { permissions: { set: kept } });
      prunedRoles++;
    }
  }
  if (prunedRoles > 0) {
    console.log(`Pruned stale permissions from ${prunedRoles} role(s).`);
  }

  // Customer RBAC split backward-compat. The customer module's projects, stock,
  // sites, portal login and stock requests used to be gated by the coarse
  // customers.view / customers.edit keys; they now have their own granular groups.
  // Backfill the matching child keys onto EVERY role (built-in AND admin-created) that
  // held a coarse key, so no role loses any effective access when the routes re-gate.
  // Purely additive + idempotent ("*" roles are skipped, already grant everything), so
  // this is a no-op on every boot after the one-time upgrade.
  let customerSplitRoles = 0;
  for (const role of await roleRepo.findMany()) {
    const additions = customerCompatAdditions(role.permissions);
    if (additions.length) {
      await roleRepo.update(role.id, {
        permissions: { set: [...role.permissions, ...additions] },
      });
      customerSplitRoles++;
    }
  }
  if (customerSplitRoles > 0) {
    console.log(`Backfilled granular customer permissions onto ${customerSplitRoles} role(s).`);
  }

  // Backfill new module grants onto the built-in roles for ALREADY-SEEDED DBs (the
  // SEED_ROLES block above only runs on a fresh DB). Additive + idempotent: grants the
  // new customers / warehouse / category keys to system_admin only if missing, and
  // never touches a role holding "*". Also retires the vestigial empty customer_pm role
  // (customers are now a separate principal type, not a role) when it's safe to remove.
  const existingRoles = await roleRepo.findMany();
  const systemAdmin = existingRoles.find((r) => r.key === "system_admin");
  if (systemAdmin && !systemAdmin.permissions.includes("*")) {
    // Every built-in grant system_admin should hold (customers, warehouses + types, and
    // the global stock-category master). One read, one update — only missing keys added.
    const wanted = [
      "customers.view", "customers.create", "customers.edit", "customers.delete",
      "warehouse.view", "warehouse.create", "warehouse.edit", "warehouse.delete",
      "warehouse_types.view", "warehouse_types.create", "warehouse_types.edit", "warehouse_types.delete",
      "categories.view", "categories.create", "categories.edit", "categories.delete",
      "suppliers.view", "suppliers.create", "suppliers.edit", "suppliers.delete",
      "supplier_types.view", "supplier_types.create", "supplier_types.edit", "supplier_types.delete",
      "irm.view", "irm.create", "irm.edit", "irm.delete", "irm.barcode.manage",
      "irm_types.view", "irm_types.create", "irm_types.edit", "irm_types.delete",
      "irm_categories.view", "irm_categories.create", "irm_categories.edit", "irm_categories.delete",
      "purchase_orders.view", "purchase_orders.create", "purchase_orders.edit", "purchase_orders.delete",
      "purchase_orders.submit", "purchase_orders.approve", "purchase_orders.send", "purchase_orders.cancel", "purchase_orders.close",
      "goods_in.view", "goods_in.create", "goods_in.edit", "goods_in.delete", "goods_in.complete", "goods_in.cancel",
      "inventory.view", "inventory.move", "inventory.history", "inventory.export", "inventory.adjust", "inventory.stock_take",
      "jobs.view", "jobs.create", "jobs.edit", "jobs.assign", "jobs.cancel", "jobs.delete",
      "goods_management.view", "goods_management.issue", "goods_management.receive_return", "goods_management.reconcile",
      "engineer.jobs.start", "engineer.jobs.complete",
    ];
    const missing = wanted.filter((p) => !systemAdmin.permissions.includes(p));
    if (missing.length) {
      await roleRepo.update(systemAdmin.id, {
        permissions: { set: [...systemAdmin.permissions, ...missing] },
      });
      console.log(`Granted ${missing.length} built-in permission(s) to system_admin.`);
    }
  }
  // Warehouse Manager gets read + edit on warehouses, and read on warehouse types
  // (already-seeded DBs).
  const whManager = existingRoles.find((r) => r.key === "warehouse_manager");
  if (whManager && !whManager.permissions.includes("*")) {
    const wanted = ["warehouse.view", "warehouse.edit", "warehouse_types.view"];
    const missing = wanted.filter((p) => !whManager.permissions.includes(p));
    if (missing.length) {
      await roleRepo.update(whManager.id, {
        permissions: { set: [...whManager.permissions, ...missing] },
      });
      console.log(`Granted ${missing.length} warehouse permission(s) to warehouse_manager.`);
    }
  }
  const customerPmRole = existingRoles.find((r) => r.key === "customer_pm");
  if (customerPmRole && !customerPmRole.isSystem && customerPmRole.permissions.length === 0) {
    // MongoDB has no FK cascade, so a role must be detached from EVERY holder
    // (incl. soft-deleted) before deletion or we leave a dangling roleId that makes
    // `include: { role: true }` resolve to null. customer_pm was an empty-permission
    // role, so detaching it doesn't change any user's effective access.
    await userRepo.clearRole(customerPmRole.id);
    await roleRepo.remove(customerPmRole.id);
    console.log("Removed retired customer_pm role.");
  }

  const templatesBefore = await emailTemplateRepo.count();
  for (const t of DEFAULT_EMAIL_TEMPLATES) {
    // Create-only: never overwrite an admin's edited subject/body on restart
    // (they can use "Restore default" in the UI to reset deliberately).
    await emailTemplateRepo.upsertByKey(t.key, {
      key: t.key,
      name: t.name,
      category: t.category,
      subject: t.subject,
      htmlContent: renderBodyToHtml(t.body),
      textContent: t.body,
      variables: t.variables,
      enabled: true,
      isSystem: true,
    });
  }
  if (templatesBefore === 0) {
    console.log(`Seeded ${DEFAULT_EMAIL_TEMPLATES.length} email templates.`);
  }

  // htmlContent is a pure function of the editable message (textContent), which
  // the app regenerates on every edit. Re-derive it once here so any existing row
  // picks up changes to the HTML frame between releases (single read, only writes
  // rows that actually changed).
  for (const t of await emailTemplateRepo.findMany()) {
    const html = renderBodyToHtml(t.textContent);
    if (html !== t.htmlContent) {
      await emailTemplateRepo.update(t.id, { htmlContent: html });
    }
  }

  if ((await adminRepo.count()) === 0) {
    if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
      console.warn(
        "No admin exists and ADMIN_EMAIL/ADMIN_PASSWORD are not set — skipping admin seed.",
      );
      return;
    }
    const email = env.ADMIN_EMAIL.toLowerCase();
    const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
    await adminRepo.create({ email, passwordHash, googleEmail: email });
    console.log(`Seeded admin account: ${email}`);
  }
}

// Safety net: every warehouse must have a `typeId` (the single source of truth now
// that the legacy `type` string is gone). The one-time legacy→typeId mapping already
// ran; this just assigns the default type ("Main Depot") to any row still missing one.
// Idempotent — only touches rows whose typeId is null.
async function backfillWarehouseTypeIds(): Promise<void> {
  const types = await warehouseTypeRepo.findMany();
  if (types.length === 0) return;
  const fallbackId = types.find((t) => t.name === "Main Depot")?.id ?? types[0].id;

  const orphans = await warehouseRepo.findIdsMissingType();
  let backfilled = 0;
  for (const w of orphans) {
    await warehouseRepo.update(w.id, { typeId: fallbackId });
    backfilled++;
  }
  if (backfilled > 0) console.log(`Assigned default type to ${backfilled} warehouse(s).`);
}
