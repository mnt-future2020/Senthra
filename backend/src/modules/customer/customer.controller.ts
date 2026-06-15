import * as customerService from "./customer.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt } from "../../utils/request.js";
import { unauthorized } from "../../utils/http-error.js";
import { principalGrants } from "../../types/principal.js";
import type {
  CatalogueItemInput,
  CreateCustomerInput,
  CustomerUserInput,
  ProjectInput,
  SiteInput,
  StockRequestInput,
  StockReviewInput,
  UpdateCustomerInput,
} from "./customer.validation.js";

// ============================================================================
// Admin / PM surface (guarded by customers.* permissions)
// ============================================================================

// GET /customers  — paginated. Query: ?search=&status=&sort=&page=&pageSize=
export const listCustomers = asyncHandler(async (req, res) => {
  const { search, status, sort, page, pageSize } = req.query;
  const result = await customerService.listCustomers({
    search: typeof search === "string" ? search : undefined,
    status: typeof status === "string" ? status : undefined,
    sort: typeof sort === "string" ? sort : undefined,
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  });
  res.json(result);
});

// GET /customers/:id  — detail (by id or customerCode), with projects/catalogue/sites.
// The pending stock-request queue is only embedded for callers who hold
// stock_requests.view — customers.view alone never exposes it (it has its own route).
export const getCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.getCustomer(param(req, "id"), {
    includeStockRequests: principalGrants(req.principal, "stock_requests.view"),
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

// --- nested: catalogue ---
export const addCatalogueItem = asyncHandler(async (req, res) => {
  const item = await customerService.addCatalogueItem(
    param(req, "id"),
    req.body as CatalogueItemInput,
    actorFrom(req),
  );
  res.status(201).json({ item });
});

export const updateCatalogueItem = asyncHandler(async (req, res) => {
  const item = await customerService.updateCatalogueItem(
    param(req, "id"),
    param(req, "itemId"),
    req.body as CatalogueItemInput,
    actorFrom(req),
  );
  res.json({ item });
});

export const deleteCatalogueItem = asyncHandler(async (req, res) => {
  await customerService.removeCatalogueItem(param(req, "id"), param(req, "itemId"), actorFrom(req));
  res.json({ ok: true });
});

// --- nested: sites ---
export const addSite = asyncHandler(async (req, res) => {
  const site = await customerService.addSite(param(req, "id"), req.body as SiteInput, actorFrom(req));
  res.status(201).json({ site });
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
// GET /customers/:id/stock-requests?status=
export const listStockRequests = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const requests = await customerService.listStockRequests(
    param(req, "id"),
    typeof status === "string" ? status : undefined,
  );
  res.json({ requests });
});

// POST /customers/:id/stock-requests/:reqId/approve — status move only (never
// creates a catalogue item or inventory record).
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

// GET /customer/catalogue  — the signed-in customer's stock catalogue.
export const getOwnCatalogue = asyncHandler(async (req, res) => {
  const catalogue = await customerService.getOwnCatalogue(customerId(req));
  res.json({ catalogue });
});

// GET /customer/stock  — the signed-in customer's stock (Flow 9). Returns
// { available: false, ... } until the inventory read-model is wired + flagged on.
export const getOwnStock = asyncHandler(async (req, res) => {
  const stock = await customerService.getOwnStock(customerId(req));
  res.json({ stock });
});

// GET /customer/projects — the signed-in customer's projects (read-only).
export const getOwnProjects = asyncHandler(async (req, res) => {
  const projects = await customerService.getOwnProjects(customerId(req));
  res.json({ projects });
});

// GET /customer/sites — the signed-in customer's sites (read-only).
export const getOwnSites = asyncHandler(async (req, res) => {
  const sites = await customerService.getOwnSites(customerId(req));
  res.json({ sites });
});

// GET /customer/overview — portal dashboard summary (company header + counts +
// recent requests).
export const getOwnOverview = asyncHandler(async (req, res) => {
  const overview = await customerService.getOwnOverview(customerId(req));
  res.json({ overview });
});

// GET /customer/stock-requests — the signed-in customer's own catalogue-add requests.
export const getOwnStockRequests = asyncHandler(async (req, res) => {
  const requests = await customerService.getOwnStockRequests(customerId(req));
  res.json({ requests });
});

// POST /customer/stock-requests — request to add a catalogue item (queued for an
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
