import { api, qs } from "../lib/api";
import type {
  CreateKitRequestPayload,
  KitItemOption,
  KitRequest,
  PagedKitRequests,
} from "../types";

// FE→PM additional-kit requests (/job-kit-requests/*) — engineer self-service surface.

export interface ListParams {
  status?: string;
  jobId?: string;
  search?: string;
  sort?: "oldest" | "newest";
  page?: number;
  pageSize?: number;
}

export function createKitRequest(payload: CreateKitRequestPayload): Promise<KitRequest> {
  return api<{ request: KitRequest }>("/job-kit-requests", { method: "POST", body: payload }).then(
    (r) => r.request,
  );
}

export function listMyKitRequests(params: ListParams = {}): Promise<PagedKitRequests> {
  return api<PagedKitRequests>(`/job-kit-requests/mine${qs(params as Record<string, unknown>)}`);
}

export function cancelKitRequest(id: string): Promise<KitRequest> {
  return api<{ request: KitRequest }>(`/job-kit-requests/${id}/cancel`, { method: "POST" }).then(
    (r) => r.request,
  );
}

/**
 * Item search for the composer: the company IRM catalogue plus — when jobId is passed —
 * the job's own customer's active, in-stock consignment entries.
 */
export function searchKitItems(q: string, jobId?: string): Promise<KitItemOption[]> {
  const query = `q=${encodeURIComponent(q)}${jobId ? `&jobId=${encodeURIComponent(jobId)}` : ""}`;
  return api<{ items: KitItemOption[] }>(`/job-kit-requests/item-search?${query}`).then(
    (r) => r.items,
  );
}
