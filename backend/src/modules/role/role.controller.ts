import * as roleService from "./role.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type { CreateRoleInput, UpdateRoleInput } from "./role.validation.js";

// GET /roles  (protected)
export const listRoles = asyncHandler(async (_req, res) => {
  res.json({ roles: await roleService.listRoles() });
});

// POST /roles  (protected)
export const createRole = asyncHandler(async (req, res) => {
  const role = await roleService.createRole(req.body as CreateRoleInput, actorFrom(req));
  res.status(201).json({ role });
});

// PUT /roles/:id  (protected)
export const updateRole = asyncHandler(async (req, res) => {
  const role = await roleService.updateRole(
    param(req, "id"),
    req.body as UpdateRoleInput,
    actorFrom(req),
  );
  res.json({ role });
});

// DELETE /roles/:id  (protected) — blocked for system roles or roles in use.
export const deleteRole = asyncHandler(async (req, res) => {
  await roleService.deleteRole(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
