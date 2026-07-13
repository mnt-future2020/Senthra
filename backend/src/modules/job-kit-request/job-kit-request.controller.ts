import * as kitRequestService from "./job-kit-request.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import { forbidden } from "../../utils/http-error.js";
import type { ApproveKitRequestInput, CreateKitRequestInput, DeclineKitRequestInput, UploadAttachmentInput } from "./job-kit-request.validation.js";

// Collapse a possibly-array query value to its first string (matches the engineer-transfer convention).

// POST /job-kit-requests  (field engineer raises a request for their own job)
export const create = asyncHandler(async (req, res) => {
  const request = await kitRequestService.create(req.body as CreateKitRequestInput, actorFrom(req));
  res.status(201).json({ request });
});

// GET /job-kit-requests/mine  (the signed-in engineer's own requests)
export const listMine = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  const engineerId = actor.id ?? "";
  if (!engineerId) throw forbidden("Could not determine engineer identity.");
  const { status, jobId, search, sort, page, pageSize } = req.query;
  const result = await kitRequestService.listMine(engineerId, {
    status: queryStr(status),
    jobId: queryStr(jobId),
    search: queryStr(search),
    sort: queryStr(sort),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  });
  res.json(result);
});

// GET /job-kit-requests  (PM/planner review queue — all requests)
export const listAll = asyncHandler(async (req, res) => {
  const { status, jobId, search, sort, page, pageSize } = req.query;
  const result = await kitRequestService.listAll({
    status: queryStr(status),
    jobId: queryStr(jobId),
    search: queryStr(search),
    sort: queryStr(sort),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  });
  res.json(result);
});

// GET /job-kit-requests/pending-count  (review-queue badge)
export const pendingCount = asyncHandler(async (req, res) => {
  res.json({ count: await kitRequestService.countPending(queryStr(req.query.jobId)) });
});

// GET /job-kit-requests/item-search?q=  (IRM catalogue search for the FE request composer)
export const itemSearch = asyncHandler(async (req, res) => {
  res.json({ items: await kitRequestService.searchItems(queryStr(req.query.q) ?? "") });
});

// GET /job-kit-requests/:id
export const getOne = asyncHandler(async (req, res) => {
  res.json({ request: await kitRequestService.getOne(param(req, "id"), actorFrom(req)) });
});

// GET /job-kit-requests/:id/eligible-holders  (engineers who hold ALL the request's stock-tracked lines)
export const eligibleHolders = asyncHandler(async (req, res) => {
  res.json({ holders: await kitRequestService.eligibleHolders(param(req, "id")) });
});

// POST /job-kit-requests/:id/approve  (PM/planner)
export const approve = asyncHandler(async (req, res) => {
  res.json({ request: await kitRequestService.approve(param(req, "id"), req.body as ApproveKitRequestInput, actorFrom(req)) });
});

// POST /job-kit-requests/:id/decline  (PM/planner)
export const decline = asyncHandler(async (req, res) => {
  res.json({ request: await kitRequestService.decline(param(req, "id"), req.body as DeclineKitRequestInput, actorFrom(req)) });
});

// POST /job-kit-requests/:id/cancel  (requester, while pending)
export const cancel = asyncHandler(async (req, res) => {
  res.json({ request: await kitRequestService.cancel(param(req, "id"), actorFrom(req)) });
});

// POST /job-kit-requests/attachments  (returns a URL; does NOT create a request)
export const uploadAttachment = asyncHandler(async (req, res) => {
  const { image } = req.body as UploadAttachmentInput;
  res.json(await kitRequestService.uploadAttachment(image));
});
