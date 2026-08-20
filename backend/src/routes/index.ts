import { Router } from "express";

import attentionRoutes from "#modules/attention/attention.routes.js";
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
import rentalCategoryRoutes from "#modules/rental-category/rental-category.routes.js";
import rentalItemRoutes from "#modules/rental-item/rental-item.routes.js";
import rentalReceiptRoutes from "#modules/rental-receipt/rental-receipt.routes.js";
import irmTypeRoutes from "#modules/irm-type/irm-type.routes.js";
import jobRoutes, { portalRouter as customerJobRoutes } from "#modules/job/job.routes.js";
import uploadRoutes from "#modules/upload/upload.routes.js";
import jobKitRequestRoutes from "#modules/job-kit-request/job-kit-request.routes.js";
import jobTitleRoutes from "#modules/jobTitle/jobTitle.routes.js";
import notificationRoutes from "#modules/notification/notification.routes.js";
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
// Global pending-work counts (sidebar badges + dashboard strip + module tab counts — one source).
router.use("/attention", attentionRoutes);
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
router.use("/rental-categories", rentalCategoryRoutes);
router.use("/rental-items", rentalItemRoutes);
// Hire deliveries — supplier-owned kit arriving. Deliberately NOT under /goods-in: a GRN writes stock.
router.use("/rental-receipts", rentalReceiptRoutes);
router.use("/purchase-requests", purchaseRequestRoutes);
router.use("/purchase-orders", purchaseOrderRoutes);
router.use("/goods-in", goodsInRoutes);
router.use("/goods-management", goodsManagementRoutes);
router.use("/inventory", inventoryRoutes);
router.use("/jobs", jobRoutes);

// Direct browser upload — signature + finalize. Serves every upload contract, so the per-purpose
// permission lives in the upload catalog rather than on the route.
router.use("/uploads", uploadRoutes);
router.use("/departments", departmentRoutes);
router.use("/geo", geoRoutes);
router.use("/job-titles", jobTitleRoutes);
router.use("/email-templates", emailTemplateRoutes);
// Customer master-data (admin/PM) + the read-only customer portal API.
router.use("/customers", customerRoutes);
// Jobs on the portal live in the JOB module (it owns the model and its repository), so they mount
// as their own sub-path. Declared BEFORE /customer: both prefixes match this URL, and while the
// portal router below happens to have no /jobs route to shadow it, relying on that would make a
// future route added there silently take precedence over this one.
router.use("/customer/jobs", customerJobRoutes);
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

router.use("/notifications", notificationRoutes);

export default router;
