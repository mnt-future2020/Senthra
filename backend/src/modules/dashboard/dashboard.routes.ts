import { Router } from "express";

import * as dashboardController from "./dashboard.controller.js";
import { requireAuth } from "../../middleware/auth.middleware.js";

const router = Router();

router.use(requireAuth);

// GET /dashboard/summary — the aggregated, per-section permission-gated Overview payload.
// Auth-only at the route; each section is gated inside the service (missing key = no permission).
router.get("/summary", dashboardController.getSummary);

export default router;
