import { PermissionGate } from "@/components/auth/PermissionGate";
import { SuppliersView } from "@/components/dashboard/suppliers/SuppliersView";

export default function SuppliersPage() {
  return (
    <PermissionGate anyOf={["suppliers.view"]}>
      <SuppliersView />
    </PermissionGate>
  );
}
