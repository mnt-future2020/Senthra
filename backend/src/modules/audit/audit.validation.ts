import type { Request } from "express";

import { queryInt } from "../../utils/request.js";
import type { ListAuditParams } from "./audit.service.js";

// Read-only GET — no body. This collapses Express's `string | string[]` query
// values to single strings and parses page/pageSize, producing the params the
// service normalizes. Invalid values are passed through as-is and dropped by the
// service's normalizeFilters (never a 400 on a read).
function str(value: unknown): string | undefined {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function parseAuditQuery(req: Request): ListAuditParams {
  const q = req.query;
  return {
    search: str(q.search),
    action: str(q.action),
    actorType: str(q.actorType),
    targetType: str(q.targetType),
    targetId: str(q.targetId),
    actorEmail: str(q.actorEmail),
    from: str(q.from),
    to: str(q.to),
    page: queryInt(q.page),
    pageSize: queryInt(q.pageSize),
  };
}
