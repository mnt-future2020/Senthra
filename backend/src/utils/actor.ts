import type { Request } from "express";

import type { AuditActor } from "#modules/audit/audit.service.js";
import { ALL_PERMISSIONS } from "#modules/role/permissions.js";

// Build the audit actor from the authenticated request. requireAuth populates
// req.principal (admin or staff user); snapshotting the id + email keeps audit
// entries meaningful even if that account is later renamed or removed. The
// principal's effective permissions ride along so authorization guards can
// enforce no-escalation rules — the super-admin account holds everything ("*").
export function actorFrom(req: Request): AuditActor {
  const principal = req.principal;
  if (!principal) return { id: null, email: null, type: "admin", permissions: [] };
  return {
    id: principal.id,
    email: principal.email,
    type: principal.type,
    permissions: principal.type === "user" ? principal.permissions : [ALL_PERMISSIONS],
  };
}
