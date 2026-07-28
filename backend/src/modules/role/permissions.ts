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

// A capability a ROLE either has or doesn't — a flag on the Role model, not a permission.
// Capabilities answer "what kind of role is this?", permissions answer "what may it do?".
//
//   field_ops → Role.canHoldStock — its users may hold van stock, be assigned jobs, and use the
//               Engineer Portal (web + mobile). Already enforced everywhere else in the system
//               (job assignment, van-stock requests, engineer transfers); tagging the Engineer
//               Portal permission group with it closes the last gap, where the portal keys could
//               be granted to a role that can never actually do field work.
export type RoleCapability = "field_ops";

// What a role is capable of, as the permission layer sees it. Built from the Role row.
export interface RoleCapabilities {
  field_ops: boolean;
}

// One assignable permission (a single action within a module group).
export interface PermissionAction {
  key: string; // e.g. "users.create"
  action: string; // column label in the matrix, e.g. "Create"
  description: string;
  // Other catalog keys this action can't function without. Granting it always grants these too
  // (transitively) — see PERMISSION_PREREQUISITES. Use it for a dependency the group's `baseKey`
  // doesn't already express, e.g. accepting a job needs the job LIST, not just the portal.
  requires?: string[];
}

// A module group of related permissions (one row-block in the matrix).
export interface PermissionGroup {
  key: string; // module key, e.g. "users"
  label: string; // display name, e.g. "Users"
  description: string;
  category: string; // display category, e.g. "Customers" — groups sections in the role-editor matrix
  parent?: string; // module key of the parent group, for visual nesting (e.g. customer sub-entities under "customers")
  // A ROLE CAPABILITY this whole group requires. Capabilities are properties of the role itself
  // (flags on the Role model), not permissions — so a group tagged here can only be granted to a
  // role that has the capability. Absent → grantable to any role.
  capability?: RoleCapability;
  // The group's BASE ACCESS key — the one permission every other action in the group depends on.
  // Defaults to the action labelled "View", which covers every CRUD-shaped module. Set it
  // explicitly when the group's entry point isn't called "View" (e.g. the Engineer Portal, whose
  // base is "Dashboard"), otherwise the group silently opts out of the implied-permission closure.
  baseKey?: string;
  permissions: PermissionAction[];
}

