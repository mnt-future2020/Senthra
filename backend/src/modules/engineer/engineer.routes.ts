import { Router } from "express";

import * as engineerController from "./engineer.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { completeJobSchema, rejectJobSchema } from "#modules/job/job.validation.js";

// The engineer self-service portal API. Staff-only (permission-gated, like every other staff route);
// every handler scopes to the signed-in user's own id. Read-only in Phase 1.
const router = Router();

router.use(requireAuth);

router.get("/overview", requirePermission("engineer.dashboard.view"), engineerController.getOwnOverview);
router.get("/stock", requirePermission("engineer.inventory.view"), engineerController.getOwnStock);

// Jobs assigned to the signed-in engineer (scoped to ownId; the :id is the JOB id, never the engineer id).
router.get("/jobs", requirePermission("engineer.jobs.view"), engineerController.listOwnJobs);
router.get("/jobs/:id", requirePermission("engineer.jobs.view"), engineerController.getOwnJob);
router.post("/jobs/:id/accept", requirePermission("engineer.jobs.accept"), writeLimiter, engineerController.acceptOwnJob);
router.post("/jobs/:id/reject", requirePermission("engineer.jobs.reject"), writeLimiter, validateBody(rejectJobSchema), engineerController.rejectOwnJob);
router.post("/jobs/:id/start", requirePermission("engineer.jobs.start"), writeLimiter, engineerController.startOwnJob);
router.post("/jobs/:id/complete", requirePermission("engineer.jobs.complete"), writeLimiter, validateBody(completeJobSchema), engineerController.completeOwnJob);
router.get("/customer-stock", requirePermission("engineer.inventory.view"), engineerController.getOwnCustomerStock);

export default router;
