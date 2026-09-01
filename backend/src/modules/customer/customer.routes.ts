import { Router } from "express";

import * as customerController from "./customer.controller.js";
import {
  requireAuth,
  requireAnyPermission,
  requireCustomer,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter, bulkWriteLimiter, exportLimiter } from "../../middleware/rateLimit.middleware.js";
import * as reportsController from "#modules/reports/reports.controller.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  adminStockRequestSchema,
  bulkSiteSchema,
  createCustomerSchema,
  customerStockTransferSchema,
  customerUserSchema,
  directStockEntrySchema,
  projectSchema,
  siteSchema,
  stockRequestSchema,
  stockRequestEditSchema,
  stockRequestAssignSchema,
  stockAssignmentReceiveSchema,
  stockAssignmentCloseShortSchema,
  stockEntryUpdateSchema,
  stockReviewSchema,
  updateCustomerSchema,
} from "./customer.validation.js";

// ----------------------------------------------------------------------------
// Admin / PM surface — mounted at /customers. Every route requires auth + a
// granular customers.* permission (the super-admin always passes).
// ----------------------------------------------------------------------------
const adminRouter = Router();
adminRouter.use(requireAuth);

adminRouter.get("/", requirePermission("customers.view"), customerController.listCustomers);
// BEFORE any "/:id" route — otherwise "export.csv" is parsed as an id and 404s on lookup.
// Static route BEFORE "/:id" so "options" is not parsed as an id.
//
// Wider than customers.view on purpose, and it grants no reach: only the id, code and name of
// ACTIVE customers — the same names already shown on the jobs these callers create. A planner who
// may raise a job but not administer the customer directory still has to be able to pick one.
adminRouter.get(
  "/options",
  requireAnyPermission("customers.view", "jobs.create", "jobs.edit"),
  customerController.listCustomerOptions,
);
adminRouter.get("/export.csv", requirePermission("customers.export"), exportLimiter, customerController.exportCustomersCsv);
adminRouter.post(
  "/",
  requirePermission("customers.create"),
  writeLimiter,
  validateBody(createCustomerSchema),
  customerController.createCustomer,
);
adminRouter.get("/:id", requirePermission("customers.view"), customerController.getCustomer);
// Paged children for the detail tabs (the detail payload no longer carries the full child sets —
// sites can be bulk-imported in the thousands). Same view gate as the detail itself.
adminRouter.get("/:id/sites", requirePermission("customers.view"), customerController.listCustomerSites);
adminRouter.get("/:id/projects", requirePermission("customers.view"), customerController.listCustomerProjects);
adminRouter.get("/:id/site-keys", requirePermission("customers.view"), customerController.listCustomerSiteKeys);
adminRouter.put(
  "/:id",
  requirePermission("customers.edit"),
  writeLimiter,
  validateBody(updateCustomerSchema),
  customerController.updateCustomer,
);
adminRouter.delete(
  "/:id",
  requirePermission("customers.delete"),
  writeLimiter,
  customerController.deleteCustomer,
);
// Re-issuing the company's primary portal invite is a portal-login action.
adminRouter.post(
  "/:id/resend-invite",
  requirePermission("customer_portal.resend_invite"),
  writeLimiter,
  customerController.resendInvite,
);

// Nested sub-entities — managed inline from the customer detail page, each gated by
// its own granular group (the parent customers.view is implied for reads via the
// aggregate detail GET). Writes carry the matching create / edit / delete permission.
adminRouter.post(
  "/:id/projects",
  requirePermission("customer_projects.create"),
  writeLimiter,
  validateBody(projectSchema),
  customerController.addProject,
);
adminRouter.put(
  "/:id/projects/:projectId",
  requirePermission("customer_projects.edit"),
  writeLimiter,
  validateBody(projectSchema),
  customerController.updateProject,
);
adminRouter.delete(
  "/:id/projects/:projectId",
  requirePermission("customer_projects.delete"),
  writeLimiter,
  customerController.deleteProject,
);

adminRouter.post(
  "/:id/sites",
  requirePermission("customer_sites.create"),
  writeLimiter,
  validateBody(siteSchema),
  customerController.addSite,
);
adminRouter.post(
  "/:id/sites/bulk",
  requirePermission("customer_sites.create"),
  bulkWriteLimiter,
  validateBody(bulkSiteSchema),
  customerController.bulkAddSites,
);
adminRouter.put(
  "/:id/sites/:siteId",
  requirePermission("customer_sites.edit"),
  writeLimiter,
  validateBody(siteSchema),
  customerController.updateSite,
);
adminRouter.delete(
  "/:id/sites/:siteId",
  requirePermission("customer_sites.delete"),
  writeLimiter,
  customerController.deleteSite,
);

