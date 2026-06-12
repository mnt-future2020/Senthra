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
adminRouter.post(
  "/:id/resend-invite",
  requirePermission("customers.edit"),
  writeLimiter,
  customerController.resendInvite,
);

// Nested master-data — managed inline from the customer detail page, so editing a
// customer (customers.edit) covers adding/renaming/removing projects, catalogue
// items and sites.
adminRouter.post(
  "/:id/projects",
  requirePermission("customers.edit"),
  writeLimiter,
  validateBody(projectSchema),
  customerController.addProject,
);
adminRouter.put(
  "/:id/projects/:projectId",
  requirePermission("customers.edit"),
  writeLimiter,
  validateBody(projectSchema),
  customerController.updateProject,
);
adminRouter.delete(
  "/:id/projects/:projectId",
  requirePermission("customers.edit"),
  writeLimiter,
  customerController.deleteProject,
);

adminRouter.post(
  "/:id/catalogue",
  requirePermission("customers.edit"),
  writeLimiter,
  validateBody(catalogueItemSchema),
  customerController.addCatalogueItem,
);
adminRouter.put(
  "/:id/catalogue/:itemId",
  requirePermission("customers.edit"),
  writeLimiter,
  validateBody(catalogueItemSchema),
  customerController.updateCatalogueItem,
);
adminRouter.delete(
  "/:id/catalogue/:itemId",
  requirePermission("customers.edit"),
  writeLimiter,
  customerController.deleteCatalogueItem,
);

adminRouter.post(
  "/:id/sites",
  requirePermission("customers.edit"),
  writeLimiter,
  validateBody(siteSchema),
  customerController.addSite,
);
adminRouter.put(
  "/:id/sites/:siteId",
  requirePermission("customers.edit"),
  writeLimiter,
  validateBody(siteSchema),
  customerController.updateSite,
);
adminRouter.delete(
  "/:id/sites/:siteId",
  requirePermission("customers.edit"),
  writeLimiter,
  customerController.deleteSite,
);

adminRouter.post(
  "/:id/users",
  requirePermission("customers.edit"),
  writeLimiter,
  validateBody(customerUserSchema),
  customerController.addCustomerUser,
);
adminRouter.put(
  "/:id/users/:userId",
  requirePermission("customers.edit"),
  writeLimiter,
  validateBody(customerUserSchema),
  customerController.updateCustomerUser,
);
adminRouter.post(
  "/:id/users/:userId/resend-invite",
  requirePermission("customers.edit"),
  writeLimiter,
  customerController.resendCustomerUserInvite,
);

// Stock requests — the review queue for customer-submitted stock asks. Viewing
// needs customers.view; approving / rejecting needs customers.edit. Approval is a
// status move only — it never writes the catalogue or inventory.
adminRouter.get(
  "/:id/stock-requests",
  requirePermission("customers.view"),
  customerController.listStockRequests,
);
adminRouter.post(
  "/:id/stock-requests/:reqId/approve",
  requirePermission("customers.edit"),
  writeLimiter,
  validateBody(stockReviewSchema),
  customerController.approveStockRequest,
);
adminRouter.post(
  "/:id/stock-requests/:reqId/reject",
  requirePermission("customers.edit"),
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
