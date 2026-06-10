import { AuditLogPanel } from "@/components/dashboard/audit/AuditLogPanel";
import { PermissionGate } from "@/components/auth/PermissionGate";

export default function AuditPage() {
  return (
    <PermissionGate anyOf={["audit.view"]}>
      <AuditLogPanel />
    </PermissionGate>
  );
}
