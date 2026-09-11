import type { Principal } from "@/types/auth";

// ── Who may open the customer / project / site pickers ─────────────────────────────────────────
//
// A CLIENT MIRROR of the backend guard on GET /customers/options, /customers/:id/project-options and
// /jobs/site-options (backend permissions.ts — CUSTOMER_OPTION_READERS, JOB_SITE_SEARCH_READERS and
// CUSTOMER_OPTION_UNSCOPED_READERS). The server decides; this only lets a screen HIDE a filter it could
// never fill, instead of rendering one that is empty or that raises a permission toast.
//
// The rule that makes it more than a `can()` call: `reports.view` counts only for a user whose data is
// NOT warehouse-scoped. A warehouse-scoped user's reports are scoped to their own warehouses, while the
// customer and site lists are company-wide — so the Warehouse Manager's customer and site filters stay
// hidden rather than being widened.

type Can = (permission: string) => boolean;

const CUSTOMER_PICKER = ["customers.view", "jobs.view", "jobs.create", "jobs.edit"];
const SITE_SEARCH = ["jobs.view"];
const UNSCOPED_ONLY = ["reports.view"];

/** Is this principal a staff user whose role restricts them to their assigned warehouses? */
export const isWarehouseScoped = (principal: Principal | null): boolean =>
  principal?.type === "user" && principal.isWarehouseScoped === true;

const opens = (can: Can, scoped: boolean, anyOf: string[]): boolean =>
  anyOf.some(can) || (!scoped && UNSCOPED_ONLY.some(can));

/** May this user read the customer list, and a customer's projects (every filter and picker)? */
export const canPickCustomers = (can: Can, scoped: boolean): boolean => opens(can, scoped, CUSTOMER_PICKER);

/** May this user search sites across customers (the site type-ahead FILTER)? */
export const canSearchSites = (can: Can, scoped: boolean): boolean => opens(can, scoped, SITE_SEARCH);
