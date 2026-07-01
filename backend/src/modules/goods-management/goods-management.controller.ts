import * as service from "./goods-management.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt } from "../../utils/request.js";
import type { CloseReconcileInput, PostMovementInput, RestoreDamagedInput, ScanLookupInput, UploadDamagePhotoInput } from "./goods-management.validation.js";
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
  const warehouseId = (req.query["warehouseId"] as string | undefined)?.trim();
  if (!warehouseId) throw badRequest("warehouseId is required.");
  res.json(
    await service.listQueue(
      {
        warehouseId,
        status: (req.query["status"] as string | undefined)?.trim() || undefined,
        search: (req.query["search"] as string | undefined) ?? undefined,
        page: queryInt(req.query["page"]),
        pageSize: queryInt(req.query["pageSize"]),
      },
      actorFrom(req),
    ),
  );
});

export const getJobGoods = asyncHandler(async (req, res) => {
  res.json(await service.getJobGoods(param(req, "jobId"), actorFrom(req)));
});

// Open demand across active jobs (planned-but-not-issued) — the planner uses it to show TRUE free
// stock per item+warehouse. excludeJobId drops the job currently being edited.
export const getDemand = asyncHandler(async (req, res) => {
  const excludeJobId = (req.query["excludeJobId"] as string | undefined)?.trim() || undefined;
  res.json({ demand: [...(await service.getOpenDemand(excludeJobId)).values()] });
});

// Demand board for one warehouse: on-hand vs total planned per item, shortfalls first.
export const getWarehouseDemand = asyncHandler(async (req, res) => {
  res.json({ rows: await service.getWarehouseDemand(param(req, "warehouseId")) });
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

// POST /goods-management/damaged/restore — restore damaged units back to usable stock.
export const restoreDamaged = asyncHandler(async (req, res) => {
  const result = await service.restoreDamaged(req.body as RestoreDamagedInput, actorFrom(req));
  res.status(201).json(result);
});
