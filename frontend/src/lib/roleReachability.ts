// Advisory reachability checks for the role editor.
//
// A few permission groups are only surfaced *inside* a host module's page — as a tab or a
// section — rather than having their own sidebar entry or landing. Granting one of them
// WITHOUT the host module's "View" leaves a role able to do the thing on paper but with no
// way to reach it in the UI (no nav link, no landing). That's almost always a mistake when
// configuring a role, so the editor surfaces a non-blocking "heads up".
//
// This is purely advisory UX: the backend still enforces every permission, and nothing is
// auto-granted here (unlike the customer sub-entities, which genuinely imply `customers.view`
// and are added server-side). We only *warn* — an admin may knowingly stage a partial role and
// grant the host module later.
//
// The map is frontend knowledge (it mirrors where each group is mounted in the nav/pages), so it
// lives here rather than in the backend permission catalog.

interface ReachabilityRule {
  group: string; // permission-key prefix, e.g. "warehouse_types" (matches "warehouse_types.*")
  label: string; // the group's display name
  hosts: string[]; // holding ANY of these makes the group reachable
  hostLabel: string; // where the group lives, for the message
}

// Each rule mirrors the actual UI mounting point:
//  - warehouse_types → Types tab inside the Warehouses module (sidebar: warehouse.view)
//  - supplier_types  → Types tab inside the Suppliers module (sidebar: suppliers.view)
//  - irm_types /      → Types & Categories tabs inside the Inventory Hub's IRM catalogue
//    irm_categories      (the Hub is gated on inventory.view)
//  - goods_management → Goods Management tab in a Warehouse's detail page, and the Inventory
//                        Hub's Damaged lens (reachable via warehouse.view or inventory.view)
const RULES: readonly ReachabilityRule[] = [
  // NOTE: customer stock categories (`categories.*`) are deliberately NOT listed. That master is a
  // tab in the Customers module like the others, but `categories.view` also opens the Customers nav
  // item and is a valid landing on its own (see Sidebar NAV + auth.ts DASHBOARD_SECTIONS), so a
  // categories-only role reaches its screen without needing customers.view. Warning about it would
  // be false advice.
  { group: "warehouse_types", label: "Warehouse Types", hosts: ["warehouse.view"], hostLabel: "Warehouses" },
  { group: "supplier_types", label: "Supplier Types", hosts: ["suppliers.view"], hostLabel: "Suppliers" },
  { group: "irm_types", label: "IRM Types", hosts: ["inventory.view"], hostLabel: "Warehouse Inventory" },
  { group: "irm_categories", label: "IRM Categories", hosts: ["inventory.view"], hostLabel: "Warehouse Inventory" },
  { group: "goods_management", label: "Goods Management", hosts: ["warehouse.view", "inventory.view"], hostLabel: "Warehouses" },
];

export interface ReachabilityWarning {
  /** The unreachable group's display name, e.g. "Goods Management". */
  label: string;
  /** The host module whose View unlocks it, e.g. "Warehouses". */
  hostLabel: string;
}

// Given a role's granted permission keys, return the groups that are granted but unreachable
// (no host View permission). "*" (full access) can reach everything, so it never warns.
export function reachabilityWarnings(permissions: string[]): ReachabilityWarning[] {
  if (permissions.includes("*")) return [];
  const held = new Set(permissions);
  // The set of group prefixes the role touches (key = "<group>.<action>").
  const grantedGroups = new Set(permissions.map((k) => k.split(".")[0]));

  const warnings: ReachabilityWarning[] = [];
  for (const rule of RULES) {
    if (!grantedGroups.has(rule.group)) continue; // group not granted → nothing to reach
    if (rule.hosts.some((h) => held.has(h))) continue; // a host is granted → reachable
    warnings.push({ label: rule.label, hostLabel: rule.hostLabel });
  }
  return warnings;
}
