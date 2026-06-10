import * as customerService from "./customer.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt } from "../../utils/request.js";
import { unauthorized } from "../../utils/http-error.js";
import type {
  CatalogueItemInput,
  CreateCustomerInput,
  ProjectInput,
  SiteInput,
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
export const getCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.getCustomer(param(req, "id"));
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
    (req.body as ProjectInput).name,
    actorFrom(req),
  );
  res.status(201).json({ project });
});

export const updateProject = asyncHandler(async (req, res) => {
  const project = await customerService.updateProject(
    param(req, "id"),
    param(req, "projectId"),
    (req.body as ProjectInput).name,
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
