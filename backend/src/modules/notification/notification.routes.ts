import { Router } from "express";

import * as notificationController from "./notification.controller.js";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { registerDeviceSchema, unregisterDeviceSchema } from "./notification.validation.js";

// Push-notification device registration. Any authenticated principal may register
// the device they're signed in on; the mobile engineer app is the only caller today.
const router = Router();

router.use(requireAuth);

router.post("/device-token", validateBody(registerDeviceSchema), notificationController.registerDevice);
router.delete("/device-token", validateBody(unregisterDeviceSchema), notificationController.unregisterDevice);

export default router;
