import type { Request } from "express";

import * as customerService from "./customer.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendCsv } from "../../utils/csv-response.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import { unauthorized } from "../../utils/http-error.js";
import type {
  AdminStockRequestInput,
  BulkSiteInput,
  CreateCustomerInput,
  CustomerStockTransferInput,
  CustomerUserInput,
  ProjectInput,
  SiteInput,
  StockRequestInput,
  StockRequestEditInput,
  StockRequestAssignInput,
  StockAssignmentReceiveInput,
  StockAssignmentCloseShortInput,
  StockEntryUpdateInput,
  StockReviewInput,
  UpdateCustomerInput,
} from "./customer.validation.js";

// ============================================================================
// Admin / PM surface (guarded by customers.* permissions)
// ============================================================================

// GET /customers  — paginated. Query: ?search=&status=&sort=&page=&pageSize=
// The list's filters, parsed once. Shared with the CSV export so the download is exactly the rows
// on screen — a second copy is a second place for a filter to be forgotten, and the resulting file
// gives no sign that it is wider or narrower than the list it came from.
function customerListParamsFrom(req: Request): customerService.ListCustomersParams {
  const { search, status, sort, page, pageSize } = req.query;
  return {
    search: queryStr(search),
    status: queryStr(status),
    sort: queryStr(sort),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  };
}

export const listCustomers = asyncHandler(async (req, res) => {
  res.json(await customerService.listCustomers(customerListParamsFrom(req)));
});

// GET /customers/export.csv — the same filtered list as a download (paging ignored).
export const exportCustomersCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "customers", await customerService.exportCustomersCsv(customerListParamsFrom(req), actorFrom(req)));
});

// GET /customers/:id  — detail (by id or customerCode), with projects/sites/users.
// The pending stock-request queue is only embedded for callers who hold
// stock_requests.view — customers.view alone never exposes it (it has its own route).
export const getCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.getCustomer(param(req, "id"), {
    // The Submissions tab pages this from /customers/:id/stock-requests and builds its menu from
    // that endpoint's statusCounts, so the detail payload no longer carries the collection. It used
    // to ship every submission an account had ever made on every visit to any tab.
    includeStockRequests: false,
  });
  res.json({ customer });
});

// POST /customers  — create + provision login; returns the temp password ONCE.
export const createCustomer = asyncHandler(async (req, res) => {
  const result = await customerService.createCustomer(req.body as CreateCustomerInput, actorFrom(req));
  res.status(201).json(result);
});

// PUT /customers/:id
export const updateCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.updateCustomer(
    param(req, "id"),
    req.body as UpdateCustomerInput,
    actorFrom(req),
  );
  res.json({ customer });
});

