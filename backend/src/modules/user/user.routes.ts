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

// User management requires the users.manage permission (the super-admin always
// has it).
router.use(requireAuth, requirePermission("users.manage"));

router.get("/", userController.listUsers);
router.post("/", writeLimiter, validateBody(createUserSchema), userController.createUser);
router.get("/:id", userController.getUser);
router.put("/:id", writeLimiter, validateBody(updateUserSchema), userController.updateUser);
router.patch(
  "/:id/status",
  writeLimiter,
  validateBody(updateUserStatusSchema),
  userController.setUserStatus,
);
router.post("/:id/resend-invite", writeLimiter, userController.resendInvite);
router.delete("/:id", writeLimiter, userController.deleteUser);

export default router;
