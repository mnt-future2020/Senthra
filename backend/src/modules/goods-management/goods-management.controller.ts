import * as service from "./goods-management.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type { PostMovementInput, ScanLookupInput } from "./goods-management.validation.js";

export const scanLookup = asyncHandler(async (req, res) => {
  res.json({ match: await service.scanLookup(req.body as ScanLookupInput, actorFrom(req)) });
});

export const postIssue = asyncHandler(async (req, res) => {
  res.status(201).json({ movement: await service.postIssue(param(req, "jobId"), req.body as PostMovementInput, actorFrom(req)) });
});
