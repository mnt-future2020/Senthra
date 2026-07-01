import type { Request } from "express";

import * as engineerService from "./engineer.service.js";
import type { CompleteJobInput, RejectJobInput } from "#modules/job/job.validation.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { forbidden } from "../../utils/http-error.js";
import { param } from "../../utils/request.js";

// The engineer always reads THEIR OWN data — the scoping id is the authenticated principal's id,
// never a route param (mirrors the customer portal's `customerId(req)` safety, keyed on User.id).
function ownId(req: Request): string {
  const id = actorFrom(req).id;
  if (!id) throw forbidden("Engineer access required.");
  return id;
}

// GET /engineer/overview — dashboard: My Stock summary + My Dispatches count + Recent Activity.
export const getOwnOverview = asyncHandler(async (req, res) => {
  res.json({ overview: await engineerService.getOwnOverview(ownId(req)) });
});

// GET /engineer/stock — the engineer's own held IRM stock.
export const getOwnStock = asyncHandler(async (req, res) => {
  res.json({ stock: await engineerService.getOwnStock(ownId(req)) });
});

// GET /engineer/jobs — jobs assigned to the signed-in engineer.
export const listOwnJobs = asyncHandler(async (req, res) => {
  res.json({ jobs: await engineerService.getOwnJobs(ownId(req)) });
});

// GET /engineer/jobs/:id — one of the engineer's own jobs (scoped; :id is the JOB id).
export const getOwnJob = asyncHandler(async (req, res) => {
  res.json({ job: await engineerService.getOwnJob(ownId(req), param(req, "id")) });
});

// POST /engineer/jobs/:id/accept — accept an assigned job the engineer owns.
export const acceptOwnJob = asyncHandler(async (req, res) => {
  res.json({ job: await engineerService.acceptOwnJob(ownId(req), param(req, "id"), actorFrom(req)) });
});

// POST /engineer/jobs/:id/reject — decline an assigned job the engineer owns (with an optional reason).
export const rejectOwnJob = asyncHandler(async (req, res) => {
  const { reason } = req.body as RejectJobInput;
  res.json({ job: await engineerService.rejectOwnJob(ownId(req), param(req, "id"), reason, actorFrom(req)) });
});

// POST /engineer/jobs/:id/start — mark an accepted job in-progress (start work on site).
export const startOwnJob = asyncHandler(async (req, res) => {
  res.json({ job: await engineerService.startOwnJob(ownId(req), param(req, "id"), actorFrom(req)) });
});

// POST /engineer/jobs/:id/complete — mark a job completed, declaring used quantities + a work summary.
export const completeOwnJob = asyncHandler(async (req, res) => {
  res.json({ job: await engineerService.completeOwnJob(ownId(req), param(req, "id"), req.body as CompleteJobInput, actorFrom(req)) });
});

// GET /engineer/customer-stock — customer consignment stock the engineer currently holds (no pricing).
export const getOwnCustomerStock = asyncHandler(async (req, res) => {
  res.json({ customerStock: await engineerService.getOwnCustomerStock(ownId(req)) });
});

export const getOwnMiscStock = asyncHandler(async (req, res) => {
  res.json({ misc: await engineerService.getOwnMiscStock(ownId(req)) });
});

// GET /engineer/movements — the engineer's own stock movement history (van company + customer ledgers,
// cursor-paginated). Scoped to the signed-in engineer; ?cursor&limit&dateFrom&dateTo&ownership&type.
export const getOwnMovements = asyncHandler(async (req, res) => {
  res.json(await engineerService.getOwnMovements(ownId(req), req.query as Record<string, unknown>));
});
