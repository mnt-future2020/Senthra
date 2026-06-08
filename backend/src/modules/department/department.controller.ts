import * as departmentService from "./department.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type {
  CreateDepartmentInput,
  UpdateDepartmentInput,
} from "./department.validation.js";

// GET /departments  (protected) — the full department list for the picker + manage screen.
export const listDepartments = asyncHandler(async (_req, res) => {
  res.json({ departments: await departmentService.listDepartments() });
});

// POST /departments  (protected)
export const createDepartment = asyncHandler(async (req, res) => {
  const department = await departmentService.createDepartment(
    req.body as CreateDepartmentInput,
    actorFrom(req),
  );
  res.status(201).json({ department });
});

// PUT /departments/:id  (protected) — rename.
export const updateDepartment = asyncHandler(async (req, res) => {
  const department = await departmentService.updateDepartment(
    param(req, "id"),
    req.body as UpdateDepartmentInput,
    actorFrom(req),
  );
  res.json({ department });
});

// DELETE /departments/:id  (protected) — removes it from the master list (users keep
// their stored department name).
export const deleteDepartment = asyncHandler(async (req, res) => {
  await departmentService.deleteDepartment(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
