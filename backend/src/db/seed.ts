import { env } from "../config/env.js";
import * as adminRepo from "#modules/auth/admin.repository.js";
import * as emailTemplateRepo from "#modules/email/emailTemplate.repository.js";
import * as roleRepo from "#modules/role/role.repository.js";
import * as settingsRepo from "#modules/settings/settings.repository.js";
import { DEFAULT_EMAIL_TEMPLATES } from "#modules/email/email-templates.defaults.js";
import { renderBodyToHtml } from "../utils/email-html.js";
import { hashPassword } from "../utils/password.js";

// The Senthra domain roles (business-flow doc, FLOW 14). Seeded as system roles
// (non-deletable). Permissions are intentionally empty for now — a future RBAC
// phase will populate them.
const SYSTEM_ROLES: {
  key: string;
  name: string;
  description: string;
  sortOrder: number;
}[] = [
  { key: "super_admin", name: "Super Admin", description: "Full system owner. Manages users, roles and all settings.", sortOrder: 0 },
  { key: "system_admin", name: "System Admin", description: "IT / HR administrator who creates and manages user accounts.", sortOrder: 1 },
  { key: "project_manager", name: "Project Manager", description: "Creates job packs, authorises dispatch and tracks projects.", sortOrder: 2 },
  { key: "project_coordinator", name: "Project Coordinator", description: "Supports project managers with day-to-day coordination.", sortOrder: 3 },
  { key: "warehouse_manager", name: "Warehouse Manager", description: "Receives goods, scans stock in/out and manages a warehouse.", sortOrder: 4 },
  { key: "field_engineer", name: "Field Engineer", description: "Collects stock, installs on site and updates job status.", sortOrder: 5 },
  { key: "finance_director", name: "Finance Director", description: "Views spend, purchase orders and finance reports.", sortOrder: 6 },
  { key: "hr_manager", name: "HR Manager", description: "Manages people-related records and onboarding.", sortOrder: 7 },
  { key: "customer_pm", name: "Customer PM", description: "Customer-side PM with read-only visibility of their stock.", sortOrder: 8 },
];

// Ensure the Settings singleton, system roles, default email templates and the
// initial Admin (from env) exist. Runs on startup; safe to run repeatedly — each
// step only creates what's missing (upserts never overwrite admin edits).
export async function seedDatabase(): Promise<void> {
  if ((await settingsRepo.count()) === 0) {
    await settingsRepo.create({});
    console.log("Seeded default settings.");
  }

  const rolesBefore = await roleRepo.count();
  for (const r of SYSTEM_ROLES) {
    await roleRepo.upsertByKey(
      r.key,
      { key: r.key, name: r.name, description: r.description, isSystem: true, sortOrder: r.sortOrder },
      // Reconcile only the code-owned fields on existing rows (name + ordering
      // are not admin-editable for system roles); leave admin-edited description.
      { name: r.name, sortOrder: r.sortOrder },
    );
  }
  if (rolesBefore === 0) console.log(`Seeded ${SYSTEM_ROLES.length} system roles.`);

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