// DELETE /customers/:id  — soft delete.
export const deleteCustomer = asyncHandler(async (req, res) => {
  await customerService.deleteCustomer(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});

// POST /customers/:id/resend-invite  — new temp password + re-send login email.
export const resendInvite = asyncHandler(async (req, res) => {
  const result = await customerService.resendInvite(param(req, "id"), actorFrom(req));
  res.json(result);
});

// --- nested: projects ---
export const addProject = asyncHandler(async (req, res) => {
  const project = await customerService.addProject(
    param(req, "id"),
    req.body as ProjectInput,
    actorFrom(req),
  );
  res.status(201).json({ project });
});

export const updateProject = asyncHandler(async (req, res) => {
  const project = await customerService.updateProject(
    param(req, "id"),
    param(req, "projectId"),
    req.body as ProjectInput,
    actorFrom(req),
  );
  res.json({ project });
});

export const deleteProject = asyncHandler(async (req, res) => {
  await customerService.removeProject(param(req, "id"), param(req, "projectId"), actorFrom(req));
  res.json({ ok: true });
});

// --- nested: sites ---
export const addSite = asyncHandler(async (req, res) => {
  const site = await customerService.addSite(param(req, "id"), req.body as SiteInput, actorFrom(req));
  res.status(201).json({ site });
});

export const bulkAddSites = asyncHandler(async (req, res) => {
  const { sites, fileName } = req.body as BulkSiteInput;
  const result = await customerService.bulkAddSites(param(req, "id"), sites, fileName, actorFrom(req));
  res.status(201).json(result);
});

export const updateSite = asyncHandler(async (req, res) => {
  const site = await customerService.updateSite(
    param(req, "id"),
    param(req, "siteId"),
    req.body as SiteInput,
    actorFrom(req),
  );
  res.json({ site });
});

export const deleteSite = asyncHandler(async (req, res) => {
  await customerService.removeSite(param(req, "id"), param(req, "siteId"), actorFrom(req));
  res.json({ ok: true });
});

// --- nested: customer users (also the portal login accounts) ---
export const addCustomerUser = asyncHandler(async (req, res) => {
  // Returns { user, temporaryPassword } — the new login's one-time password.
  const result = await customerService.addCustomerUser(
    param(req, "id"),
    req.body as CustomerUserInput,
    actorFrom(req),
  );
  res.status(201).json(result);
});

export const updateCustomerUser = asyncHandler(async (req, res) => {
  const user = await customerService.updateCustomerUser(
    param(req, "id"),
    param(req, "userId"),
    req.body as CustomerUserInput,
    actorFrom(req),
  );
  res.json({ user });
});


// POST /customers/:id/users/:userId/resend-invite — fresh temp password + email.
export const resendCustomerUserInvite = asyncHandler(async (req, res) => {
  const result = await customerService.resendCustomerUserInvite(
    param(req, "id"),
    param(req, "userId"),
    actorFrom(req),
  );
  res.json(result);
});

// POST /customers/:id/users/:userId/send-reset-link — email the customer a secure
// link to set their OWN new password. The admin never sees or sets it. Returns the
// email only (no password to relay).
export const sendCustomerUserResetLink = asyncHandler(async (req, res) => {
  const result = await customerService.sendUserResetLink(
    param(req, "id"),
    param(req, "userId"),
    actorFrom(req),
  );
  res.json(result);
});

// --- nested: stock requests (admin review queue) ---
// GET /customers/:id/stock-requests?status=&search=&raisedFrom=&raisedTo=&page=&pageSize=
// Paged at the DB — submissions accumulate for the life of an account and this tab used to render
// every one of them.
export const listStockRequests = asyncHandler(async (req, res) => {
  const { status, search, raisedFrom, raisedTo, page, pageSize } = req.query;
  res.json(
    await customerService.listStockRequests(param(req, "id"), {
      status: queryStr(status),
      search: queryStr(search),
      raisedFrom: queryStr(raisedFrom),
      raisedTo: queryStr(raisedTo),
      page: queryInt(page),
      pageSize: queryInt(pageSize),
    }),
  );
});

// POST /customers/:id/stock-requests — admin creates a submission on behalf of the
// customer (e.g. taken over the phone). Queues it for the normal review flow.
export const createStockRequest = asyncHandler(async (req, res) => {
  const body = req.body as AdminStockRequestInput;
  const request = await customerService.createStockRequestForCustomer(
    param(req, "id"),
    body.requestedByName?.trim() || null,
    body,
    actorFrom(req),
  );
  res.status(201).json({ request });
});

// POST /customers/:id/stock-requests/:reqId/approve — status move only (never
// creates a stock entry or inventory record).
export const approveStockRequest = asyncHandler(async (req, res) => {
  const result = await customerService.approveStockRequest(
    param(req, "id"),
    param(req, "reqId"),
    (req.body as StockReviewInput).note,
    actorFrom(req),
  );
  res.json(result); // { request }
});

// POST /customers/:id/stock-requests/:reqId/reject
export const rejectStockRequest = asyncHandler(async (req, res) => {
  const request = await customerService.rejectStockRequest(
    param(req, "id"),
    param(req, "reqId"),
    (req.body as StockReviewInput).note,
    actorFrom(req),
  );
  res.json({ request });
});

// POST /customers/:id/stock-requests/:reqId/edit-approve — PM edits name + approves.
export const editAndApproveStockRequest = asyncHandler(async (req, res) => {
  const result = await customerService.editAndApproveStockRequest(
    param(req, "id"),
    param(req, "reqId"),
    req.body as StockRequestEditInput,
    actorFrom(req),
  );
  res.json(result);
});

// POST /customers/:id/stock-requests/:reqId/assign — PM assigns warehouses.
export const assignStockRequestWarehouses = asyncHandler(async (req, res) => {
  const result = await customerService.assignStockRequestWarehouses(
    param(req, "id"),
    param(req, "reqId"),
    req.body as StockRequestAssignInput,
    actorFrom(req),
  );
  res.json(result);
});

// GET /customers/:id/stock-requests/:reqId/assignments — view warehouse assignments.
export const listStockRequestAssignments = asyncHandler(async (req, res) => {
  const assignments = await customerService.getStockRequestAssignments(
    param(req, "id"),
    param(req, "reqId"),
  );
  res.json({ assignments });
});

// POST /stock-assignments/:id/receive — warehouse manager receives stock.
export const receiveStockAssignment = asyncHandler(async (req, res) => {
  const result = await customerService.receiveStockAssignment(
    param(req, "id"),
    req.body as StockAssignmentReceiveInput,
    actorFrom(req),
  );
  res.json(result);
});

// POST /stock-assignments/:id/close-short — the outstanding balance is never arriving.
export const closeStockAssignmentShort = asyncHandler(async (req, res) => {
  const assignment = await customerService.closeAssignmentShort(
    param(req, "id"),
    req.body as StockAssignmentCloseShortInput,
    actorFrom(req),
  );
  res.json({ assignment });
});

// GET /warehouses/:id/pending-stock — pending customer stock for a warehouse.
export const getPendingStockForWarehouse = asyncHandler(async (req, res) => {
  const items = await customerService.getPendingStockForWarehouse(param(req, "id"), actorFrom(req));
  res.json({ items });
});

// --- customer stock entries (product details after warehouse receive) ---------

// GET /stock-entries/:id — single stock entry detail.
export const getStockEntry = asyncHandler(async (req, res) => {
  const entry = await customerService.getStockEntry(param(req, "id"), actorFrom(req));
  res.json({ entry });
});

// PUT /stock-entries/:id — update product details + activate.
export const updateStockEntry = asyncHandler(async (req, res) => {
  const entry = await customerService.updateStockEntry(
    param(req, "id"),
    req.body as StockEntryUpdateInput,
    actorFrom(req),
  );
  res.json({ entry });
});

// POST /stock-entries/:id/generate-barcode — generate + save barcode.
export const generateStockEntryBarcode = asyncHandler(async (req, res) => {
  const entry = await customerService.generateStockEntryBarcode(param(req, "id"), actorFrom(req));
  res.json({ entry });
});

// DELETE /stock-entries/:id — permanently remove a stock entry.
export const deleteStockEntry = asyncHandler(async (req, res) => {
  await customerService.deleteStockEntry(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});

// POST /customers/:id/stock-entries — directly add a stock entry for a customer.
export const createDirectStockEntry = asyncHandler(async (req, res) => {
  const entry = await customerService.createDirectStockEntry(
    param(req, "id"),
    req.body as customerService.DirectStockEntryInput,
    actorFrom(req),
  );
  res.status(201).json({ entry });
});

// GET /customers/:id/stock-entries — list stock entries for a customer.
// GET /customers/:id/stock-entries/export.csv — one customer's stock, same columns as their own
// portal export (see exportCustomerStockCsv for why they must match).
export const exportCustomerStockCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "customer-stock", await customerService.exportCustomerStockCsv(param(req, "id"), portalListParams(req)));
});

