/**
 * The page name shown in the top bar — the ONLY place a dashboard page states what it is.
 *
 * It used to be a five-entry map in Topbar.tsx against roughly twenty routes, so Jobs, Suppliers,
 * Warehouses, Purchase Orders, Purchase Requests, Inventory, Audit Log, Goods In and IRM all
 * announced themselves as "Dashboard". That went unnoticed because every list page ALSO rendered its
 * own title card underneath; removing that duplication is what made this the single source.
 *
 * Longest-prefix match, so a nested route inherits its section's name (/dashboard/jobs/new → Jobs)
 * while a deeper entry still wins where one exists (/dashboard/engineer/jobs → Jobs, not Dashboard).
 *
 * pageTitle.test.ts asserts every sidebar destination resolves to that item's own label, so adding a
 * nav entry without a title here fails the build rather than quietly reading "Dashboard" in
 * production.
 */

// Keyed by route prefix. Entries that mirror a sidebar item MUST match its label exactly (enforced
// by the test); the rest are pages reachable by deep link or from inside another module, which have
// no nav entry to inherit from.
const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",

  // Admin suite.
  "/dashboard/users": "Users & Roles",
  // Role create/edit are their own routes but belong to the Users & Roles module.
  "/dashboard/roles": "Users & Roles",
  "/dashboard/customers": "Customers",
  "/dashboard/jobs": "Jobs",
  "/dashboard/warehouses": "Warehouses",
  "/dashboard/suppliers": "Suppliers",
  "/dashboard/purchase-requests": "Purchase Requests",
  "/dashboard/purchase-orders": "Purchase Orders",
  "/dashboard/inventory": "Inventory",
  // Reached from Inventory rather than the rail, and a destination in its own right — not a form.
  // Without this it inherits "Inventory" from the prefix above and the page states its name nowhere:
  // its own heading card was the thing removed when page titles moved into the top bar.
  "/dashboard/inventory/history": "Stock movements",
  "/dashboard/settings": "Settings",
  "/dashboard/audit": "Audit Log",
  // No nav entry (the shortcut was removed) but still reachable by deep link and from a PO.
  "/dashboard/goods-in": "Goods In",
  // Reached from Inventory rather than the rail.
  "/dashboard/irm": "IRM Catalogue",
  // Same: rentals live in the Inventory Hub, so there is no nav entry for the guard above to catch —
  // without this the item pages inherit nothing and announce themselves as "Dashboard".
  "/dashboard/rentals": "Rental Catalogue",
  // A customer's stock-entry record, opened from the customer or warehouse it sits in.
  "/dashboard/stock-entries": "Stock Entry",

  // Customer portal.
  "/dashboard/portal": "Dashboard",
  "/dashboard/portal/jobs": "Jobs",
  "/dashboard/portal/projects": "Projects",
  "/dashboard/portal/sites": "Sites",
  "/dashboard/portal/requests": "Stock Submissions",
  "/dashboard/stock": "My Stock",
  "/dashboard/account": "Settings",

  // Engineer portal.
  "/dashboard/engineer": "Dashboard",
  "/dashboard/engineer/jobs": "Jobs",
  "/dashboard/engineer/inventory": "Stock",
  "/dashboard/engineer/transfers": "Transfers",
  "/dashboard/engineer/van-stock": "Field Stock",
};

/**
 * The title for a pathname. Unknown routes fall back to "Dashboard" — the same behaviour as before,
 * but now only reachable by a route with no entry at all rather than by most of the app.
 */
export function resolvePageTitle(pathname: string): string {
  // Strip a trailing slash so "/dashboard/jobs/" matches "/dashboard/jobs" rather than falling
  // through to the next-shortest prefix.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  let best = "";
  for (const prefix of Object.keys(TITLES)) {
    // A prefix only counts on a SEGMENT boundary: "/dashboard/stock" must not claim
    // "/dashboard/stock-entries".
    if (path !== prefix && !path.startsWith(`${prefix}/`)) continue;
    if (prefix.length > best.length) best = prefix;
  }

  return TITLES[best] ?? "Dashboard";
}
