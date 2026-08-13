import { asyncHandler } from "../../utils/async-handler.js";
import { actorFrom } from "../../utils/actor.js";
import { badRequest } from "../../utils/http-error.js";

import { isUploadPurpose } from "./upload.catalog.js";
import { createSignature, verifyFinalize } from "./upload.service.js";
import { attachTo, preCheckFor } from "./upload.targets.js";
import type { FinalizeRequestInput, SignatureRequestInput } from "./upload.validation.js";

// POST /uploads/signature — authorise one direct browser upload.
export const requestSignature = asyncHandler(async (req, res) => {
  const body = req.body as SignatureRequestInput;
  const actor = actorFrom(req);
  if (!isUploadPurpose(body.purpose)) throw badRequest("Unknown upload type.");

  // The module's own guard, when this purpose attaches to an existing record. Runs before the file is
  // sent so a full purchase order refuses the upload instead of accepting and then rejecting it.
  const preCheck = preCheckFor(body.purpose);
  const run = preCheck && body.targetId ? () => preCheck(body.targetId!, body.sizeBytes, body.label, actor) : undefined;

  res.json(await createSignature(body, actor, run));
});

// POST /uploads/finalize — accept a completed upload and hand it to the module that owns it.
export const finalize = asyncHandler(async (req, res) => {
  const body = req.body as FinalizeRequestInput;
  const actor = actorFrom(req);
  if (!isUploadPurpose(body.purpose)) throw badRequest("Unknown upload type.");

  // Authorization FIRST, before anything is looked up, so no response can describe a record the caller
  // may not see. For attach purposes this is the module's own guard against the real target.
  const preCheck = preCheckFor(body.purpose);
  if (preCheck) {
    if (!body.targetId) throw badRequest("Select the record to attach this to.");
    await preCheck(body.targetId, 0, body.label, actor);
  }

  const asset = await verifyFinalize(body, actor);
  res.json(await attachTo(body.purpose, body.targetId, asset, body.label, actor));
});
