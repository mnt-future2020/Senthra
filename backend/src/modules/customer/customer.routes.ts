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
  projectSchema,
  siteSchema,
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

// ----------------------------------------------------------------------------
// Customer-facing portal surface — mounted at /customer. READ-ONLY: only GETs,
// guarded by requireCustomer, and every read is scoped to the authenticated
// customer's own id (from req.principal). There are deliberately no write routes.
// ----------------------------------------------------------------------------
const portalRouter = Router();
portalRouter.use(requireAuth, requireCustomer);

portalRouter.get("/me", customerController.getOwnProfile);
portalRouter.get("/catalogue", customerController.getOwnCatalogue);
portalRouter.get("/stock", customerController.getOwnStock);

export { adminRouter, portalRouter };
export default adminRouter;
