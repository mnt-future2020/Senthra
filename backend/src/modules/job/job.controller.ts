import * as jobService from "./job.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import type { AssignJobInput, CancelJobInput, CreateJobInput, UpdateJobInput } from "./job.validation.js";


// GET /jobs?search=&status=&customer=&engineer=&project=&sort=&page=&pageSize=
export const listJobs = asyncHandler(async (req, res) => {
  const { search, status, customer, engineer, project, sort, page, pageSize } = req.query;
  res.json(
    await jobService.listJobs(
      {
        search: queryStr(search),
        status: queryStr(status),
        customer: queryStr(customer),
        engineer: queryStr(engineer),
        project: queryStr(project),
        sort: queryStr(sort),
        page: queryInt(page),
        pageSize: queryInt(pageSize),
      },
      actorFrom(req),
    ),
  );
});

// GET /jobs/:idOrCode  (id or job number)
export const getJob = asyncHandler(async (req, res) => {
  res.json({ job: await jobService.getJob(param(req, "idOrCode"), actorFrom(req)) });
});

// POST /jobs
export const createJob = asyncHandler(async (req, res) => {
  const job = await jobService.createJob(req.body as CreateJobInput, actorFrom(req));
  res.status(201).json({ job });
});

// PATCH /jobs/:id
export const updateJob = asyncHandler(async (req, res) => {
  res.json({ job: await jobService.updateJob(param(req, "id"), req.body as UpdateJobInput, actorFrom(req)) });
});

// DELETE /jobs/:id  (draft or cancelled only)
export const deleteJob = asyncHandler(async (req, res) => {
  await jobService.deleteJob(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});

// --- workflow transitions (state machine enforced in the service) -----------
export const assignJob = asyncHandler(async (req, res) => {
  const { engineerId } = req.body as AssignJobInput;
  res.json({ job: await jobService.assignJob(param(req, "id"), engineerId, actorFrom(req)) });
});
export const cancelJob = asyncHandler(async (req, res) => {
  const { reason } = req.body as CancelJobInput;
  res.json({ job: await jobService.cancelJob(param(req, "id"), reason, actorFrom(req)) });
});
