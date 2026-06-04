import type { Request } from "express";

import type { AuditActor } from "#modules/audit/audit.service.js";

// Build the audit actor from the authenticated request. requireAuth populates
// req.principal (admin or staff user); snapshotting the id + email keeps audit
// entries meaningful even if that account is later renamed or removed.
export function actorFrom(req: Request): AuditActor {
  const principal = req.principal;
  if (!principal) return { id: null, email: null, type: "admin" };
  return { id: principal.id, email: principal.email, type: principal.type };
}
