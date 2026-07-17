import { Router } from "express";

import auditRoutes from "#modules/audit/audit.routes.js";
import authRoutes from "#modules/auth/auth.routes.js";
import engineerTransferRoutes from "#modules/engineer-transfer/engineer-transfer.routes.js";
import categoryRoutes from "#modules/category/category.routes.js";
import { adminRouter as customerRoutes, portalRouter as customerPortalRoutes, stockAssignmentRouter, warehousePendingRouter, stockEntryRouter } from "#modules/customer/customer.routes.js";
import dashboardRoutes from "#modules/dashboard/dashboard.routes.js";
import departmentRoutes from "#modules/department/department.routes.js";
import emailTemplateRoutes from "#modules/email/emailTemplate.routes.js";
import engineerRoutes from "#modules/engineer/engineer.routes.js";
import geoRoutes from "#modules/geo/geo.routes.js";
import goodsInRoutes from "#modules/goods-in/goods-in.routes.js";
import goodsManagementRoutes from "#modules/goods-management/goods-management.routes.js";
import inventoryRoutes from "#modules/inventory/inventory.routes.js";
import irmRoutes from "#modules/irm/irm.routes.js";
import irmCategoryRoutes from "#modules/irm-category/irm-category.routes.js";
import irmTypeRoutes from "#modules/irm-type/irm-type.routes.js";
import jobRoutes from "#modules/job/job.routes.js";
import jobKitRequestRoutes from "#modules/job-kit-request/job-kit-request.routes.js";
import jobTitleRoutes from "#modules/jobTitle/jobTitle.routes.js";
import purchaseOrderRoutes from "#modules/purchase-order/purchase-order.routes.js";
import purchaseRequestRoutes from "#modules/purchase-request/purchase-request.routes.js";
import roleRoutes from "#modules/role/role.routes.js";
import settingsRoutes from "#modules/settings/settings.routes.js";
import supplierRoutes from "#modules/supplier/supplier.routes.js";
import supplierTypeRoutes from "#modules/supplier-type/supplier-type.routes.js";
import userRoutes from "#modules/user/user.routes.js";
import vanStockRequestRoutes from "#modules/van-stock-request/van-stock-request.routes.js";
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
router.use("/dashboard", dashboardRoutes);
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
router.use("/purchase-requests", purchaseRequestRoutes);
router.use("/purchase-orders", purchaseOrderRoutes);
router.use("/goods-in", goodsInRoutes);
router.use("/goods-management", goodsManagementRoutes);
router.use("/inventory", inventoryRoutes);
router.use("/jobs", jobRoutes);
router.use("/departments", departmentRoutes);
router.use("/geo", geoRoutes);
router.use("/job-titles", jobTitleRoutes);
router.use("/email-templates", emailTemplateRoutes);
// Customer master-data (admin/PM) + the read-only customer portal API.
router.use("/customers", customerRoutes);
router.use("/customer", customerPortalRoutes);
// Engineer self-service portal API (staff-only, permission-gated, scoped to the signed-in user).
router.use("/engineer", engineerRoutes);
// Stock assignment receive endpoint + warehouse pending stock view.
router.use("/stock-assignments", stockAssignmentRouter);
router.use("/stock-entries", stockEntryRouter);
router.use("/warehouses", warehousePendingRouter);
// Engineer-to-engineer stock transfers.
router.use("/engineer-transfers", engineerTransferRoutes);
// Field-Engineer → PM additional-kit requests (raise / review / approve / decline).
router.use("/job-kit-requests", jobKitRequestRoutes);
// Non-job engineer van restock/return requests (raise / review / scan-fulfil).
router.use("/van-stock-requests", vanStockRequestRoutes);

export default router;
