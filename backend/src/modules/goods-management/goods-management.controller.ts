import * as service from "./goods-management.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type { CloseReconcileInput, PostMovementInput, ScanLookupInput, UploadDamagePhotoInput } from "./goods-management.validation.js";
import { badRequest } from "../../utils/http-error.js";

export const scanLookup = asyncHandler(async (req, res) => {
  res.json({ match: await service.scanLookup(req.body as ScanLookupInput, actorFrom(req)) });
});

export const postIssue = asyncHandler(async (req, res) => {
  res.status(201).json({ movement: await service.postIssue(param(req, "jobId"), req.body as PostMovementInput, actorFrom(req)) });
});

export const postReturn = asyncHandler(async (req, res) => {
  res.status(201).json({ movement: await service.postReturn(param(req, "jobId"), req.body as PostMovementInput, actorFrom(req)) });
});

export const listQueue = asyncHandler(async (req, res) => {
  res.json({ queue: await service.listQueue(actorFrom(req)) });
});

export const getJobGoods = asyncHandler(async (req, res) => {
  res.json(await service.getJobGoods(param(req, "jobId"), actorFrom(req)));
});

export const closeReconcile = asyncHandler(async (req, res) => {
  res.json(await service.closeReconcile(param(req, "jobId"), req.body as CloseReconcileInput, actorFrom(req)));
});

export const listDamaged = asyncHandler(async (req, res) => {
  const warehouseId = req.query["warehouseId"] as string | undefined;
  const customerId = req.query["customerId"] as string | undefined;
  res.json({ damaged: await service.listDamaged({ warehouseId, customerId }, actorFrom(req)) });
});

export const listOverdue = asyncHandler(async (req, res) => {
  const rawDays = req.query["days"];
  const days = rawDays !== undefined ? Number(rawDays) : 14;
  if (!Number.isFinite(days) || days < 1) throw badRequest("days must be a positive integer.");
  res.json({ overdue: await service.listOverdue(actorFrom(req), days) });
});

// POST /goods-management/damage-photo — upload a damage photo data URI to Cloudinary; returns { url }.
export const uploadDamagePhoto = asyncHandler(async (req, res) => {
  const { image } = req.body as UploadDamagePhotoInput;
  const result = await service.uploadDamagePhoto(image);
  res.json(result);
});
