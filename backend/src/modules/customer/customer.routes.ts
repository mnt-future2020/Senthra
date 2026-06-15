import { Router } from "express";

import * as customerController from "./customer.controller.js";
import {
  requireAuth,
  requireCustomer,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  catalogueItemSchema,
  createCustomerSchema,
  customerUserSchema,
  projectSchema,
  siteSchema,
  stockRequestSchema,
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
  "/:id/catalogue",
  requirePermission("customer_stock.create"),
  writeLimiter,
  validateBody(catalogueItemSchema),
  customerController.addCatalogueItem,
);
adminRouter.put(
  "/:id/catalogue/:itemId",
  requirePermission("customer_stock.edit"),
  writeLimiter,
  validateBody(catalogueItemSchema),
  customerController.updateCatalogueItem,
);
adminRouter.delete(
  "/:id/catalogue/:itemId",
  requirePermission("customer_stock.delete"),
  writeLimiter,
  customerController.deleteCatalogueItem,
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
// status move only — it never writes the catalogue or inventory. (Completion is a
// future status, introduced with the Goods Out workflow.)
adminRouter.get(
  "/:id/stock-requests",
  requirePermission("stock_requests.view"),
  customerController.listStockRequests,
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

// ----------------------------------------------------------------------------
// Customer-facing portal surface — mounted at /customer. Reads are scoped to the
// authenticated customer (from req.principal). The single write is submitting a
// stock REQUEST, which only QUEUES a review — it never writes the catalogue directly.
// ----------------------------------------------------------------------------
const portalRouter = Router();
portalRouter.use(requireAuth, requireCustomer);

portalRouter.get("/me", customerController.getOwnProfile);
portalRouter.get("/overview", customerController.getOwnOverview);
portalRouter.get("/projects", customerController.getOwnProjects);
portalRouter.get("/sites", customerController.getOwnSites);
portalRouter.get("/catalogue", customerController.getOwnCatalogue);
portalRouter.get("/stock", customerController.getOwnStock);
portalRouter.get("/stock-requests", customerController.getOwnStockRequests);
portalRouter.post(
  "/stock-requests",
  writeLimiter,
  validateBody(stockRequestSchema),
  customerController.submitStockRequest,
);

export { adminRouter, portalRouter };
export default adminRouter;
