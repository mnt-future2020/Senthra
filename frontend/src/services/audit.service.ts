import axios from "axios";

import { api } from "@/lib/api";
import { env } from "@/lib/env";
import { downloadBlob, filenameFromDisposition } from "@/lib/download";
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

// The CSV endpoint returns a file, not JSON, so it bypasses the api() wrapper and
// makes a direct authenticated blob request. Note: this does NOT get the silent
// refresh-on-401 that api() provides — acceptable since the user is already on an
// authenticated page. Returns whether the export was capped (server truncated it).
export async function exportAuditCsv(
  params: AuditListParams = {},
): Promise<{ capped: boolean }> {
  // Drop pagination — the export spans all matching rows up to the server cap.
  const { page: _page, pageSize: _pageSize, ...filters } = params;
  void _page;
  void _pageSize;
  const res = await axios.get(`${env.apiUrl}/audit/export.csv${qs(filters)}`, {
    withCredentials: true,
    responseType: "blob",
  });
  const date = new Date().toISOString().slice(0, 10);
  const filename = filenameFromDisposition(
    res.headers["content-disposition"] ?? null,
    `audit-log-${date}.csv`,
  );
  downloadBlob(res.data as Blob, filename);
  const capped = String(res.headers["x-audit-export-capped"] ?? "") === "true";
  return { capped };
}
