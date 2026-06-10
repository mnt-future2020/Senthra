import { Router } from "express";

import * as auditController from "./audit.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { exportLimiter } from "../../middleware/rateLimit.middleware.js";

const router = Router();

router.use(requireAuth);

// The audit trail is read-only over the API. All three endpoints require the
// audit.view permission (the super-admin holds it implicitly via "*").
router.get("/", requirePermission("audit.view"), auditController.listAuditLogs);
router.get("/facets", requirePermission("audit.view"), auditController.listFacets);
router.get(
  "/export.csv",
  requirePermission("audit.view"),
  exportLimiter,
  auditController.exportAuditCsv,
);

export default router;
