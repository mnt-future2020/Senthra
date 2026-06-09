import { env } from "../config/env.js";
import * as adminRepo from "#modules/auth/admin.repository.js";
import * as emailTemplateRepo from "#modules/email/emailTemplate.repository.js";
import * as roleRepo from "#modules/role/role.repository.js";
import * as settingsRepo from "#modules/settings/settings.repository.js";
import { LEGACY_PERMISSION_EXPANSION } from "#modules/role/permissions.js";
import { DEFAULT_EMAIL_TEMPLATES } from "#modules/email/emailTemplate.defaults.js";
import { renderBodyToHtml } from "../utils/email-html.js";
import { hashPassword } from "../utils/password.js";

// The Senthra domain roles (business-flow doc, FLOW 14). Only super_admin is
// seeded as a system role (locked — undeletable + unrenamable, and its "*" is
// permanently protected by key in role.service). The other eight are ordinary
// roles the admin fully controls — rename or delete them from the UI. Seeded only
// on a fresh DB (see below), so admin edits are never overwritten on restart.
// Default permissions: super_admin holds everything ("*"), system_admin gets the
// granular Users permissions + roles.view (IT/HR onboarding); the rest start empty
// and gain permissions as feature modules ship.
const SEED_ROLES: {
  key: string;
  name: string;
  description: string;
  sortOrder: number;
  permissions: string[];
}[] = [
  { key: "super_admin", name: "Super Admin", description: "Full system owner. Manages users, roles and all settings.", sortOrder: 0, permissions: ["*"] },
  { key: "system_admin", name: "System Admin", description: "IT / HR administrator who creates and manages user accounts.", sortOrder: 1, permissions: ["users.view", "users.create", "users.edit", "users.delete", "roles.view"] },
  { key: "project_manager", name: "Project Manager", description: "Creates job packs, authorises dispatch and tracks projects.", sortOrder: 2, permissions: [] },
  { key: "project_coordinator", name: "Project Coordinator", description: "Supports project managers with day-to-day coordination.", sortOrder: 3, permissions: [] },
  { key: "warehouse_manager", name: "Warehouse Manager", description: "Receives goods, scans stock in/out and manages a warehouse.", sortOrder: 4, permissions: [] },
  { key: "field_engineer", name: "Field Engineer", description: "Collects stock, installs on site and updates job status.", sortOrder: 5, permissions: [] },
  { key: "finance_director", name: "Finance Director", description: "Views spend, purchase orders and finance reports.", sortOrder: 6, permissions: [] },
  { key: "hr_manager", name: "HR Manager", description: "Manages people-related records and onboarding.", sortOrder: 7, permissions: [] },
  { key: "customer_pm", name: "Customer PM", description: "Customer-side PM with read-only visibility of their stock.", sortOrder: 8, permissions: [] },
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
      });
    }
    console.log(`Seeded ${SEED_ROLES.length} roles.`);
  }

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