// The tab's filters, parsed ONCE and shared with the customer-stock CSV export below, so a filter
// added to the screen cannot be silently absent from the download.
function stockEntryParamsFrom(req: import("express").Request): customerService.ListStockEntriesParams {
  return {
    status: queryStr(req.query.status),
    search: queryStr(req.query.search),
    warehouseId: queryStr(req.query.warehouseId),
    receivedFrom: queryStr(req.query.receivedFrom),
    receivedTo: queryStr(req.query.receivedTo),
  };
}

// GET /customers/:id/stock-options — the job form's customer-stock picker. Complete by design; see
// the service for why paging it would be incorrect rather than merely inconvenient.
export const listCustomerStockOptions = asyncHandler(async (req, res) => {
  res.json({ options: await customerService.listCustomerStockOptions(param(req, "id")) });
});

export const listCustomerStockEntries = asyncHandler(async (req, res) => {
  res.json(
    await customerService.listCustomerStockEntries(param(req, "id"), {
      ...stockEntryParamsFrom(req),
      page: queryInt(req.query.page),
      pageSize: queryInt(req.query.pageSize),
    }),
  );
});

// GET /warehouses/:id/stock-entries — list stock entries for a warehouse.
export const listWarehouseStockEntries = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const entries = await customerService.listWarehouseStockEntries(
    param(req, "id"),
    queryStr(status),
    actorFrom(req),
  );
  res.json({ entries });
});

