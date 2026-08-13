import * as auditService from "./audit.service.js";
import { parseAuditQuery } from "./audit.validation.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendCsv } from "../../utils/csv-response.js";

// GET /audit  (protected: audit.view) — paginated, filterable list. Scoped to the caller's
// accessible warehouses: a warehouse-scoped role sees only their warehouses' audit (actorFrom
// carries the assigned set), an unrestricted role sees everything.
export const listAuditLogs = asyncHandler(async (req, res) => {
  const result = await auditService.listAuditLogs(parseAuditQuery(req), actorFrom(req));
  res.json(result);
});

// GET /audit/facets  (protected: audit.view) — the distinct actions, actor types,
// and target types present, for the filter dropdowns (data-driven so no dead
// options). Scoped like the list so the dropdowns never leak other warehouses' values.
export const listFacets = asyncHandler(async (req, res) => {
  res.json(await auditService.listFacets(actorFrom(req)));
});

// GET /audit/export.csv  (protected: audit.view) — CSV of the filtered view,
// streamed as a file download. Honors the same filters AND the same warehouse scope as
// the list (page/pageSize are ignored — the export spans all matching rows up to the cap).
export const exportAuditCsv = asyncHandler(async (req, res) => {
  sendCsv(res, "audit-log", await auditService.exportAuditCsv(parseAuditQuery(req), actorFrom(req)));
});