// Ordered list of the matrix categories. Drives section order in the role editor;
// any group whose `category` isn't in this list is bucketed under "General" at the end.
export const PERMISSION_CATEGORIES: string[] = [
  "Access & Security",
  "Customers",
  "Inventory",
  "Suppliers",
  "Procurement",
  "Goods Management",
  "Jobs",
  "Engineer Portal",
  "System",
];

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
    category: "Access & Security",
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
    category: "Access & Security",
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
    category: "System",
    permissions: [
      { key: "settings.view", action: "View", description: "View application settings." },
      { key: "settings.manage", action: "Manage", description: "Edit branding, email (SMTP) and integrations." },
    ],
  },
  {
    key: "email_templates",
    label: "Email templates",
    description: "The templates used for the emails the system sends.",
    category: "System",
    permissions: [
      { key: "email_templates.view", action: "View", description: "View email templates." },
      { key: "email_templates.manage", action: "Manage", description: "Edit, enable/disable and restore email templates." },
    ],
  },
  {
    key: "customers",
    label: "Customers",
    description:
      "The customer company record itself. Its projects, stock entries, sites, portal login and stock requests are governed by the separate groups below.",
    category: "Customers",
    permissions: [
      { key: "customers.view", action: "View", description: "View customers and their company details." },
      { key: "customers.create", action: "Create", description: "Add new customer companies (also provisions their read-only portal login)." },
      { key: "customers.edit", action: "Edit", description: "Edit a customer company's own profile — name, contact, status." },
      { key: "customers.delete", action: "Delete", description: "Remove customer companies." },
    ],
  },
  {
    key: "customer_projects",
    label: "Customer Projects",
    description: "The projects listed on a customer, managed from the customer's detail page.",
    category: "Customers",
    parent: "customers",
    permissions: [
      { key: "customer_projects.view", action: "View", description: "View a customer's projects." },
      { key: "customer_projects.create", action: "Create", description: "Add projects to a customer." },
      { key: "customer_projects.edit", action: "Edit", description: "Edit a customer's projects." },
      { key: "customer_projects.delete", action: "Delete", description: "Remove a customer's projects." },
    ],
  },
  {
    key: "customer_stock",
    label: "Customer Inventory",
    description: "The inventory (received items) for each customer across warehouses.",
    category: "Customers",
    parent: "customers",
    permissions: [
      { key: "customer_stock.view", action: "View", description: "View a customer's stock entries." },
      { key: "customer_stock.create", action: "Create", description: "Add stock entries for a customer." },
      { key: "customer_stock.edit", action: "Edit", description: "Edit a customer's stock entries." },
      { key: "customer_stock.delete", action: "Delete", description: "Remove a customer's stock entries." },
    ],
  },
  {
    key: "customer_sites",
    label: "Customer Sites",
    description: "The delivery / installation sites listed on each customer.",
    category: "Customers",
    parent: "customers",
    permissions: [
      { key: "customer_sites.view", action: "View", description: "View a customer's sites." },
      { key: "customer_sites.create", action: "Create", description: "Add sites to a customer." },
      { key: "customer_sites.edit", action: "Edit", description: "Edit a customer's sites." },
      { key: "customer_sites.delete", action: "Delete", description: "Remove a customer's sites." },
    ],
  },
  {
    key: "customer_portal",
    label: "Customer Portal Login",
    description: "The customer's read-only portal sign-in account.",
    category: "Customers",
    parent: "customers",
    permissions: [
      { key: "customer_portal.view", action: "View", description: "See a customer's portal login and whether it's active." },
      { key: "customer_portal.manage", action: "Manage", description: "Create, edit and deactivate a customer's portal login." },
      { key: "customer_portal.resend_invite", action: "Resend invite", description: "Re-send the portal invite with a fresh temporary password." },
      { key: "customer_portal.reset_password", action: "Reset password", description: "Email the customer a secure link to choose their own new password." },
    ],
  },
  {
    key: "stock_requests",
    label: "Customer Stock Submissions",
    description: "The review queue for stock a customer submits from their portal.",
    category: "Customers",
    parent: "customers",
    permissions: [
      { key: "stock_requests.view", action: "View", description: "View customer stock requests." },
      { key: "stock_requests.approve", action: "Approve", description: "Approve a customer's stock request." },
      { key: "stock_requests.reject", action: "Reject", description: "Reject a customer's stock request." },
      { key: "stock_requests.complete", action: "Complete", description: "Receive an approved request into the warehouse (posts the customer's stock)." },
    ],
  },
  {
    key: "categories",
    label: "Categories",
    description: "The global stock-category master list used to tag stock entries and IRM items.",
    category: "Inventory",
    permissions: [
      { key: "categories.view", action: "View", description: "View stock categories." },
      { key: "categories.create", action: "Create", description: "Add new stock categories." },
      { key: "categories.edit", action: "Edit", description: "Edit stock categories." },
      { key: "categories.delete", action: "Delete", description: "Delete stock categories." },
    ],
  },
  {
    key: "warehouse",
    label: "Warehouses",
    description: "Physical stock-location master data that future inventory modules build on.",
    category: "Inventory",
    permissions: [
      { key: "warehouse.view", action: "View", description: "View warehouses and their details." },
      { key: "warehouse.create", action: "Create", description: "Add new warehouses." },
      { key: "warehouse.edit", action: "Edit", description: "Edit warehouses; assign a manager; activate / deactivate." },
      { key: "warehouse.delete", action: "Delete", description: "Remove warehouses (only when no stock or open movements exist)." },
    ],
  },
  {
    key: "warehouse_types",
    label: "Warehouse Types",
    description: "The operational classification master list used to categorise warehouses.",
    category: "Inventory",
    permissions: [
      { key: "warehouse_types.view", action: "View", description: "View warehouse types." },
      { key: "warehouse_types.create", action: "Create", description: "Add new warehouse types." },
      { key: "warehouse_types.edit", action: "Edit", description: "Edit warehouse types." },
      { key: "warehouse_types.delete", action: "Delete", description: "Delete warehouse types." },
    ],
  },
  {
    key: "irm",
    label: "IRM Catalogue",
    description: "Company-owned internal stock/material items — the master data future procurement & inventory modules reference.",
    category: "Inventory",
    permissions: [
      { key: "irm.view", action: "View", description: "View IRM catalogue items and their details." },
      { key: "irm.create", action: "Create", description: "Add new IRM items." },
      { key: "irm.edit", action: "Edit", description: "Edit IRM items; assign suppliers/owner; activate / deactivate." },
      { key: "irm.delete", action: "Delete", description: "Remove IRM items (only when no dependencies exist)." },
      { key: "irm.barcode.manage", action: "Barcode", description: "Generate, regenerate and print IRM item barcodes." },
    ],
  },
  {
    key: "irm_types",
    label: "IRM Types",
    description: "The item-type master list used to classify IRM items (Consumable, Asset, Tool…).",
    category: "Inventory",
    permissions: [
      { key: "irm_types.view", action: "View", description: "View IRM types." },
      { key: "irm_types.create", action: "Create", description: "Add new IRM types." },
      { key: "irm_types.edit", action: "Edit", description: "Edit IRM types." },
      { key: "irm_types.delete", action: "Delete", description: "Delete IRM types." },
    ],
  },
  {
    key: "irm_categories",
    label: "IRM Categories",
    description: "The company-domain category master used to classify IRM items (separate from customer categories).",
    category: "Inventory",
    permissions: [
      { key: "irm_categories.view", action: "View", description: "View IRM categories." },
      { key: "irm_categories.create", action: "Create", description: "Add new IRM categories." },
      { key: "irm_categories.edit", action: "Edit", description: "Edit IRM categories." },
      { key: "irm_categories.delete", action: "Delete", description: "Delete IRM categories." },
    ],
  },
  {
    key: "purchase_requests",
    label: "Purchase Requests (PRF)",
    description: "The pre-PO procurement document — capture the supplier quotation, route it through Finance review and convert it into a purchase order.",
    category: "Procurement",
    permissions: [
      { key: "purchase_requests.view", action: "View", description: "View purchase requests and their details." },
      { key: "purchase_requests.create", action: "Create", description: "Create draft purchase requests (incl. duplicating a converted one as a revision)." },
      { key: "purchase_requests.edit", action: "Edit", description: "Edit draft purchase requests + manage attachments." },
      { key: "purchase_requests.delete", action: "Delete", description: "Delete draft purchase requests." },
      { key: "purchase_requests.submit", action: "Submit", description: "Submit a draft for finance review." },
      { key: "purchase_requests.approve", action: "Approve", description: "Finance review — approve, reject or reopen a purchase request." },
      { key: "purchase_requests.convert", action: "Convert", description: "Generate the purchase order from a finance-approved request." },
      { key: "purchase_requests.cancel", action: "Cancel", description: "Cancel a purchase request before it is converted." },
    ],
  },
  {
    key: "purchase_orders",
    label: "Purchase Orders",
    description: "The procurement workflow — raise, approve, send and track orders to suppliers.",
    category: "Procurement",
    permissions: [
      { key: "purchase_orders.view", action: "View", description: "View purchase orders and their details." },
      { key: "purchase_orders.create", action: "Create", description: "Create draft purchase orders." },
      { key: "purchase_orders.edit", action: "Edit", description: "Edit draft purchase orders + manage attachments." },
      { key: "purchase_orders.delete", action: "Delete", description: "Delete draft purchase orders." },
      { key: "purchase_orders.submit", action: "Submit", description: "Submit a draft for approval." },
      { key: "purchase_orders.approve", action: "Approve", description: "Approve or reject a submitted purchase order (incl. the PRF fast-path)." },
      { key: "purchase_orders.assign_pm", action: "Assign PM", description: "Route an approved purchase order to a project manager for review + send." },
      { key: "purchase_orders.send", action: "Send", description: "Issue an approved purchase order to the supplier." },
      { key: "purchase_orders.acknowledge", action: "Record acceptance", description: "Record the supplier's acceptance and confirmed delivery date on an issued order." },
      { key: "purchase_orders.cancel", action: "Cancel", description: "Cancel a purchase order before it is received." },
      { key: "purchase_orders.close", action: "Close", description: "Close a received purchase order." },
    ],
  },
  {
    key: "goods_in",
    label: "GRN (Goods Receipt Note)",
    description: "Receiving goods against purchase orders (GRN) — records receipts, serials/batches and increases stock.",
    category: "Inventory",
    permissions: [
      { key: "goods_in.view", action: "View", description: "View goods receipts and their details." },
      { key: "goods_in.create", action: "Create", description: "Create draft goods receipts." },
      { key: "goods_in.edit", action: "Edit", description: "Edit draft goods receipts + manage attachments." },
      { key: "goods_in.delete", action: "Delete", description: "Delete draft goods receipts." },
      { key: "goods_in.complete", action: "Complete", description: "Complete a receipt — posts stock and updates the purchase order." },
      { key: "goods_in.cancel", action: "Cancel", description: "Cancel a draft goods receipt." },
    ],
  },
  {
    key: "inventory",
    label: "Warehouse Inventory",
    description: "Live stock levels, movement + purchase history, and warehouse-to-warehouse transfers.",
    category: "Inventory",
    permissions: [
      { key: "inventory.view", action: "View", description: "View live inventory, balances and movement/purchase history." },
      { key: "inventory.move", action: "Move", description: "Transfer stock between warehouses." },
      { key: "inventory.history", action: "History", description: "View the stock-transfer movement history." },
      { key: "inventory.export", action: "Export", description: "Export the inventory list to CSV." },
      { key: "inventory.adjust", action: "Adjust", description: "Manually add existing/opening stock straight into a warehouse." },
      { key: "inventory.stock_take", action: "Stock take", description: "Run a stock take (reserved for the future Stock Take module)." },
    ],
  },
  {
    key: "goods_management",
    label: "Goods Management",
    description: "Job-scoped scan flow — issue kit stock to an engineer, receive returns (good/damaged), and reconcile a job's stock.",
    category: "Goods Management",
    permissions: [
      { key: "goods_management.view", action: "View", description: "View the goods-management queue and a job's stock movements." },
      { key: "goods_management.issue", action: "Issue", description: "Scan stock out to an engineer for a job." },
      { key: "goods_management.receive_return", action: "Receive return", description: "Scan returned stock in (good/damaged) for a job." },
      { key: "goods_management.reconcile", action: "Reconcile", description: "Close & reconcile a job's stock and write off unaccounted (lost) units." },
    ],
  },
  {
    key: "van_stock_request",
    label: "Field Stock Requests",
    description: "Non-job engineer restock/return requests — review, approve/decline, and fulfil by scan (per-warehouse tab).",
    category: "Goods Management",
    permissions: [
      { key: "van_stock_request.review", action: "Review & fulfil", description: "See the warehouse's field-stock queue, approve/decline restocks, scan-fulfil restocks and returns, close short, and create walk-in requests." },
    ],
  },
  {
    key: "jobs",
    label: "Jobs",
    description: "Field jobs — created for a customer/project, assigned to engineers and tracked through to completion.",
    category: "Jobs",
    permissions: [
      { key: "jobs.view", action: "View", description: "View jobs and their details." },
      { key: "jobs.create", action: "Create", description: "Create new jobs (job packs) and assign an engineer." },
      { key: "jobs.edit", action: "Edit", description: "Edit a job's details and kit list." },
      { key: "jobs.assign", action: "Assign", description: "Assign or reassign a job to an engineer." },
      { key: "jobs.cancel", action: "Cancel", description: "Cancel a job." },
      { key: "jobs.delete", action: "Delete", description: "Delete a draft job." },
      { key: "jobs.kit_request.review", action: "Review kit requests", description: "Review a field engineer's additional-kit requests — approve (growing the kit + opening fulfilment) or decline." },
    ],
  },
  {
    key: "engineer",
    label: "Engineer Portal",
    description:
      "The field engineer's read-only self-service portal — their own held IRM stock, dispatches received, recent activity and profile.",
    category: "Engineer Portal",
    // FIELD ROLES ONLY. The portal exists to run field work — hold van stock, take assigned jobs,
    // restock, transfer. A role without the field-operations capability can hold none of that
    // (job assignment, van-stock and transfers all reject it), so granting these keys to e.g. a
    // helpdesk role produced access that could never do anything. Enforced on the ROLE-WRITE path
    // (createRole/updateRole) and by the startup repair — request authorization itself still reads
    // the role's stored permissions, which this keeps honest.
    capability: "field_ops",
    // Base access is the PORTAL ITSELF, not an action labelled "View". Each portal route is guarded
    // on its own key (EngineerGuard takes a `perm` prop), but the whole engineer nav block is hidden
    // unless `engineer.dashboard.view` is held (frontend Sidebar) and the mobile app refuses to open
    // without it — so a grant without the base is reachable only by typing a URL. Declaring the base
    // explicitly is what opts this group INTO the implied-permission closure; before it existed the
    // whole group was skipped by the `action === "View"` lookup and a role could be saved holding,
    // say, `engineer.jobs.accept` with no portal to open and no job list to open it from.
    baseKey: "engineer.dashboard.view",
    permissions: [
      { key: "engineer.dashboard.view", action: "Dashboard", description: "Access the engineer portal — own stock summary, dispatches received and recent activity." },
      { key: "engineer.inventory.view", action: "Inventory", description: "View own held IRM stock." },
      { key: "engineer.jobs.view", action: "Jobs", description: "View jobs assigned to them and a job's details." },
      // Every per-job action is driven from the job list / job detail screen, so each one needs
      // `engineer.jobs.view` on top of the portal base (which it pulls in transitively).
      { key: "engineer.jobs.accept", action: "Accept job", description: "Accept a job assigned to them.", requires: ["engineer.jobs.view"] },
      { key: "engineer.jobs.reject", action: "Reject job", description: "Decline a job assigned to them (with a reason).", requires: ["engineer.jobs.view"] },
      { key: "engineer.jobs.start", action: "Start job", description: "Mark an accepted job in-progress (start work on site).", requires: ["engineer.jobs.view"] },
      { key: "engineer.jobs.complete", action: "Complete job", description: "Mark a job completed, declaring used quantities + a work summary.", requires: ["engineer.jobs.view"] },
      { key: "engineer.jobs.request_kit", action: "Request kit", description: "Request additional kit for an assigned job (extra or new items) for the planner to review.", requires: ["engineer.jobs.view"] },
      // RESERVED (not yet enforced by any route): self-profile editing currently flows through the
      // shared `/users/me` endpoints, which only require authentication — no engineer-specific
      // permission is checked. This key is registered + seeded ahead of a future engineer-only
      // settings/signature endpoint; wire it into that route's requirePermission(...) when it ships.
      { key: "engineer.settings.edit", action: "Settings", description: "Manage own profile + signature from the engineer portal. (Reserved — no endpoint enforces this yet.)" },
      { key: "engineer.transfer", action: "Transfer", description: "Request/approve engineer-to-engineer stock transfers." },
      { key: "engineer.van_stock.request", action: "Field stock", description: "Request field-stock restock from a warehouse or return excess stock — non-job. Cancel own pending requests." },
    ],
  },
  {
    key: "engineer_stock",
    label: "Engineer Stock Transfers",
    description: "Admin-side oversight and management of engineer-to-engineer stock transfers.",
    category: "Inventory",
    permissions: [
      { key: "engineer_stock.view", action: "View", description: "View the admin transfer board and all engineer transfer requests." },
      { key: "engineer_stock.transfer", action: "Transfer", description: "Admin create, override-approve, decline or cancel any pending engineer transfer request." },
    ],
  },
  {
    key: "suppliers",
    label: "Suppliers",
    description: "Supplier master data — the organisations inventory is procured from.",
    category: "Suppliers",
    permissions: [
      { key: "suppliers.view", action: "View", description: "View suppliers and their details." },
      { key: "suppliers.create", action: "Create", description: "Add new suppliers." },
      { key: "suppliers.edit", action: "Edit", description: "Edit suppliers; assign an owner; activate / deactivate." },
      { key: "suppliers.delete", action: "Delete", description: "Remove suppliers (only when no dependencies exist)." },
    ],
  },
  {
    key: "supplier_types",
    label: "Supplier Types",
    description: "The classification master list used to categorise suppliers.",
    category: "Suppliers",
    permissions: [
      { key: "supplier_types.view", action: "View", description: "View supplier types." },
      { key: "supplier_types.create", action: "Create", description: "Add new supplier types." },
      { key: "supplier_types.edit", action: "Edit", description: "Edit supplier types." },
      { key: "supplier_types.delete", action: "Delete", description: "Delete supplier types." },
    ],
  },
  {
    key: "audit",
    label: "Audit log",
    description: "The system audit trail.",
    category: "System",
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

// --- Permission dependencies -------------------------------------------------------------------
//
// A permission is only useful if everything it depends on is held too. Those dependencies are
// declared IN THE CATALOG (a group's `baseKey`, an action's `requires`) rather than inferred from
// naming, so a group whose entry point isn't spelled "View" can't silently opt out. The role editor
// derives its behaviour from the same declarations it fetches from this catalog, so these rules are
// written once, here. (The client still hand-copies ONE rule the catalog can't express — the
// customers.view cross-group implication, which depends on the role's own warehouse-scope flag
// rather than on a permission. See frontend lib/permissionImplications.ts.)

// The group's base-access key: an explicit `baseKey`, else the action labelled "View".
export function baseKeyOf(group: PermissionGroup): string | undefined {
  return group.baseKey ?? group.permissions.find((p) => p.action === "View")?.key;
}

// key → the keys it can't function without (direct edges only; use closePrerequisites for the
// transitive set). Built from both sources: every non-base action depends on its group's base,
// plus whatever the action declares in `requires`.
export const PERMISSION_PREREQUISITES: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const group of PERMISSION_GROUPS) {
    const base = baseKeyOf(group);
    for (const permission of group.permissions) {
      const edges = new Set(permission.requires ?? []);
      if (base && permission.key !== base) edges.add(base);
      edges.delete(permission.key); // a permission never depends on itself
      if (edges.size > 0) map.set(permission.key, [...edges]);
    }
  }
  return map;
})();

