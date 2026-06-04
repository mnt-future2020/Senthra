import { Router } from "express";

import * as roleController from "./role.controller.js";
import { requireAdmin, requireAuth } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createRoleSchema, updateRoleSchema } from "./role.validation.js";

const router = Router();

// Role management is super-admin only.
router.use(requireAuth, requireAdmin);

router.get("/", roleController.listRoles);
router.post("/", writeLimiter, validateBody(createRoleSchema), roleController.createRole);
router.put("/:id", writeLimiter, validateBody(updateRoleSchema), roleController.updateRole);
router.delete("/:id", writeLimiter, roleController.deleteRole);

export default router;
