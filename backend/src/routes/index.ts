import { Router } from "express";

import auditRoutes from "#modules/audit/audit.routes.js";
import authRoutes from "#modules/auth/auth.routes.js";
import categoryRoutes from "#modules/category/category.routes.js";
import { adminRouter as customerRoutes, portalRouter as customerPortalRoutes } from "#modules/customer/customer.routes.js";
import departmentRoutes from "#modules/department/department.routes.js";
import emailTemplateRoutes from "#modules/email/emailTemplate.routes.js";
import irmRoutes from "#modules/irm/irm.routes.js";
import irmCategoryRoutes from "#modules/irm-category/irm-category.routes.js";
import irmTypeRoutes from "#modules/irm-type/irm-type.routes.js";
import jobTitleRoutes from "#modules/jobTitle/jobTitle.routes.js";
import purchaseOrderRoutes from "#modules/purchase-order/purchase-order.routes.js";
import roleRoutes from "#modules/role/role.routes.js";
import settingsRoutes from "#modules/settings/settings.routes.js";
import supplierRoutes from "#modules/supplier/supplier.routes.js";
import supplierTypeRoutes from "#modules/supplier-type/supplier-type.routes.js";
import userRoutes from "#modules/user/user.routes.js";
import warehouseRoutes from "#modules/warehouse/warehouse.routes.js";
import warehouseTypeRoutes from "#modules/warehouse-type/warehouse-type.routes.js";

const router = Router();

// Health check
router.get("/", (_req, res) => {
  res.json({ status: "ok", service: "backend" });
});

// Feature routes
router.use("/auth", authRoutes);
router.use("/audit", auditRoutes);
router.use("/settings", settingsRoutes);
router.use("/users", userRoutes);
router.use("/roles", roleRoutes);
router.use("/categories", categoryRoutes);
router.use("/warehouses", warehouseRoutes);
router.use("/warehouse-types", warehouseTypeRoutes);
router.use("/suppliers", supplierRoutes);
router.use("/supplier-types", supplierTypeRoutes);
router.use("/irm-items", irmRoutes);
router.use("/irm-types", irmTypeRoutes);
router.use("/irm-categories", irmCategoryRoutes);
router.use("/purchase-orders", purchaseOrderRoutes);
router.use("/departments", departmentRoutes);
router.use("/job-titles", jobTitleRoutes);
router.use("/email-templates", emailTemplateRoutes);
// Customer master-data (admin/PM) + the read-only customer portal API.
router.use("/customers", customerRoutes);
router.use("/customer", customerPortalRoutes);

export default router;
