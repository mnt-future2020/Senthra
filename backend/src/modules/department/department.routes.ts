import { Router } from "express";

import * as departmentController from "./department.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  createDepartmentSchema,
  updateDepartmentSchema,
} from "./department.validation.js";

const router = Router();

router.use(requireAuth);

// Departments are employee master-data, so they reuse the USER permissions rather
// than a dedicated group. The list feeds the user form's picker as well as the
// manage screen, so anyone who can view or manage users may read it.
router.get(
  "/",
  requireAnyPermission("users.view", "users.create", "users.edit"),
  departmentController.listDepartments,
);

// Adding a department is part of creating/editing staff (it can be done inline from
// the user form), so users.create OR users.edit may create one. Renaming needs edit;
// removing needs delete.
router.post(
  "/",
  requireAnyPermission("users.create", "users.edit"),
  writeLimiter,
  validateBody(createDepartmentSchema),
  departmentController.createDepartment,
);
router.put(
  "/:id",
  requirePermission("users.edit"),
  writeLimiter,
  validateBody(updateDepartmentSchema),
  departmentController.updateDepartment,
);
router.delete(
  "/:id",
  requirePermission("users.delete"),
  writeLimiter,
  departmentController.deleteDepartment,
);

export default router;
