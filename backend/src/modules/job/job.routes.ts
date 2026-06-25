import { Router } from "express";

import * as jobController from "./job.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { assignJobSchema, cancelJobSchema, createJobSchema, updateJobSchema } from "./job.validation.js";

const router = Router();

router.use(requireAuth);

router.get("/", requirePermission("jobs.view"), jobController.listJobs);
router.get("/:idOrCode", requirePermission("jobs.view"), jobController.getJob);

router.post("/", requirePermission("jobs.create"), writeLimiter, validateBody(createJobSchema), jobController.createJob);
router.patch("/:id", requirePermission("jobs.edit"), writeLimiter, validateBody(updateJobSchema), jobController.updateJob);
router.delete("/:id", requirePermission("jobs.delete"), writeLimiter, jobController.deleteJob);

// --- workflow transitions (state machine enforced in the service) -----------
router.post("/:id/assign", requirePermission("jobs.assign"), writeLimiter, validateBody(assignJobSchema), jobController.assignJob);
router.post("/:id/cancel", requirePermission("jobs.cancel"), writeLimiter, validateBody(cancelJobSchema), jobController.cancelJob);

export default router;
