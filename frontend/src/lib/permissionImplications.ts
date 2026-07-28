import type { PermissionGroup, RoleCapabilities } from "@/types/role";

// Client-side mirror of the backend's permission-dependency engine (backend permissions.ts), so
// the role-editor matrix always shows exactly what the server will store. Kept in a pure module so
// it is unit-testable without rendering the form.
//
// IMPORTANT — what is mirrored and what isn't. The dependency RULES are not copied here: they are
// declared in the backend catalog (a group's `baseKey`, an action's `requires`) and arrive with the
// catalog the editor fetches, so this module derives them from `groups` at runtime. Only the
// ALGORITHM is duplicated. The one genuine copy is the customer cross-group rule below, which
// depends on the role's own warehouse-scope flag and so can't live on a permission.

// Full-access wildcard. Both closures short-circuit on it exactly as the backend does — a set
// containing "*" already grants everything, so neither adding prerequisites nor stripping
// capability-gated keys is meaningful, and stripping would be a privilege reduction the server
// would never make. The role editor short-circuits full-access roles before it gets here, so this
// is belt-and-braces; it exists so the mirror can't diverge from the backend on a mixed set.
const ALL_ACCESS = "*";

// The "view" action's key for a group (e.g. "users.view"), if it has one.
const viewKeyOf = (group: PermissionGroup): string | undefined =>
  group.permissions.find((p) => p.action === "View")?.key;

// The group's base-access key: an explicit `baseKey` from the catalog, else the action labelled
// "View". Mirrors backend baseKeyOf. A group whose entry point isn't spelled "View" (the Engineer
// Portal, whose base is "Dashboard") relies on the explicit field.
export const baseKeyOf = (group: PermissionGroup): string | undefined =>
  group.baseKey ?? viewKeyOf(group);

// Every permission key in a group.
export const keysOf = (group: PermissionGroup): string[] => group.permissions.map((p) => p.key);

// The customer sub-entity groups — mirrors the backend CUSTOMER_CHILD_GROUPS. Holding any
// permission in one of these implies customers.view (you can't manage a customer's projects,
// catalogue, sites, portal login or stock requests without seeing the customer).
const CUSTOMER_CHILD_GROUPS = new Set([
  "customer_projects",
  "customer_stock",
  "customer_sites",
  "customer_portal",
  "stock_requests",
]);

// Mirrors the backend WAREHOUSE_SIDE_CUSTOMER_CHILD_GROUPS: the customer-child groups usable
// warehouse-side without the global customers.view. Only stock_requests (the receive flow) today.
const WAREHOUSE_SIDE_CUSTOMER_CHILD_GROUPS = new Set(["stock_requests"]);

// key → the keys it can't function without (direct edges). Mirrors backend
// PERMISSION_PREREQUISITES, built from the same two catalog sources: every non-base action depends
// on its group's base key, plus whatever the action declares in `requires`.
export function prerequisiteMap(groups: PermissionGroup[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const group of groups) {
    const base = baseKeyOf(group);
    for (const permission of group.permissions) {
      const edges = new Set(permission.requires ?? []);
      if (base && permission.key !== base) edges.add(base);
      edges.delete(permission.key);
      if (edges.size > 0) map.set(permission.key, [...edges]);
    }
  }
  return map;
}

// The inverse graph: key → the keys that depend on it. Used to cascade a removal — un-ticking a
// prerequisite must take everything that needs it with it, or the matrix would leave behind
// exactly the orphaned grants this model exists to prevent.
function dependentMap(groups: PermissionGroup[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [key, dependencies] of prerequisiteMap(groups)) {
    for (const dependency of dependencies) {
      const list = map.get(dependency) ?? [];
      list.push(key);
      map.set(dependency, list);
    }
  }
  return map;
}

// Walk a dependency graph from `seeds`, collecting everything reachable. Terminates on cycles
// (a node is queued only the first time it is reached).
function reachable(seeds: string[], graph: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    for (const next of graph.get(queue.pop()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

// Coerce a permission set to its implied closure: every granted action pulls in whatever it
// depends on (its group's base access, plus any explicit `requires`), transitively, and any
// customer sub-entity grant implies customers.view.
//
// `isWarehouseScoped` mirrors the backend flag: a warehouse-scoped role (Warehouse Manager) is NOT
// forced the global customers.view for holding a WAREHOUSE-SIDE customer-child group (stock_requests)
// — the receive flow works without the directory, so it stays a deliberate choice. Every other
// customer-child group (projects / sites / portal / customer_stock) is customer-page-only and still
// pulls in customers.view even for a scoped role, so it never becomes a dead permission. An
// explicitly ticked customers.view is already in the set and is preserved.
export const applyImplied = (
  perms: string[],
  groups: PermissionGroup[],
  isWarehouseScoped = false,
): string[] => {
  if (perms.includes(ALL_ACCESS)) return [...perms];
  const prerequisites = prerequisiteMap(groups);
  const set = new Set([...perms, ...reachable(perms, prerequisites)]);
  const needsCustomerView = [...set].some((k) => {
    const group = k.split(".")[0];
    if (!CUSTOMER_CHILD_GROUPS.has(group)) return false;
    if (isWarehouseScoped && WAREHOUSE_SIDE_CUSTOMER_CHILD_GROUPS.has(group)) return false;
    return true;
  });
  if (!needsCustomerView) return [...set];
  set.add("customers.view");
  for (const key of reachable(["customers.view"], prerequisites)) set.add(key);
  return [...set];
};

// --- Role capabilities -------------------------------------------------------------------------
//
// A capability is a property of the ROLE (a flag on the row), not a permission. A group tagged with
// one can only be held by a role that has it — today that's the Engineer Portal, which requires
// `field_ops` (Role.canHoldStock), because every engineer feature downstream (job assignment, van
// stock, transfers) already refuses a role that can't hold field stock.
//
// These two helpers are COSMETIC — they keep the editor from offering or keeping something the
// role can't use. The server strips it regardless of what the client sends.

// The groups a role with these capabilities may be granted.
export function grantableGroups(
  groups: PermissionGroup[],
  capabilities: RoleCapabilities,
): PermissionGroup[] {
  return groups.filter((g) => !g.capability || capabilities[g.capability]);
}

// Drop any granted key whose group needs a capability the role lacks. Mirrors the backend
// splitByCapability: it only ever REMOVES, so it can't widen a role by accident.
export function stripUngrantable(
  perms: string[],
  groups: PermissionGroup[],
  capabilities: RoleCapabilities,
): string[] {
  if (perms.includes(ALL_ACCESS)) return perms;
  const ungrantable = new Set(
    groups.filter((g) => g.capability && !capabilities[g.capability]).flatMap(keysOf),
  );
  return ungrantable.size === 0 ? perms : perms.filter((k) => !ungrantable.has(k));
}

// Tick `keys` on, bringing along everything they depend on.
export function grantWithPrerequisites(
  perms: string[],
  groups: PermissionGroup[],
  keys: string[],
): string[] {
  const set = new Set([...perms, ...keys]);
  for (const key of reachable(keys, prerequisiteMap(groups))) set.add(key);
  return [...set];
}

// Tick `keys` off, taking everything that depends on them with it — so un-ticking a module's base
// access clears the module, and un-ticking a mid-level prerequisite (e.g. the engineer's job list)
// clears just the actions that needed it.
export function revokeWithDependents(
  perms: string[],
  groups: PermissionGroup[],
  keys: string[],
): string[] {
  const doomed = new Set([...keys, ...reachable(keys, dependentMap(groups))]);
  return perms.filter((key) => !doomed.has(key));
}
