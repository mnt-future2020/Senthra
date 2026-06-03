import { Router } from "express";

import authRoutes from "./auth.routes.js";
import settingsRoutes from "./settings.routes.js";

const router = Router();

// Health check
router.get("/", (_req, res) => {
  res.json({ status: "ok", service: "backend" });
});

// Feature routes
router.use("/auth", authRoutes);
router.use("/settings", settingsRoutes);

export default router;
