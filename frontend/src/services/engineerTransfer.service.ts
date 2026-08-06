import { api, LONG_WRITE_TIMEOUT } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TransferStatus = "pending" | "completed" | "declined" | "cancelled";
export type TransferOwnership = "company" | "customer";

export interface TransferLine {
  id: string;
  ownership: TransferOwnership;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  sku: string | null;
  uom: string | null;
  quantity: number;
}

export interface EngineerTransfer {
  id: string;
  code: string;
  status: TransferStatus;
  fromEngineerId: string;
  fromEngineerName: string;
  fromEngineerEmail: string | null;
  fromEngineerPhone: string | null;
  toEngineerId: string;
  toEngineerName: string;
  toEngineerEmail: string | null;
  requestedByKind: "engineer" | "admin";
  reason: string;
  notes: string | null;
  jobId: string | null;
  customerId: string | null;
  attachments: string[];
  requireSignature: boolean;
  receiverSignatureUrl: string | null;
  acknowledgedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  declinedBy: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  overrideByAdmin: boolean;
  createdAt: string;
  lines: TransferLine[];
}

export interface PagedTransfers {
  transfers: EngineerTransfer[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface HolderOption {
  engineerId: string;
  name: string;
  available: number;
}

export interface TransferLinePayload {
  ownership: TransferOwnership;
  irmItemId?: string;
  customerStockEntryId?: string;
  quantity: number;
}

export interface CreateTransferPayload {
  fromEngineerId?: string;
  toEngineerId?: string;
  lines: TransferLinePayload[];
  reason: string;
  notes?: string;
  jobId?: string;
  customerId?: string;
  attachments?: string[];
}

export interface MineParams {
  role?: "incoming" | "outgoing" | "all";
  status?: string;
  sort?: "oldest" | "newest";
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface AllTransfersParams {
  status?: string;
  engineerId?: string;
  ownership?: string;
  sort?: "oldest" | "newest";
  search?: string;
  page?: number;
  pageSize?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ── Holder discovery ──────────────────────────────────────────────────────────

export function listHolders(
  params:
    | { ownership: "company"; irmItemId: string }
    | { ownership: "customer"; customerStockEntryId: string },
): Promise<HolderOption[]> {
  return api<{ holders: HolderOption[] }>(
    `/engineer-transfers/holders${qs(params as Record<string, unknown>)}`,
  ).then((r) => r.holders);
}

// A specific engineer's transferable holdings (company + customer) with ids + available qty —
// powers the admin "New transfer" picker (admin already knows the source engineer).
export interface EngineerHoldingOption {
  ownership: TransferOwnership;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  code: string | null;
  sku: string | null;
  uom: string | null;
  available: number;
  customerName: string | null;
}

export function listEngineerHoldings(engineerId: string): Promise<EngineerHoldingOption[]> {
  return api<{ holdings: EngineerHoldingOption[] }>(
    `/engineer-transfers/holdings/${engineerId}`,
  ).then((r) => r.holdings);
}

// ── Engineer self-service ─────────────────────────────────────────────────────

export function listMyTransfers(params: MineParams = {}): Promise<PagedTransfers> {
  return api<PagedTransfers>(`/engineer-transfers/mine${qs(params as Record<string, unknown>)}`);
}

// ── Admin board ───────────────────────────────────────────────────────────────

export function listAllTransfers(params: AllTransfersParams = {}): Promise<PagedTransfers> {
  return api<PagedTransfers>(`/engineer-transfers${qs(params as Record<string, unknown>)}`);
}

export function getTransfer(id: string): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>(`/engineer-transfers/${id}`).then((r) => r.transfer);
}

// ── Mutations (backend wraps the row as { transfer }) ──────────────────────────

export function createTransfer(payload: CreateTransferPayload): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>("/engineer-transfers", { method: "POST", body: payload }).then((r) => r.transfer);
}

export function approveTransfer(id: string): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>(`/engineer-transfers/${id}/approve`, { method: "POST" }).then((r) => r.transfer);
}

export function declineTransfer(id: string, reason?: string): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>(`/engineer-transfers/${id}/decline`, {
    method: "POST",
    body: { reason },
  }).then((r) => r.transfer);
}

export function cancelTransfer(id: string): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>(`/engineer-transfers/${id}/cancel`, { method: "POST" }).then((r) => r.transfer);
}

export function overrideTransfer(id: string): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>(`/engineer-transfers/${id}/override`, { method: "POST" }).then((r) => r.transfer);
}

export function acknowledgeTransfer(id: string, signature: string): Promise<EngineerTransfer> {
  return api<{ transfer: EngineerTransfer }>(`/engineer-transfers/${id}/acknowledge`, {
    method: "POST",
    body: { signature },
    // The signature PNG is relayed to Cloudinary before the transfer is booked — see
    // LONG_WRITE_TIMEOUT. Drawn on a phone, in a van, on whatever signal is going: the one call in
    // this file least able to afford a 20s cliff, and a spurious failure here asks the customer to
    // sign twice for one handover.
    timeout: LONG_WRITE_TIMEOUT,
  }).then((r) => r.transfer);
}

// ── Discovery search (items OTHER engineers hold) ────────────────────────────

export interface CompanyCandidate {
  irmItemId: string;
  itemName: string;
  code: string | null;
  sku: string | null;
  uom: string | null;
  engineerId: string;
  engineerName: string;
  available: number;
}

export function searchCompanyCandidates(search: string): Promise<CompanyCandidate[]> {
  return api<{ candidates: CompanyCandidate[] }>(
    `/engineer-transfers/company-search?search=${encodeURIComponent(search)}`,
  ).then((r) => r.candidates);
}

export interface CustomerCandidate {
  customerStockEntryId: string;
  itemName: string;
  code: string | null;
  sku: string | null;
  barcode: string | null;
  uom: string | null;
  customerName: string | null;
  engineerId: string;
  engineerName: string;
  available: number;
}

export function searchCustomerCandidates(search: string): Promise<CustomerCandidate[]> {
  return api<{ candidates: CustomerCandidate[] }>(
    `/engineer-transfers/customer-search?search=${encodeURIComponent(search)}`,
  ).then((r) => r.candidates);
}

// ── Attachment upload ─────────────────────────────────────────────────────────

/** Upload an image data URI to Cloudinary via the backend and get back a URL. */
export function uploadAttachment(image: string): Promise<string> {
  return api<{ url: string }>("/engineer-transfers/attachments", {
    method: "POST",
    body: { image },
    timeout: LONG_WRITE_TIMEOUT, // Cloudinary relay
  }).then((r) => r.url);
}