// POST /stock-entries/:id/transfer — move quantity to a different warehouse.
export const transferCustomerStock = asyncHandler(async (req, res) => {
  const body = req.body as CustomerStockTransferInput;
  const result = await customerService.transferCustomerStock(
    param(req, "id"),
    { toWarehouseId: body.toWarehouseId, quantity: body.quantity, notes: body.notes },
    actorFrom(req),
  );
  res.status(201).json(result);
});

// ============================================================================
// Customer-facing portal surface (guarded by requireCustomer)
//
// Every read is scoped to the AUTHENTICATED customer's own id, taken from
// req.principal — never from a route param or query — so a customer can only ever
// see their own data.
// ============================================================================

function customerId(req: import("express").Request): string {
  if (req.principal?.type !== "customer") throw unauthorized("Customer access required.");
  return req.principal.customerId;
}

// GET /customer/me  — the signed-in customer's own profile.
export const getOwnProfile = asyncHandler(async (req, res) => {
  const profile = await customerService.getOwnProfile(customerId(req));
  res.json({ profile });
});

// GET /customer/stock  — the signed-in customer's stock (Flow 9). Returns
// { available: false, ... } until the inventory read-model is wired + flagged on.
export const getOwnStock = asyncHandler(async (req, res) => {
  const stock = await customerService.getOwnStock(customerId(req));
  res.json({ stock });
});

// The portal's paged-list params, parsed uniformly from the query string.
const portalListParams = (req: Request) => ({
  search: queryStr(req.query.q),
  status: queryStr(req.query.status),
  sort: queryStr(req.query.sort),
  // Stock lists only; ignored by the others. Never trusted as a scope — every portal query is already
  // pinned to `customerId(req)` from the session, so an id for someone else's warehouse just matches
  // none of this customer's rows.
  warehouseId: queryStr(req.query.warehouseId),
  // Stock lists only — inclusive calendar days on when we received it.
  receivedFrom: queryStr(req.query.receivedFrom),
  receivedTo: queryStr(req.query.receivedTo),
  // Submissions only — inclusive calendar days on when the customer submitted.
  raisedFrom: queryStr(req.query.raisedFrom),
  raisedTo: queryStr(req.query.raisedTo),
  page: queryInt(req.query.page),
  pageSize: queryInt(req.query.pageSize),
});

// GET /customer/stock-entries — the signed-in customer's received stock entries (paged).
export const getOwnStockEntries = asyncHandler(async (req, res) => {
  res.json(await customerService.listCustomerStockEntriesPaged(customerId(req), portalListParams(req)));
});

