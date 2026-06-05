import { Router } from "express";

import * as userController from "./user.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createUserSchema,
  updateUserSchema,
  updateUserStatusSchema,
} from "./user.validation.js";

const router = Router();

// All user routes require auth; each method then requires its own granular
// permission (the super-admin always passes).
router.use(requireAuth);

router.get("/", requirePermission("users.view"), userController.listUsers);
router.post("/", requirePermission("users.create"), writeLimiter, validateBody(createUserSchema), userController.createUser);
router.get("/:id", requirePermission("users.view"), userController.getUser);
router.put("/:id", requirePermission("users.edit"), writeLimiter, validateBody(updateUserSchema), userController.updateUser);
router.patch(
  "/:id/status",
  requirePermission("users.edit"),
  writeLimiter,
  validateBody(updateUserStatusSchema),
  userController.setUserStatus,
);
router.post("/:id/resend-invite", requirePermission("users.edit"), writeLimiter, userController.resendInvite);
router.delete("/:id", requirePermission("users.delete"), writeLimiter, userController.deleteUser);

export default router;
