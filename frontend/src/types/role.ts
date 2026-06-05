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

// One entry in the permission catalog (for the role editor).
export interface PermissionDef {
  key: string;
  group: string;
  label: string;
  description: string;
}
