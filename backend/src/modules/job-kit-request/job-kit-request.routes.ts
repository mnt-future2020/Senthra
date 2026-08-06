import { Router } from "express";

import * as ctrl from "./job-kit-request.controller.js";
import { requireAuth, requirePermission, requireAnyPermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createKitRequestSchema, approveKitRequestSchema, declineKitRequestSchema, uploadAttachmentSchema } from "./job-kit-request.validation.js";

// FE→PM additional-kit requests. Field engineers (engineer.jobs.request_kit) raise + cancel their own;
// PMs/planners (jobs.kit_request.review) review the queue + approve/decline.
const router = Router();

router.use(requireAuth);

// ---- Engineer self-service (own requests) ----------------------------------------------------
// GET /job-kit-requests/mine?status=&jobId=&sort=&page=&pageSize=
router.get("/mine", requirePermission("engineer.jobs.request_kit"), ctrl.listMine);
// GET /job-kit-requests/item-search?q=&jobId=  (composer search: IRM catalogue + the job's own customer stock; static before /:id)
router.get("/item-search", requirePermission("engineer.jobs.request_kit"), ctrl.itemSearch);
// GET /job-kit-requests/item-availability?jobId=&irm=&cse=  (composer steppers; static before /:id)
router.get("/item-availability", requirePermission("engineer.jobs.request_kit"), ctrl.itemAvailability);

// ---- PM/planner review queue -----------------------------------------------------------------
// GET /job-kit-requests/pending-count?jobId=
router.get("/pending-count", requirePermission("jobs.kit_request.review"), ctrl.pendingCount);
// GET /job-kit-requests?status=&jobId=&search=&sort=&page=&pageSize=
router.get("/", requirePermission("jobs.kit_request.review"), ctrl.listAll);

// ---- Create a request (field engineer, for their own job) ------------------------------------
// POST /job-kit-requests
router.post("/", requirePermission("engineer.jobs.request_kit"), writeLimiter, validateBody(createKitRequestSchema), ctrl.create);

// ---- Upload attachment (returns a URL; does NOT create a request) ----------------------------
// POST /job-kit-requests/attachments
router.post("/attachments", requirePermission("engineer.jobs.request_kit"), writeLimiter, validateBody(uploadAttachmentSchema), ctrl.uploadAttachment);

// ---- Single request detail (reviewer OR the requester — service scopes) ----------------------
// GET /job-kit-requests/:id
router.get("/:id", requireAnyPermission("engineer.jobs.request_kit", "jobs.kit_request.review"), ctrl.getOne);
// GET /job-kit-requests/:id/line-holders  (per-line transfer source picker — reviewer only)
router.get("/:id/line-holders", requirePermission("jobs.kit_request.review"), ctrl.lineHolders);

// ---- State transitions -----------------------------------------------------------------------
// POST /job-kit-requests/:id/approve  (PM/planner — grows the kit + opens fulfilment)
router.post("/:id/approve", requirePermission("jobs.kit_request.review"), writeLimiter, validateBody(approveKitRequestSchema), ctrl.approve);
// POST /job-kit-requests/:id/decline  (PM/planner)
router.post("/:id/decline", requirePermission("jobs.kit_request.review"), writeLimiter, validateBody(declineKitRequestSchema), ctrl.decline);
// POST /job-kit-requests/:id/cancel  (requester, while pending)
router.post("/:id/cancel", requirePermission("engineer.jobs.request_kit"), writeLimiter, ctrl.cancel);

export default router;
