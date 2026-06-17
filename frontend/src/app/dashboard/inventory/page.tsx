import { PermissionGate } from "@/components/auth/PermissionGate";
import { InventoryView } from "@/components/dashboard/inventory/InventoryView";

export default function InventoryPage() {
  return (
    <PermissionGate anyOf={["inventory.view"]}>
      <InventoryView />
    </PermissionGate>
  );
}
