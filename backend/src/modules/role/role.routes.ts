import { Router } from "express";

import * as roleController from "./role.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createRoleSchema, updateRoleSchema } from "./role.validation.js";

const router = Router();

router.use(requireAuth);

// The roles list + permission catalog are read both by role-managers and by the
// user form's role picker, so any of these capabilities can read them.
router.get("/", requireAnyPermission("roles.view", "users.create", "users.edit"), roleController.listRoles);
router.get("/permissions", requireAnyPermission("roles.view", "roles.create", "roles.edit"), roleController.listPermissions);
router.get("/:id", requireAnyPermission("roles.view", "roles.edit"), roleController.getRole);

// Role mutations are delegatable (roles.create / roles.edit / roles.delete) but
// escalation-guarded in role.service: a delegate can't grant permissions it lacks,
// grant full access ("*"), or touch a system role. The super-admin always passes.
router.post("/", requirePermission("roles.create"), writeLimiter, validateBody(createRoleSchema), roleController.createRole);
router.put("/:id", requirePermission("roles.edit"), writeLimiter, validateBody(updateRoleSchema), roleController.updateRole);
router.delete("/:id", requirePermission("roles.delete"), writeLimiter, roleController.deleteRole);

export default router;
