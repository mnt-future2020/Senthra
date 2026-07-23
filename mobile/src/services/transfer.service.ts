import { api, qs } from "../lib/api";
import type {
  CompanyCandidate,
  CreateTransferPayload,
  CustomerCandidate,
  EngineerTransfer,
  PagedTransfers,
} from "../types";

// Engineer-to-engineer stock transfers (/engineer-transfers/*).

export interface MineParams {
  role?: "incoming" | "outgoing" | "all";
  status?: string;
  sort?: "oldest" | "newest";
  search?: string;
  page?: number;
  pageSize?: number;
}

export function listMyTransfers(params: MineParams = {}): Promise<PagedTransfers> {
  return api<PagedTransfers>(`/engineer-transfers/mine${qs(params as Record<string, unknown>)}`);
}

export function getTransfer(id: string): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>(`/engineer-transfers/${id}`).then((r) => r.transfer);
}

export function createTransfer(payload: CreateTransferPayload): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>("/engineer-transfers", {
    method: "POST",
    body: payload,
  }).then((r) => r.transfer);
}

export function approveTransfer(id: string): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>(`/engineer-transfers/${id}/approve`, {
    method: "POST",
  }).then((r) => r.transfer);
}

export function declineTransfer(id: string, reason?: string): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>(`/engineer-transfers/${id}/decline`, {
    method: "POST",
    body: { reason },
  }).then((r) => r.transfer);
}

export function cancelTransfer(id: string): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>(`/engineer-transfers/${id}/cancel`, {
    method: "POST",
  }).then((r) => r.transfer);
}

/** Recipient signs for received stock (data-URI PNG from the signature pad). */
export function acknowledgeTransfer(id: string, signature: string): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>(`/engineer-transfers/${id}/acknowledge`, {
    method: "POST",
    body: { signature },
  }).then((r) => r.transfer);
}

/** Upload an image data URI to Cloudinary via the backend and get back a URL. */
export function uploadAttachment(image: string): Promise<string> {
  return api<{ url: string }>("/engineer-transfers/attachments", {
    method: "POST",
    body: { image },
  }).then((r) => r.url);
}

// Discovery — items OTHER engineers hold (powers the "request from a van" composer).

export function searchCompanyCandidates(search: string): Promise<CompanyCandidate[]> {
  return api<{ candidates: CompanyCandidate[] }>(
    `/engineer-transfers/company-search?search=${encodeURIComponent(search)}`,
  ).then((r) => r.candidates);
}

export function searchCustomerCandidates(search: string): Promise<CustomerCandidate[]> {
  return api<{ candidates: CustomerCandidate[] }>(
    `/engineer-transfers/customer-search?search=${encodeURIComponent(search)}`,
  ).then((r) => r.candidates);
}