// Expand a permission set to include every prerequisite, transitively. Only ever ADDS, is
// idempotent, and terminates even if the catalog ever declared a dependency cycle (a key is
// queued only the first time it's added).
export function closePrerequisites(keys: Iterable<string>): string[] {
  const set = new Set(keys);
  const queue = [...set];
  while (queue.length > 0) {
    for (const dependency of PERMISSION_PREREQUISITES.get(queue.pop()!) ?? []) {
      if (set.has(dependency)) continue;
      set.add(dependency);
      queue.push(dependency);
    }
  }
  return [...set];
}

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

// --- Role capabilities -------------------------------------------------------------------------

// key → the capability its group requires (only keys in a tagged group appear here).
export const PERMISSION_CAPABILITY: ReadonlyMap<string, RoleCapability> = (() => {
  const map = new Map<string, RoleCapability>();
  for (const group of PERMISSION_GROUPS) {
    if (!group.capability) continue;
    for (const permission of group.permissions) map.set(permission.key, group.capability);
  }
  return map;
})();

// NOTE: the catalog endpoint deliberately returns EVERY group, including capability-tagged ones,
// and each group carries its `capability` tag. The role editor filters client-side against the
// role being edited — it has to, because the "create role" page has no saved role to filter
// against yet and the capability toggle flips live. This function is the authority regardless:
// whatever the client sends is filtered here before it is stored.

