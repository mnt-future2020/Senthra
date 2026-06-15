import { Router } from "express";

import * as irmTypeController from "./irm-type.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createIrmTypeSchema, updateIrmTypeSchema } from "./irm-type.validation.js";

const router = Router();

router.use(requireAuth);

// The type list is read by type-managers AND by the IRM item form's type picker
// (which staff reach via irm.create / irm.edit), so either may read it.
router.get(
  "/",
  requireAnyPermission("irm_types.view", "irm.create", "irm.edit"),
  irmTypeController.listIrmTypes,
);
router.get(
  "/:id",
  requireAnyPermission("irm_types.view", "irm_types.edit"),
  irmTypeController.getIrmType,
);

router.post(
  "/",
  requirePermission("irm_types.create"),
  writeLimiter,
  validateBody(createIrmTypeSchema),
  irmTypeController.createIrmType,
);
router.put(
  "/:id",
  requirePermission("irm_types.edit"),
  writeLimiter,
  validateBody(updateIrmTypeSchema),
  irmTypeController.updateIrmType,
);
router.delete(
  "/:id",
  requirePermission("irm_types.delete"),
  writeLimiter,
  irmTypeController.deleteIrmType,
);

export default router;
