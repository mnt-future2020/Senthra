// The RBAC permission catalog — the *delegatable* permissions a role can grant to
// staff users. Configuring roles/permissions itself stays super-admin only, so it
// is deliberately NOT a delegatable permission here (no privilege-escalation path).
//
// As feature modules ship (inventory, jobs, warehouses…), their permissions get
// added to this catalog and enforced on their routes.

export interface PermissionDef {
  key: string;
  group: string;
  label: string;
  description: string;
}

export const PERMISSIONS: PermissionDef[] = [
  {
    key: "users.manage",
    group: "Users",
    label: "Manage users",
    description: "Create, edit, deactivate and remove staff user accounts.",
  },
  {
    key: "settings.manage",
    group: "Settings",
    label: "Manage settings",
    description: "Branding, email (SMTP), integrations and other app settings.",
  },
  {
    key: "email_templates.manage",
    group: "Email",
    label: "Manage email templates",
    description: "Edit the templates used for the emails the system sends.",
  },
  {
    key: "audit.view",
    group: "Audit",
    label: "View audit log",
    description: "View the system audit trail.",
  },
];

export const PERMISSION_KEYS: string[] = PERMISSIONS.map((p) => p.key);

// Wildcard: a role holding this grants every permission (the super-admin role).
export const ALL_PERMISSIONS = "*";

// Validate + dedupe an incoming permission list against the catalog. "*" is
// accepted (full access). Returns the cleaned valid keys and any unknown ones so
// the caller can reject the request.
export function sanitizePermissions(input: string[]): {
  valid: string[];
  unknown: string[];
} {
  const valid: string[] = [];
  const unknown: string[] = [];
  for (const raw of input) {
    const key = raw.trim();
    if (!key) continue;
    if (key === ALL_PERMISSIONS || PERMISSION_KEYS.includes(key)) {
      if (!valid.includes(key)) valid.push(key);
    } else if (!unknown.includes(key)) {
      unknown.push(key);
    }
  }
  return { valid, unknown };
}

// Does a role's permission set grant a specific permission?
export function roleGrants(permissions: string[], permission: string): boolean {
  return permissions.includes(ALL_PERMISSIONS) || permissions.includes(permission);
}