// Portal-login accounts: create / edit / deactivate is `manage`; the two re-credential
// actions have their own keys (resend invite vs. email a self-serve reset link).
adminRouter.post(
  "/:id/users",
  requirePermission("customer_portal.manage"),
  writeLimiter,
  validateBody(customerUserSchema),
  customerController.addCustomerUser,
);
adminRouter.put(
  "/:id/users/:userId",
  requirePermission("customer_portal.manage"),
  writeLimiter,
  validateBody(customerUserSchema),
  customerController.updateCustomerUser,
);
adminRouter.post(
  "/:id/users/:userId/resend-invite",
  requirePermission("customer_portal.resend_invite"),
  writeLimiter,
  customerController.resendCustomerUserInvite,
);
adminRouter.post(
  "/:id/users/:userId/send-reset-link",
  requirePermission("customer_portal.reset_password"),
  writeLimiter,
  customerController.sendCustomerUserResetLink,
);

// Stock requests — the review queue for customer-submitted stock asks. Viewing needs
// stock_requests.view; approving / rejecting need the matching key. Approval is a
// status move only — it never writes inventory. Completion (stock_requests.complete)
// is the warehouse-receive step below, which posts the customer's stock.
adminRouter.get(
  "/:id/stock-requests",
  requirePermission("stock_requests.view"),
  customerController.listStockRequests,
);
adminRouter.post(
  "/:id/stock-requests",
  requirePermission("stock_requests.approve"),
  writeLimiter,
  validateBody(adminStockRequestSchema),
  customerController.createStockRequest,
);
adminRouter.post(
  "/:id/stock-requests/:reqId/approve",
  requirePermission("stock_requests.approve"),
  writeLimiter,
  validateBody(stockReviewSchema),
  customerController.approveStockRequest,
);
adminRouter.post(
  "/:id/stock-requests/:reqId/reject",
  requirePermission("stock_requests.reject"),
  writeLimiter,
  validateBody(stockReviewSchema),
  customerController.rejectStockRequest,
);

// PM edits request item name + approves in one step.
adminRouter.post(
  "/:id/stock-requests/:reqId/edit-approve",
  requirePermission("stock_requests.approve"),
  writeLimiter,
  validateBody(stockRequestEditSchema),
  customerController.editAndApproveStockRequest,
);

// PM assigns warehouses to an approved request.
adminRouter.post(
  "/:id/stock-requests/:reqId/assign",
  requirePermission("stock_requests.approve"),
  writeLimiter,
  validateBody(stockRequestAssignSchema),
  customerController.assignStockRequestWarehouses,
);

// View warehouse assignments for a request.
adminRouter.get(
  "/:id/stock-requests/:reqId/assignments",
  requirePermission("stock_requests.view"),
  customerController.listStockRequestAssignments,
);

// List stock entries (received stock) for a customer — the customer's Inventory tab.
// Readable by Customer Inventory viewers (customer_stock.view) OR stock-submission
// reviewers (stock_requests.view), matching the CustomerDetail "Inventory" tab gate.
adminRouter.get(
  "/:id/stock-entries",
  requireAnyPermission("customer_stock.view", "stock_requests.view"),
  customerController.listCustomerStockEntries,
);
// The job form's picker. SAME gate as the list above — it is that data in option form, not a wider
// reach. Declared alongside it; the paths differ in their last segment so neither shadows the other.
adminRouter.get(
  "/:id/stock-options",
  requireAnyPermission("customer_stock.view", "stock_requests.view"),
  customerController.listCustomerStockOptions,
);
// Same gate as the list it downloads — this is that list in a file, not a wider reach. Declared
// after it because the paths differ in their LAST segment, so neither can shadow the other.
adminRouter.get(
  "/:id/stock-entries/export.csv",
  requireAnyPermission("customer_stock.view", "stock_requests.view"),
  exportLimiter,
  customerController.exportCustomerStockCsv,
);

// Directly add a stock entry for a customer (existing stock in warehouse).
adminRouter.post(
  "/:id/stock-entries",
  requirePermission("customer_stock.create"),
  writeLimiter,
  validateBody(directStockEntrySchema),
  customerController.createDirectStockEntry,
);


// ----------------------------------------------------------------------------
// Customer-facing portal surface — mounted at /customer. Reads are scoped to the
// authenticated customer (from req.principal). The single write is submitting a
// stock REQUEST, which only QUEUES a review — it never writes stock directly.
// ----------------------------------------------------------------------------
const portalRouter = Router();
portalRouter.use(requireAuth, requireCustomer);

// Customer-facing reports (FLOW 9). Mounted on the PORTAL router so `requireCustomer` applies, and
// served by customer-safe handlers that take the customer id from the session — never the query.
// No staff permission is involved: a customer's right to their own data is their session.
portalRouter.get("/reports/types", reportsController.customerReportTypes);
portalRouter.get("/reports", reportsController.runCustomerReport);
portalRouter.get("/reports/export.csv", exportLimiter, reportsController.exportCustomerReportCsv);
portalRouter.get("/reports/export.xlsx", exportLimiter, reportsController.exportCustomerReportXlsx);

