import * as policyService from "./policy.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { actorFrom } from "../../utils/actor.js";
import type { PreviewInput, PublishInput, SaveDraftInput } from "./policy.validation.js";

// GET /policies/privacy  (PUBLIC) — the published policy, or an explicit "nothing published".
//
// The only unauthenticated route in this module. It returns `{ policy: null }` rather than a 404 so
// the page can distinguish "no policy has been published" from "the request failed", and show the
// right thing for each. It cannot return draft content: the service reads the version row only.
export const getPublicPolicy = asyncHandler(async (_req, res) => {
  res.json({ policy: await policyService.getPublishedPolicy() });
});

// GET /policies/privacy/admin  (policy.view) — draft, published version and history.
export const getPolicyForAdmin = asyncHandler(async (_req, res) => {
  res.json({ policy: await policyService.getPolicyForAdmin() });
});

// POST /policies/privacy/preview  (policy.view) — render unsaved editor content. Writes nothing.
export const previewPolicy = asyncHandler(async (req, res) => {
  const { body } = req.body as PreviewInput;
  res.json({ blocks: policyService.previewBody(body) });
});

// PUT /policies/privacy/draft  (policy.edit) — save the working copy.
export const saveDraft = asyncHandler(async (req, res) => {
  const { body, expectedRevision } = req.body as SaveDraftInput;
  const policy = await policyService.saveDraft(body, expectedRevision, actorFrom(req));
  res.json({ policy });
});

// POST /policies/privacy/publish  (policy.publish) — make the draft the live policy.
//
// A SEPARATE permission from the draft save above, and that separation is the control this module
// exists for: whoever writes the policy need not be whoever approves it going public.
export const publishPolicy = asyncHandler(async (req, res) => {
  const { expectedRevision } = req.body as PublishInput;
  const policy = await policyService.publishDraft(expectedRevision, actorFrom(req));
  res.json({ policy });
});
