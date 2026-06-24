import * as userService from "./user.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt } from "../../utils/request.js";
import type {
  CreateUserInput,
  UpdateMyProfileInput,
  UpdateUserInput,
  UpdateUserStatusInput,
  UploadSignatureInput,
} from "./user.validation.js";

// GET /users  (protected) — paginated. Query: ?search=&status=&roleId=&page=&pageSize=
// Returns { users, total, page, pageSize, totalPages }.
export const listUsers = asyncHandler(async (req, res) => {
  const { search, status, roleId, sort, page, pageSize } = req.query;
  const result = await userService.listUsers({
    search: typeof search === "string" ? search : undefined,
    status: typeof status === "string" ? status : undefined,
    roleId: typeof roleId === "string" ? roleId : undefined,
    sort: typeof sort === "string" ? sort : undefined,
    page: queryInt(page),
    pageSize: queryInt(pageSize),
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

// GET /users/me  (self-service) — the signed-in staff user's own profile.
export const getMyProfile = asyncHandler(async (req, res) => {
  res.json({ user: await userService.getMyProfile(actorFrom(req)) });
});

// PUT /users/me  (self-service) — edit own profile (phone/avatar/address only).
export const updateMyProfile = asyncHandler(async (req, res) => {
  const user = await userService.updateMyProfile(req.body as UpdateMyProfileInput, actorFrom(req));
  res.json({ user });
});

// POST /users/me/signature  (self-service) — upload the signed-in user's signature.
export const uploadMySignature = asyncHandler(async (req, res) => {
  const user = await userService.uploadMySignature(req.body as UploadSignatureInput, actorFrom(req));
  res.json({ user });
});

// DELETE /users/me/signature  (self-service) — clear the signed-in user's signature.
export const removeMySignature = asyncHandler(async (req, res) => {
  const user = await userService.removeMySignature(actorFrom(req));
  res.json({ user });
});
