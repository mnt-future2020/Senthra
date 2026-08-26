import type { Request } from "express";

import * as jobService from "./job.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendCsv } from "../../utils/csv-response.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import { unauthorized } from "../../utils/http-error.js";
import type { AssignJobInput, CancelJobInput, CreateJobInput, UpdateJobInput } from "./job.validation.js";


// GET /jobs?search=&status=&customer=&engineer=&project=&sort=&page=&pageSize=
// The list's filters, parsed once. Shared with the CSV export so the download is exactly the rows
// on screen — a second copy is a second place for a filter to be forgotten, and the resulting file
// gives no sign that it is wider or narrower than the list it came from.
function listParamsFrom(req: Request): jobService.ListJobsParams {
  const { search, status, customer, engineer, project, sort, page, pageSize } = req.query;
  return {
    search: queryStr(search),
    status: queryStr(status),
    customer: queryStr(customer),
    engineer: queryStr(engineer),
    project: queryStr(project),
    sort: queryStr(sort),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  };
}

export const listJobs = asyncHandler(async (req, res) => {
  res.json(await jobService.listJobs(listParamsFrom(req), actorFrom(req)));
});

// GET /jobs/export.csv — the same filtered list as a download (paging ignored).
export const exportJobsCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "jobs", await jobService.exportJobsCsv(listParamsFrom(req), actorFrom(req)));
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

// --- customer portal --------------------------------------------------------
// The scope comes from the SESSION, never the query string. requireCustomer on the route has
// already rejected anyone who isn't a customer; this re-reads the principal because that is what
// makes the customerId a fact TypeScript can see, and because a route mounted without the
// middleware must fail closed rather than serve every job in the system.
function customerId(req: import("express").Request): string {
  if (req.principal?.type !== "customer") throw unauthorized("Customer access required.");
  return req.principal.customerId;
}

// GET /customer/jobs?q=&status=&sort=&page=&pageSize=
export const getOwnJobs = asyncHandler(async (req, res) => {
  res.json(
    await jobService.listJobsForCustomer(customerId(req), {
      search: queryStr(req.query.q),
      status: queryStr(req.query.status),
      sort: queryStr(req.query.sort),
      page: queryInt(req.query.page),
      pageSize: queryInt(req.query.pageSize),
    }),
  );
});

// GET /customer/jobs/export.csv — the customer's own jobs, honouring the list's filters.
export const exportOwnJobsCsv = asyncHandler(async (req, res) => {
  sendCsv(
    res,
    "my-jobs",
    await jobService.exportOwnJobsCsv(customerId(req), {
      search: queryStr(req.query.q),
      status: queryStr(req.query.status),
      sort: queryStr(req.query.sort),
    }),
  );
});

// GET /customer/jobs/:id
export const getOwnJob = asyncHandler(async (req, res) => {
  res.json({ job: await jobService.getJobForCustomer(customerId(req), param(req, "id")) });
});
