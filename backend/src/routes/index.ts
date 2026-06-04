import { Router } from "express";

import authRoutes from "./auth.routes.js";
import emailTemplateRoutes from "./emailTemplate.routes.js";
import roleRoutes from "./role.routes.js";
import settingsRoutes from "./settings.routes.js";
import userRoutes from "./user.routes.js";

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
router.use("/email-templates", emailTemplateRoutes);

export default router;
