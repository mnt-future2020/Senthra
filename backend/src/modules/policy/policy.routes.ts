import { Router } from "express";

import * as policyController from "./policy.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { discardDraftSchema, previewSchema, publishSchema, saveDraftSchema } from "./policy.validation.js";

const router = Router();

// PUBLIC — the published privacy policy, for the /privacy page. Mounted BEFORE `requireAuth` for the
// same reason `/settings/branding` is: a data subject must be able to read it without an account.
//
// It is the ONE route here outside the auth wall, and it resolves through PolicyVersion, so no
// unpublished text is reachable from it.
router.get("/privacy", policyController.getPublicPolicy);

// Everything below is staff-only, and each action carries its own permission.
router.use(requireAuth);

const canView = requirePermission("policy.view");
const canEdit = requirePermission("policy.edit");
const canPublish = requirePermission("policy.publish");

router.get("/privacy/admin", canView, policyController.getPolicyForAdmin);
router.post("/privacy/preview", canView, validateBody(previewSchema), policyController.previewPolicy);

// Reading ONE published version, body included. `canView` — the same right that lists the history it
// belongs to. Registered after the literal `/privacy/admin` route so the parameter cannot shadow it.
router.get("/privacy/versions/:id", canView, policyController.getPublishedVersion);

router.put("/privacy/draft", canEdit, writeLimiter, validateBody(saveDraftSchema), policyController.saveDraft);

// Discard is a draft write: `canEdit`, the write limiter, and the revision guard in its body schema.
// Deliberately NOT `canPublish` — undoing your own working copy is not an act of publication.
router.post("/privacy/draft/discard", canEdit, writeLimiter, validateBody(discardDraftSchema), policyController.discardDraft);

// `canPublish`, NOT `canEdit`. Holding the edit permission must never be enough to put a document in
// front of the public — that is the whole point of the split, and it is enforced here rather than
// anywhere it could be forgotten.
router.post("/privacy/publish", canPublish, writeLimiter, validateBody(publishSchema), policyController.publishPolicy);

export default router;
