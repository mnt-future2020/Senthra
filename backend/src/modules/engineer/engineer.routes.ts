import { Router } from "express";

import * as engineerController from "./engineer.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";

// The engineer self-service portal API. Staff-only (permission-gated, like every other staff route);
// every handler scopes to the signed-in user's own id. Read-only in Phase 1.
const router = Router();

router.use(requireAuth);

router.get("/overview", requirePermission("engineer.dashboard.view"), engineerController.getOwnOverview);
router.get("/stock", requirePermission("engineer.inventory.view"), engineerController.getOwnStock);

export default router;
