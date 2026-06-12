import { Router } from "express";

import auditRoutes from "#modules/audit/audit.routes.js";
import authRoutes from "#modules/auth/auth.routes.js";
import categoryRoutes from "#modules/category/category.routes.js";
import { adminRouter as customerRoutes, portalRouter as customerPortalRoutes } from "#modules/customer/customer.routes.js";
import departmentRoutes from "#modules/department/department.routes.js";
import emailTemplateRoutes from "#modules/email/emailTemplate.routes.js";
import jobTitleRoutes from "#modules/jobTitle/jobTitle.routes.js";
import roleRoutes from "#modules/role/role.routes.js";
import settingsRoutes from "#modules/settings/settings.routes.js";
import userRoutes from "#modules/user/user.routes.js";

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
router.use("/departments", departmentRoutes);
router.use("/job-titles", jobTitleRoutes);
router.use("/email-templates", emailTemplateRoutes);
// Customer master-data (admin/PM) + the read-only customer portal API.
router.use("/customers", customerRoutes);
router.use("/customer", customerPortalRoutes);

export default router;
