import type { Request } from "express";

import type { AuditActor } from "../services/audit.service.js";

// Build the audit actor from the authenticated request. requireAuth populates
// req.adminId / req.adminEmail; snapshotting the email keeps audit entries
// meaningful over time.
export function actorFrom(req: Request): AuditActor {
  return { id: req.adminId ?? null, email: req.adminEmail ?? null, type: "admin" };
}
