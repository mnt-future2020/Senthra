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
  const { search, status, customer, engineer, project, site, priority, dueFrom, dueTo, createdFrom, createdTo, sort, page, pageSize } =
    req.query;
  return {
    search: queryStr(search),
    status: queryStr(status),
    customer: queryStr(customer),
    engineer: queryStr(engineer),
    project: queryStr(project),
    site: queryStr(site),
    priority: queryStr(priority),
    dueFrom: queryStr(dueFrom),
    dueTo: queryStr(dueTo),
    createdFrom: queryStr(createdFrom),
    createdTo: queryStr(createdTo),
    sort: queryStr(sort),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  };
}

export const listJobs = asyncHandler(async (req, res) => {
  res.json(await jobService.listJobs(listParamsFrom(req), actorFrom(req)));
});

// GET /jobs/site-options?q=&customer= — type-ahead options for the list's SITE filter.
//
// Sites are customer-owned and bulk-imported in the thousands, so this is a SEARCH, not a dump: a
// flat 200-row dropdown would silently truncate, which is worse than offering no filter at all.
// Gated on `jobs.view` rather than `customers.view` because it returns nothing a job row does not
// already show (site name, code, postcode) — and a jobs user who could not load the options would
// be left with a filter control that 403s on use.
export const listJobSiteOptions = asyncHandler(async (req, res) => {
  res.json({ sites: await jobService.searchSiteOptions(queryStr(req.query.q), queryStr(req.query.customer)) });
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

// The portal list's filters, parsed ONCE and shared with its CSV export — same bargain as
// listParamsFrom above. The two used to read the query string separately, which is precisely how a
// newly added filter ends up narrowing the screen and not the download.
function portalListParamsFrom(req: Request): jobService.ListCustomerJobsParams {
  return {
    search: queryStr(req.query.q),
    status: queryStr(req.query.status),
    sort: queryStr(req.query.sort),
    dueFrom: queryStr(req.query.dueFrom),
    dueTo: queryStr(req.query.dueTo),
    site: queryStr(req.query.site),
  };
}

// GET /customer/jobs?q=&status=&sort=&dueFrom=&dueTo=&site=&page=&pageSize=
export const getOwnJobs = asyncHandler(async (req, res) => {
  res.json(
    await jobService.listJobsForCustomer(customerId(req), {
      ...portalListParamsFrom(req),
      page: queryInt(req.query.page),
      pageSize: queryInt(req.query.pageSize),
    }),
  );
});

// GET /customer/jobs/export.csv — the customer's own jobs, honouring the list's filters.
export const exportOwnJobsCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "my-jobs", await jobService.exportOwnJobsCsv(customerId(req), portalListParamsFrom(req)));
});

// GET /customer/jobs/site-options?q= — the signed-in customer's OWN sites, for the list's site
// picker. Session-scoped like every other portal read: the customerId is never taken from the query
// string, so this can only ever return the caller's own sites.
export const getOwnJobSiteOptions = asyncHandler(async (req, res) => {
  res.json({ sites: await jobService.searchSiteOptions(queryStr(req.query.q), customerId(req)) });
});

// GET /customer/jobs/:id
export const getOwnJob = asyncHandler(async (req, res) => {
  res.json({ job: await jobService.getJobForCustomer(customerId(req), param(req, "id")) });
});
