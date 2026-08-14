import { Router } from "express";

import * as attentionController from "./attention.controller.js";
import { requireAuth } from "../../middleware/auth.middleware.js";

const router = Router();

// Auth only — exactly like /dashboard/summary. There is no single permission that governs "attention":
// the service filters the catalog per item against the actor's own permissions, so a user simply gets
// the counts they are allowed to act on (and an empty payload when that is none).
// Mounted once, on the router — NOT repeated per route. requireAuth is not free: it reads the
// session and then the user/admin record (plus the assigned warehouse ids for a scoped user), so
// applying it twice would pay those lookups twice on what is the most frequently hit endpoint in
// the app (every dashboard mount, every debounced attention:changed, every safety tick).
router.use(requireAuth);
router.get("/", attentionController.getAttention);
router.get("/entities/:dimension", attentionController.getEntityAttention);

export default router;
