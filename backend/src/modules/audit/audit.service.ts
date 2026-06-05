import type { Prisma } from "@prisma/client";

import * as auditLogRepo from "./auditLog.repository.js";

// Actor is snapshotted (id + email) so an entry stays meaningful even if that
// account is later renamed or removed.
export interface AuditActor {
  id?: string | null;
  type?: "admin" | "user" | "system";
  email?: string | null;
  // The actor's effective permissions ("*" = all). Not persisted on the audit
  // row — carried so authorization guards can enforce a no-escalation rule (a
  // delegate must not grant permissions it doesn't itself hold).
  permissions?: string[];
}

export interface AuditEntry {
  actor?: AuditActor;
  action: string; // "user.created", "role.deleted", ...
  targetType?: string; // user | role | email_template
  targetId?: string;
  targetLabel?: string; // snapshot, e.g. the user's email
  metadata?: Record<string, unknown>;
}

// Record an audit entry. Fire-and-forget by design: auditing must never break or
// slow the operation it describes, so a write failure is logged server-side only.
export function record(entry: AuditEntry): void {
  const data: Prisma.AuditLogCreateInput = {
    actorId: entry.actor?.id ?? null,
    actorType: entry.actor?.type ?? "admin",
    actorEmail: entry.actor?.email ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    targetLabel: entry.targetLabel ?? null,
  };
  if (entry.metadata) data.metadata = entry.metadata as Prisma.InputJsonValue;

  void auditLogRepo
    .create(data)
    .catch((e) =>
      console.error("Audit log write failed:", e instanceof Error ? e.message : e),
    );
}
