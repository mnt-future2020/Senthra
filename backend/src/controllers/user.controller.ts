import * as userService from "../services/user.service.js";
import { actorFrom } from "../utils/actor.js";
import { asyncHandler } from "../utils/async-handler.js";
import { param } from "../utils/request.js";
import type {
  CreateUserInput,
  UpdateUserInput,
  UpdateUserStatusInput,
} from "../validations/user.validation.js";

const toNum = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

// GET /users  (protected) — paginated. Query: ?search=&status=&roleId=&page=&pageSize=
// Returns { users, total, page, pageSize, totalPages }.
export const listUsers = asyncHandler(async (req, res) => {
  const { search, status, roleId, page, pageSize } = req.query;
  const result = await userService.listUsers({
    search: typeof search === "string" ? search : undefined,
    status: typeof status === "string" ? status : undefined,
    roleId: typeof roleId === "string" ? roleId : undefined,
    page: toNum(page),
    pageSize: toNum(pageSize),
  });
  res.json(result);
});

// GET /users/:id  (protected)
export const getUser = asyncHandler(async (req, res) => {
  const user = await userService.getUser(param(req, "id"));
  res.json({ user });
});

// POST /users  (protected) — returns the temp password ONCE.
export const createUser = asyncHandler(async (req, res) => {
  const result = await userService.createUser(req.body as CreateUserInput, actorFrom(req));
  res.status(201).json(result);
});

// PUT /users/:id  (protected)
export const updateUser = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(
    param(req, "id"),
    req.body as UpdateUserInput,
    actorFrom(req),
  );
  res.json({ user });
});

// PATCH /users/:id/status  (protected)
export const setUserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body as UpdateUserStatusInput;
  const user = await userService.setUserStatus(param(req, "id"), status, actorFrom(req));
  res.json({ user });
});

// POST /users/:id/resend-invite  (protected) — new temp password + re-send email.
export const resendInvite = asyncHandler(async (req, res) => {
  const result = await userService.resendInvite(param(req, "id"), actorFrom(req));
  res.json(result);
});

// DELETE /users/:id  (protected) — soft delete.
export const deleteUser = asyncHandler(async (req, res) => {
  await userService.deleteUser(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
