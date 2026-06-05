import { Router } from "express";

import * as roleController from "./role.controller.js";
import {
  requireAdmin,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createRoleSchema, updateRoleSchema } from "./role.validation.js";

const router = Router();

router.use(requireAuth);

// Reading the roles list (e.g. to populate the user role dropdown) needs
// users.manage; the super-admin always passes.
router.get("/", requirePermission("users.manage"), roleController.listRoles);

// The permission catalog + every role mutation are super-admin only — role and
// permission configuration is never delegated.
router.get("/permissions", requireAdmin, roleController.listPermissions);
router.post("/", requireAdmin, writeLimiter, validateBody(createRoleSchema), roleController.createRole);
router.put("/:id", requireAdmin, writeLimiter, validateBody(updateRoleSchema), roleController.updateRole);
router.delete("/:id", requireAdmin, writeLimiter, roleController.deleteRole);

export default router;
