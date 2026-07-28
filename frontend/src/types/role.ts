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
  // Warehouse-scoped role → the user form shows the required "Assigned Warehouses" multi-select.
  isWarehouseScoped: boolean;
  // Field-operations role → its users may hold van stock, be assigned jobs and use the Engineer
  // Portal (web + mobile). Gates which permission groups the role editor offers.
  canHoldStock: boolean;
  createdAt: string;
}

// A capability a ROLE has or doesn't — a flag on the role, not a permission. Mirrors the backend
// RoleCapability union. "field_ops" = Role.canHoldStock (van stock, job assignment, Engineer Portal).
export type RoleCapability = "field_ops";

// What the role being edited is capable of, keyed by capability so a group's `capability` tag can
// index straight into it.
export interface RoleCapabilities {
  field_ops: boolean;
}

// One assignable permission — a single action within a module group.
export interface PermissionAction {
  key: string;
  action: string; // matrix column label, e.g. "Create"
  description: string;
  // Other catalog keys this action can't function without — ticking it also ticks these
  // (transitively). Declared by the backend catalog; see lib/permissionImplications.
  requires?: string[];
}

// A module group of related permissions (one row-block in the role-editor matrix).
export interface PermissionGroup {
  key: string;
  label: string;
  description: string;
  category: string; // section the group sits under in the matrix, e.g. "Customers"
  parent?: string; // module key of the parent group, for visual nesting (e.g. customer sub-entities)
  // A ROLE CAPABILITY this whole group requires — a property of the role itself, not a permission.
  // "field_ops" (Role.canHoldStock) tags the Engineer Portal: only a field role may hold it. The
  // editor hides an ungrantable group; the server strips it regardless of what the client sends.
  capability?: RoleCapability;
  // The group's base-access key — the permission every other action in the group depends on.
  // Absent → it's the action labelled "View". Sent by the backend catalog.
  baseKey?: string;
  permissions: PermissionAction[];
}
