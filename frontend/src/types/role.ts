// A role as returned by the backend. `userCount` is how many active users hold
// it (used to guard deletion). `permissions` are the delegatable permission keys
// the role grants ("*" = full access).
export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
  sortOrder: number;
}

// One assignable permission — a single action within a module group.
export interface PermissionAction {
  key: string;
  action: string; // matrix column label, e.g. "Create"
  description: string;
}

// A module group of related permissions (one row-block in the role-editor matrix).
export interface PermissionGroup {
  key: string;
  label: string;
  description: string;
  permissions: PermissionAction[];
}
