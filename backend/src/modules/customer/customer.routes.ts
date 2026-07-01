import { Router } from "express";

import * as customerController from "./customer.controller.js";
import {
  requireAuth,
  requireAnyPermission,
  requireCustomer,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  adminStockRequestSchema,
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
adminRouter.post(
  "/",
  requirePermission("customers.create"),
  writeLimiter,
  validateBody(createCustomerSchema),
  customerController.createCustomer,
);
adminRouter.get("/:id", requirePermission("customers.view"), customerController.getCustomer);
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

portalRouter.get("/me", customerController.getOwnProfile);
portalRouter.get("/overview", customerController.getOwnOverview);
portalRouter.get("/projects", customerController.getOwnProjects);
portalRouter.get("/sites", customerController.getOwnSites);
portalRouter.get("/stock", customerController.getOwnStock);
portalRouter.get("/stock-entries", customerController.getOwnStockEntries);
portalRouter.get("/stock-requests", customerController.getOwnStockRequests);
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
