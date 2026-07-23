import type { Request } from "express";

import * as notificationService from "./notification.service.js";
import type { RegisterDeviceInput, UnregisterDeviceInput } from "./notification.validation.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { forbidden } from "../../utils/http-error.js";

// The device belongs to the authenticated principal — keyed on the principal id,
// never a body/param, so one user can never register a token against another.
function principalId(req: Request): string {
  const id = actorFrom(req).id;
  if (!id) throw forbidden("Authentication required.");
  return id;
}

// POST /notifications/device-token — register (or move) this device's FCM token.
export const registerDevice = asyncHandler(async (req, res) => {
  const { token, platform } = req.body as RegisterDeviceInput;
  await notificationService.registerToken(principalId(req), token, platform);
  res.json({ ok: true });
});

// DELETE /notifications/device-token — drop this device's token (called on logout).
export const unregisterDevice = asyncHandler(async (req, res) => {
  const { token } = req.body as UnregisterDeviceInput;
  await notificationService.unregisterToken(token);
  res.json({ ok: true });
});
