// Audit trail types — mirror the backend PublicAuditEntry / PagedAuditLogs DTOs.

export type AuditActorType = "admin" | "user" | "customer" | "system";

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorType: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  // Arbitrary JSON snapshot recorded with the action (e.g. before/after values).
  metadata: unknown;
  createdAt: string; // ISO 8601
}

export interface PagedAuditLogs {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Distinct values present in the log — drive the filter dropdowns so they only
// offer values that actually exist.
export interface AuditFacets {
  actions: string[];
  actorTypes: string[];
  targetTypes: string[];
}
