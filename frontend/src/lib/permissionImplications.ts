import type { PermissionGroup } from "@/types/role";

// Client-side mirror of the backend's applyImpliedPermissions (backend permissions.ts), so the
// role-editor matrix always shows exactly what the server will store. Kept in a pure module so it
// is unit-testable without rendering the form.

// The "view" action's key for a group (e.g. "users.view"), if it has one.
const viewKeyOf = (group: PermissionGroup): string | undefined =>
  group.permissions.find((p) => p.action === "View")?.key;

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

// Coerce a permission set to its implied closure: any non-view action implies its group's "View",
// and any customer sub-entity grant implies customers.view.
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
  const set = new Set(perms);
  for (const group of groups) {
    const viewKey = viewKeyOf(group);
    if (!viewKey) continue;
    if (group.permissions.some((p) => p.key !== viewKey && set.has(p.key))) set.add(viewKey);
  }
  const needsCustomerView = [...set].some((k) => {
    const group = k.split(".")[0];
    if (!CUSTOMER_CHILD_GROUPS.has(group)) return false;
    if (isWarehouseScoped && WAREHOUSE_SIDE_CUSTOMER_CHILD_GROUPS.has(group)) return false;
    return true;
  });
  if (needsCustomerView) set.add("customers.view");
  return [...set];
};
