import { api } from "@/lib/api";
import { downloadCsv, withoutPaging } from "@/lib/csvExport";
import type { AuditFacets, PagedAuditLogs } from "@/types/audit";

// Typed wrappers around the backend /audit endpoints. Components call these, never
// api()/axios directly.

export interface AuditListParams {
  search?: string;
  action?: string;
  actorType?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

function qs(params: AuditListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.action) sp.set("action", params.action);
  if (params.actorType) sp.set("actorType", params.actorType);
  if (params.targetType) sp.set("targetType", params.targetType);
  if (params.targetId) sp.set("targetId", params.targetId);
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function listAuditLogs(params: AuditListParams = {}): Promise<PagedAuditLogs> {
  return api<PagedAuditLogs>(`/audit${qs(params)}`);
}

// The distinct actions / actor types / target types present, for the filter
// dropdowns (data-driven so they never offer a value that matches zero rows).
export function listAuditFacets(): Promise<AuditFacets> {
  return api<AuditFacets>("/audit/facets");
}

// The CSV endpoint returns a file, not JSON, so it goes through apiFile() rather than api() — same
// axios client, so it keeps the silent refresh-on-401 (this used to be a raw axios call, which lost
// it: an export fired seconds after the access token expired failed outright). Returns whether the
// export was capped (server truncated it) — the flag rides on a response header, which only reaches
// this code because it is listed in the API's CORS exposedHeaders.
export async function exportAuditCsv(
  params: AuditListParams = {},
): Promise<{ capped: boolean }> {
  return downloadCsv(`/audit/export.csv${qs(withoutPaging(params))}`, "audit-log");
}