// Split a permission set into what this role may actually hold and what it may not.
//
// STRIP, don't reject. Removing a permission a role can never use is a privilege REDUCTION, so it
// is always safe and it self-heals data written before the capability existed. Rejecting would be
// worse than useless: a legacy role holding an ungrantable key could never be saved again — an
// admin trying to fix it would be refused on every attempt, including the attempt to remove it.
// (The opposite direction — silently ADDING permissions during a migration — is not safe, which is
// why nothing here ever grants.) "*" is the super-admin wildcard and is left untouched.
export function splitByCapability(
  permissions: string[],
  capabilities: RoleCapabilities,
): { kept: string[]; removed: string[] } {
  if (permissions.includes(ALL_PERMISSIONS)) return { kept: [...permissions], removed: [] };
  const kept: string[] = [];
  const removed: string[] = [];
  for (const key of permissions) {
    const required = PERMISSION_CAPABILITY.get(key);
    if (required && !capabilities[required]) removed.push(key);
    else kept.push(key);
  }
  return { kept, removed };
}

// The warehouse manager's slice of the customer-consignment flow. A customer's own stock is
// shipped to one of our warehouses; the warehouse manager RECEIVES it and prepares it for
// storage. That whole warehouse-side flow — see the pending stock in Incoming stock → Customer
// and the received stock in Inventory → Customer, receive an assignment, then fill in the
// entry's details, read the category master for its picker and print its barcode — is covered by
// exactly these two keys:
//   • stock_requests.view     — surfaces the customer pool at the warehouse (pending + received)
//   • stock_requests.complete — performs the receive, and authorises editing the entry,
//                               generating its barcode, and reading the category list
// Deliberately NOT stock_requests.approve / .reject — that is the office review queue, a
// PM/reviewer's job, done from the customer record, not the warehouse. Deliberately NOT the
// broad customer_stock.* keys — every /stock-entries route accepts stock_requests.* as an
// alternative, so the manager never needs the customer-inventory management keys. Every action
// stays scoped to the manager's assigned warehouses by the warehouse-access layer. Seeded onto
// the warehouse_manager role and backfilled idempotently in db/seed.ts.
export const WAREHOUSE_CUSTOMER_STOCK_PERMISSIONS = [
  "stock_requests.view",
  "stock_requests.complete",
];

