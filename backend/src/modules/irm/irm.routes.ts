import { Router } from "express";

import * as irmController from "./irm.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createIrmItemSchema, updateIrmItemSchema } from "./irm.validation.js";

const router = Router();

router.use(requireAuth);

// Static route BEFORE the /:id param route. The owner picker is needed by anyone who can
// view/create/edit an IRM item.
router.get(
  "/owner-options",
  requireAnyPermission("irm.view", "irm.create", "irm.edit"),
  irmController.listOwnerOptions,
);

router.get("/", requirePermission("irm.view"), irmController.listIrmItems);
router.get("/:id", requirePermission("irm.view"), irmController.getIrmItem);

router.post(
  "/",
  requirePermission("irm.create"),
  writeLimiter,
  validateBody(createIrmItemSchema),
  irmController.createIrmItem,
);
router.patch(
  "/:id",
  requirePermission("irm.edit"),
  writeLimiter,
  validateBody(updateIrmItemSchema),
  irmController.updateIrmItem,
);
router.delete("/:id", requirePermission("irm.delete"), writeLimiter, irmController.deleteIrmItem);

export default router;
