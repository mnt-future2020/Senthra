import { Router } from "express";

import authRoutes from "#modules/auth/auth.routes.js";
import departmentRoutes from "#modules/department/department.routes.js";
import emailTemplateRoutes from "#modules/email/emailTemplate.routes.js";
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
router.use("/settings", settingsRoutes);
router.use("/users", userRoutes);
router.use("/roles", roleRoutes);
router.use("/departments", departmentRoutes);
router.use("/email-templates", emailTemplateRoutes);

export default router;