portalRouter.get("/me", customerController.getOwnProfile);
portalRouter.get("/overview", customerController.getOwnOverview);
portalRouter.get("/projects", customerController.getOwnProjects);
portalRouter.get("/sites", customerController.getOwnSites);
portalRouter.get("/stock", customerController.getOwnStock);
// Each export sits directly under the list it mirrors: both read the SAME query params, so keeping
// them adjacent is what stops a filter being added to one and missed on the other. (All literal
// paths — no `:param` here for `export.csv` to be shadowed by, so declaration order is cosmetic.)
portalRouter.get("/stock-entries", customerController.getOwnStockEntries);
portalRouter.get("/stock-entries/export.csv", exportLimiter, customerController.exportOwnStockCsv);
portalRouter.get("/stock-warehouses", customerController.getOwnStockWarehouses);
// Warehouses selectable as a PREFERENCE on a new submission: every active, non-deleted warehouse
// (id/code/name only). Read-only, and behind requireAuth like every other portal route.
portalRouter.get("/submission-warehouses", customerController.getOwnSubmissionWarehouses);
portalRouter.get("/stock-requests", customerController.getOwnStockRequests);
portalRouter.get("/stock-requests/export.csv", exportLimiter, customerController.exportOwnStockRequestsCsv);
portalRouter.post(
  "/stock-requests",
  writeLimiter,
  validateBody(stockRequestSchema),
  customerController.submitStockRequest,
);

// ----------------------------------------------------------------------------
// Stock assignment endpoints — mounted at /stock-assignments. Warehouse managers
// receive stock against an assignment.
// ----------------------------------------------------------------------------
const stockAssignmentRouter = Router();
stockAssignmentRouter.use(requireAuth);

stockAssignmentRouter.post(
  "/:id/receive",
  requirePermission("stock_requests.complete"),
  writeLimiter,
  validateBody(stockAssignmentReceiveSchema),
  customerController.receiveStockAssignment,
);

// Same permission as receiving: closing a delivery short is the other way the SAME person finishes
// the same line — it grants no reach beyond what receiving already does, so it needs no new key.
stockAssignmentRouter.post(
  "/:id/close-short",
  requirePermission("stock_requests.complete"),
  writeLimiter,
  validateBody(stockAssignmentCloseShortSchema),
  customerController.closeStockAssignmentShort,
);

// ----------------------------------------------------------------------------
// Warehouse pending customer stock — mounted alongside warehouse routes.
// GET /warehouses/:id/pending-stock is wired from the route aggregator
// because it lives on the warehouse path, not the customer path.
// ----------------------------------------------------------------------------
const warehousePendingRouter = Router();
warehousePendingRouter.use(requireAuth);

warehousePendingRouter.get(
  "/:id/pending-stock",
  requirePermission("stock_requests.view"),
  customerController.getPendingStockForWarehouse,
);

warehousePendingRouter.get(
  "/:id/stock-entries",
  requirePermission("stock_requests.view"),
  customerController.listWarehouseStockEntries,
);

// ----------------------------------------------------------------------------
// Customer stock entry endpoints — mounted at /stock-entries. Product detail
// management after warehouse receive (fill fields, generate barcode).
// ----------------------------------------------------------------------------
const stockEntryRouter = Router();
stockEntryRouter.use(requireAuth);

stockEntryRouter.get(
  "/:id",
  // A single customer stock entry — visible to Customer Inventory viewers and stock-submission reviewers.
  requireAnyPermission("customer_stock.view", "stock_requests.view"),
  customerController.getStockEntry,
);

stockEntryRouter.put(
  "/:id",
  // Editing a customer's stock entry is a customer_stock.edit action; warehouse managers
  // who fill in details right after receiving also qualify via stock_requests.complete.
  requireAnyPermission("customer_stock.edit", "stock_requests.complete"),
  writeLimiter,
  validateBody(stockEntryUpdateSchema),
  customerController.updateStockEntry,
);

stockEntryRouter.delete(
  "/:id",
  requirePermission("customer_stock.delete"),
  writeLimiter,
  customerController.deleteStockEntry,
);

stockEntryRouter.post(
  "/:id/generate-barcode",
  requirePermission("stock_requests.complete"),
  writeLimiter,
  customerController.generateStockEntryBarcode,
);

// Transfer quantity to another warehouse (hub action — same permission as creating a direct entry).
stockEntryRouter.post(
  "/:id/transfer",
  requirePermission("customer_stock.create"),
  writeLimiter,
  validateBody(customerStockTransferSchema),
  customerController.transferCustomerStock,
);

export { adminRouter, portalRouter, stockAssignmentRouter, warehousePendingRouter, stockEntryRouter };
export default adminRouter;
