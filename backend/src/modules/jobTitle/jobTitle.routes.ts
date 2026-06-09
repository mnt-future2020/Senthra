import { Router } from "express";

import * as jobTitleController from "./jobTitle.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createJobTitleSchema,
  updateJobTitleSchema,
} from "./jobTitle.validation.js";

const router = Router();

router.use(requireAuth);

// Job titles are employee master-data, reusing the USER permissions (same model as
// departments). The list feeds the user form's picker as well as the manage screen.
router.get(
  "/",
  requireAnyPermission("users.view", "users.create", "users.edit"),
  jobTitleController.listJobTitles,
);
router.post(
  "/",
  requireAnyPermission("users.create", "users.edit"),
  writeLimiter,
  validateBody(createJobTitleSchema),
  jobTitleController.createJobTitle,
);
router.put(
  "/:id",
  requirePermission("users.edit"),
  writeLimiter,
  validateBody(updateJobTitleSchema),
  jobTitleController.updateJobTitle,
);
router.delete(
  "/:id",
  requirePermission("users.delete"),
  writeLimiter,
  jobTitleController.deleteJobTitle,
);

export default router;