// The customer sub-entity groups. Each is a slice of a single customer record, so
// holding ANY permission in one of them implies being able to see the parent
// customer (`customers.view`) — you can't manage a customer's projects, stock,
// sites, portal login or stock requests without first seeing the customer.
export const CUSTOMER_CHILD_GROUPS = new Set([
  "customer_projects",
  "customer_stock",
  "customer_sites",
  "customer_portal",
  "stock_requests",
]);

// The customer-child groups whose endpoints work WAREHOUSE-SIDE — i.e. usable without the global
// `customers.view` directory. Only `stock_requests` (the warehouse receive flow: incoming customer
// pool, receive, fill the entry, print the barcode) qualifies today. A warehouse-scoped role may
// hold these standalone, so they don't pull in `customers.view`. EVERY other customer-child group
// (projects / sites / portal / customer_stock) is customer-detail-page only and stays coupled to
// `customers.view` even for a scoped role — otherwise the grant would be a dead permission (the
// customer page is unreachable without the view). If a future group gains a warehouse-side surface,
// add it here.
export const WAREHOUSE_SIDE_CUSTOMER_CHILD_GROUPS = new Set(["stock_requests"]);

// Close a permission set over everything it DEPENDS ON: each granted action pulls in its group's
// base access and any explicit `requires`, transitively (see PERMISSION_PREREQUISITES). For a
// conventional CRUD module that is exactly the old "manage implies view" rule — you can't act on
// what you can't see — but it is no longer limited to an action named "View", so a group whose
// entry point is called something else (the Engineer Portal's is "Dashboard") is covered too.
// Keeps roles coherent on the server no matter how they were submitted, so an
// action-without-its-prerequisite role can't be created via the API. It also adds the cross-group
// implication above: any customer sub-entity grant pulls in `customers.view`. "*" already implies
// everything, so it's returned untouched.
//
// `isWarehouseScoped` (the role's own flag) narrows the customer cross-group add: a warehouse
// manager holds stock_requests.* to receive customer stock at their assigned warehouse, and
// `customers.view` is the GLOBAL, un-warehouse-scoped customer directory — forcing it on would
// silently widen a scoped role to the entire customer book. So for a scoped role only the
// warehouse-side groups (WAREHOUSE_SIDE_CUSTOMER_CHILD_GROUPS) are exempt from pulling in
// customers.view. Every OTHER customer-child group is customer-page-only and STILL pulls it in even
// for a scoped role — otherwise the grant would be a dead permission (unreachable without the view).
// The intra-group prerequisite closure always applies (they keep e.g. stock_requests.view). This
// function only ever ADDS, so an admin who deliberately grants `customers.view` still keeps it.
export function applyImpliedPermissions(permissions: string[], isWarehouseScoped = false): string[] {
  if (permissions.includes(ALL_PERMISSIONS)) return [...permissions];
  const set = new Set(closePrerequisites(permissions));
  // Cross-group: any customer sub-entity permission implies seeing the customer — except that a
  // warehouse-scoped role is exempted for the warehouse-side groups (see the constant above).
  const needsCustomerView = [...set].some((key) => {
    const group = key.split(".")[0];
    if (!CUSTOMER_CHILD_GROUPS.has(group)) return false;
    if (isWarehouseScoped && WAREHOUSE_SIDE_CUSTOMER_CHILD_GROUPS.has(group)) return false;
    return true;
  });
  if (!needsCustomerView) return [...set];
  set.add("customers.view");
  // Re-close so anything customers.view itself depends on comes along (nothing today, but this
  // keeps the rule composable if the customers group ever gains a base of its own).
  return closePrerequisites(set);
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

// Additive backward-compat for the customer RBAC split. The customer module used to
// gate its projects, stock, sites, portal login and stock requests entirely under
// the coarse `customers.view` / `customers.edit` keys; those entities now have their
// own granular groups. To preserve every role's EXACT effective access, a role that
// held a coarse key gains the matching child keys (it never loses `customers.*` — that
// key now governs the company record only). Unlike LEGACY_PERMISSION_EXPANSION this is
// purely additive (the source key is kept). Applied once at startup over every role in
// db/seed.ts; idempotent. NOTE: stock_requests.complete is granted here because a
// `customers.edit` holder would have had that capability under the old coarse model
// (its warehouse-receive route is now live).
export const CUSTOMER_COMPAT_BACKFILL: Record<string, string[]> = {
  "customers.view": [
    "customer_projects.view",
    "customer_stock.view",
    "customer_sites.view",
    "customer_portal.view",
    "stock_requests.view",
  ],
  "customers.edit": [
    "customer_projects.view", "customer_projects.create", "customer_projects.edit", "customer_projects.delete",
    "customer_stock.view", "customer_stock.create", "customer_stock.edit", "customer_stock.delete",
    "customer_sites.view", "customer_sites.create", "customer_sites.edit", "customer_sites.delete",
    "customer_portal.view", "customer_portal.manage", "customer_portal.resend_invite", "customer_portal.reset_password",
    "stock_requests.view", "stock_requests.approve", "stock_requests.reject", "stock_requests.complete",
  ],
};

// Compute the additive customer-compat keys a role's permission set is missing.
// "*" roles (super-admin) grant everything already, so they need nothing. Idempotent:
// returns only keys not already held, so re-running the migration is a no-op.
export function customerCompatAdditions(permissions: string[]): string[] {
  if (permissions.includes(ALL_PERMISSIONS)) return [];
  const have = new Set(permissions);
  const additions = new Set<string>();
  for (const held of permissions) {
    for (const key of CUSTOMER_COMPAT_BACKFILL[held] ?? []) {
      if (!have.has(key)) additions.add(key);
    }
  }
  return [...additions];
}
