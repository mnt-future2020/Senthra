import * as auditService from "./audit.service.js";
import { parseAuditQuery } from "./audit.validation.js";
import { asyncHandler } from "../../utils/async-handler.js";

// GET /audit  (protected: audit.view) — paginated, filterable list.
export const listAuditLogs = asyncHandler(async (req, res) => {
  const result = await auditService.listAuditLogs(parseAuditQuery(req));
  res.json(result);
});

// GET /audit/facets  (protected: audit.view) — the distinct actions, actor types,
// and target types present, for the filter dropdowns (data-driven so no dead
// options).
export const listFacets = asyncHandler(async (_req, res) => {
  res.json(await auditService.listFacets());
});

// GET /audit/export.csv  (protected: audit.view) — CSV of the filtered view,
// streamed as a file download. Honors the same filters as the list (page/pageSize
// are ignored — the export spans all matching rows up to the cap).
export const exportAuditCsv = asyncHandler(async (req, res) => {
  const { csv, capped } = await auditService.exportAuditCsv(parseAuditQuery(req));
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="audit-log-${date}.csv"`);
  if (capped) res.setHeader("X-Audit-Export-Capped", "true");
  // Prepend a UTF-8 BOM so Excel opens accented text correctly.
  res.send("﻿" + csv);
});
