import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";

import * as controller from "./upload.controller.js";
import { finalizeRequestSchema, signatureRequestSchema } from "./upload.validation.js";

// Direct browser upload. No file bytes pass through here — only the authorisation to send one, and
// the verification of what arrived. Per-purpose permissions are enforced in the service against the
// upload catalog, because one route serves every upload contract.
const router = Router();
router.use(requireAuth);

router.post("/signature", writeLimiter, validateBody(signatureRequestSchema), controller.requestSignature);
router.post("/finalize", writeLimiter, validateBody(finalizeRequestSchema), controller.finalize);

export default router;