// GET /customer/stock-warehouses — option list for My Stock's warehouse filter (only warehouses that
// actually hold this customer's stock).
export const getOwnStockWarehouses = asyncHandler(async (req, res) => {
  res.json({ warehouses: await customerService.listOwnStockWarehouses(customerId(req)) });
});

// GET /customer/submission-warehouses — the warehouses a customer may pick as their PREFERRED
// destination on a stock submission: every active, non-deleted one. Kept separate from
// getOwnStockWarehouses above, which is the "My stock" list's filter facet scoped to warehouses
// actually holding their stock: same shape, different question, and merging them would mean a
// change to one silently redefining the other.
export const getOwnSubmissionWarehouses = asyncHandler(async (_req, res) => {
  res.json({ warehouses: await customerService.listSelectableWarehouses() });
});

// GET /customer/stock-entries/export.csv — the customer's stock, honouring the list's filters
// (page/pageSize ignored: the export spans every matching row up to the cap).
export const exportOwnStockCsv = asyncHandler(async (req, res) => {
  const { csv, capped } = await customerService.exportOwnStockCsv(customerId(req), portalListParams(req));
  sendCsv(res, "my-stock", { csv, capped });
});

// GET /customer/stock-requests/export.csv — the customer's submissions, same contract.
export const exportOwnStockRequestsCsv = asyncHandler(async (req, res) => {
  const { csv, capped } = await customerService.exportOwnStockRequestsCsv(customerId(req), portalListParams(req));
  sendCsv(res, "my-submissions", { csv, capped });
});

// GET /customers/:id/sites — ADMIN: paged sites for the detail tab.
export const listCustomerSites = asyncHandler(async (req, res) => {
  res.json(await customerService.listCustomerSites(param(req, "id"), portalListParams(req)));
});

// GET /customers/:id/projects — ADMIN: paged projects for the detail tab.
export const listCustomerProjects = asyncHandler(async (req, res) => {
  res.json(await customerService.listCustomerProjects(param(req, "id"), portalListParams(req)));
});

// GET /customers/:id/site-keys — ADMIN: lean name+postcode pairs for the import-preview dedupe.
export const listCustomerSiteKeys = asyncHandler(async (req, res) => {
  res.json({ keys: await customerService.listCustomerSiteKeys(param(req, "id")) });
});

// GET /customer/projects — the signed-in customer's projects (read-only, paged).
export const getOwnProjects = asyncHandler(async (req, res) => {
  res.json(await customerService.getOwnProjects(customerId(req), portalListParams(req)));
});

// GET /customer/sites — the signed-in customer's sites (read-only, paged — sites can be
// bulk-imported in the thousands).
export const getOwnSites = asyncHandler(async (req, res) => {
  res.json(await customerService.getOwnSites(customerId(req), portalListParams(req)));
});

// GET /customer/overview — portal dashboard summary (company header + counts +
// recent requests).
export const getOwnOverview = asyncHandler(async (req, res) => {
  const overview = await customerService.getOwnOverview(customerId(req));
  res.json({ overview });
});

// GET /customer/stock-requests — the signed-in customer's own stock requests (paged).
export const getOwnStockRequests = asyncHandler(async (req, res) => {
  res.json(await customerService.getOwnStockRequests(customerId(req), portalListParams(req)));
});

// POST /customer/stock-requests — request to add a stock item (queued for an
// internal user to review). The ONE write a portal user can make into the module.
export const submitStockRequest = asyncHandler(async (req, res) => {
  const p = req.principal;
  if (p?.type !== "customer") throw unauthorized("Customer access required.");
  const request = await customerService.submitStockRequest(
    p.customerId,
    { userId: p.id, name: p.userName, email: p.email },
    req.body as StockRequestInput,
  );
  res.status(201).json({ request });
});

// GET /customers/options — the complete active set, lean, for pickers.
export const listCustomerOptions = asyncHandler(async (_req, res) => {
  res.json({ options: await customerService.listCustomerOptions() });
});
