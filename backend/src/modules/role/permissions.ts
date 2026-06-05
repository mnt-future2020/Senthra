// The RBAC permission catalog — the *delegatable* permissions a role can grant to
// staff users, organised into module groups. Each module exposes per-action keys
// in the form `resource.action` (view / create / edit / delete, or view / manage).
//
// Role configuration is itself delegatable (the `roles.*` group), but every role
// mutation is escalation-guarded in role.service: a delegate can never grant a
// permission it doesn't itself hold, grant full access ("*"), or touch a system
// role. The super-admin account holds "*" and passes every check.
//
// As feature modules ship (inventory, jobs, warehouses…), add a group here and
// enforce its keys on the module's routes — the role-editor matrix renders
// straight from PERMISSION_GROUPS, so no UI change is needed.

// One assignable permission (a single action within a module group).
export interface PermissionAction {
  key: string; // e.g. "users.create"
  action: string; // column label in the matrix, e.g. "Create"
  description: string;
}

// A module group of related permissions (one row-block in the matrix).
export interface PermissionGroup {
  key: string; // module key, e.g. "users"
  label: string; // display name, e.g. "Users"
  description: string;
  permissions: PermissionAction[];
}

// Flat catalog entry (derived) — kept for validation + the legacy list shape.
export interface PermissionDef {
  key: string;
  group: string;
  label: string;
  description: string;
}

// SINGLE SOURCE OF TRUTH for the catalog. Everything else is derived from this.
export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    key: "users",
    label: "Users",
    description: "Staff user accounts.",
    permissions: [
      { key: "users.view", action: "View", description: "View staff users and their details." },
      { key: "users.create", action: "Create", description: "Add new staff users." },
      { key: "users.edit", action: "Edit", description: "Edit users — details, role, status, resend invite." },
      { key: "users.delete", action: "Delete", description: "Remove staff users." },
    ],
  },
  {
    key: "roles",
    label: "Roles & permissions",
    description: "Roles and the permissions each one grants.",
    permissions: [
      { key: "roles.view", action: "View", description: "View roles and their permissions." },
      { key: "roles.create", action: "Create", description: "Create new roles." },
      { key: "roles.edit", action: "Edit", description: "Edit a role's details and permissions." },
      { key: "roles.delete", action: "Delete", description: "Delete roles." },
    ],
  },
  {
    key: "settings",
    label: "Settings",
    description: "Branding, email (SMTP) and integrations.",
    permissions: [
      { key: "settings.view", action: "View", description: "View application settings." },
      { key: "settings.manage", action: "Manage", description: "Edit branding, email (SMTP) and integrations." },
    ],
  },
  {
    key: "email_templates",
    label: "Email templates",
    description: "The templates used for the emails the system sends.",
    permissions: [
      { key: "email_templates.view", action: "View", description: "View email templates." },
      { key: "email_templates.manage", action: "Manage", description: "Edit, enable/disable and restore email templates." },
    ],
  },
  {
    key: "audit",
    label: "Audit log",
    description: "The system audit trail.",
    permissions: [
      { key: "audit.view", action: "View", description: "View the audit log." },
    ],
  },
];

// Flat view of the catalog (derived from the groups above).
export const PERMISSIONS: PermissionDef[] = PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((p) => ({
    key: p.key,
    group: group.label,
    label: `${p.action} — ${group.label}`,
    description: p.description,
  })),
);

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

// Does a permission set grant a specific permission? "*" grants everything.
export function roleGrants(permissions: string[], permission: string): boolean {
  return permissions.includes(ALL_PERMISSIONS) || permissions.includes(permission);
}

// Enforce the "manage implies view" invariant: if a permission set grants any action
// in a module (create / edit / delete / manage), it also gets that module's `view`
// permission — you can't act on what you can't see. Keeps roles coherent on the
// server no matter how they were submitted (so an edit-without-view role can't be
// created via the API). "*" already implies everything, so it's returned untouched.
export function applyImpliedPermissions(permissions: string[]): string[] {
  if (permissions.includes(ALL_PERMISSIONS)) return [...permissions];
  const set = new Set(permissions);
  for (const group of PERMISSION_GROUPS) {
    const viewKey = group.permissions.find((p) => p.action === "View")?.key;
    if (!viewKey) continue;
    const hasNonView = group.permissions.some((p) => p.key !== viewKey && set.has(p.key));
    if (hasNonView) set.add(viewKey);
  }
  return [...set];
}

// No-escalation guard. Returns the permissions in `requested` that `actorPermissions`
// is NOT allowed to grant — empty means the grant is within the actor's authority.
// A "*" holder (the super-admin) may grant anything; everyone else can grant only
// permissions they themselves hold, and can never grant "*".
export function escalationViolations(
  requested: string[],
  actorPermissions: string[],
): string[] {
  const granted = new Set(actorPermissions);
  if (granted.has(ALL_PERMISSIONS)) return [];
  return requested.filter((p) => p === ALL_PERMISSIONS || !granted.has(p));
}

// Map of the pre-granular "coarse" permission keys to their per-action expansion.
// Used by the startup migration so roles created before granular RBAC keep working.
export const LEGACY_PERMISSION_EXPANSION: Record<string, string[]> = {
  "users.manage": ["users.view", "users.create", "users.edit", "users.delete"],
  "settings.manage": ["settings.view", "settings.manage"],
  "email_templates.manage": ["email_templates.view", "email_templates.manage"],
};
