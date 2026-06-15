import { PermissionGate } from "@/components/auth/PermissionGate";
import { WarehousesView } from "@/components/dashboard/warehouses/WarehousesView";

export default function WarehousesPage() {
  return (
    <PermissionGate anyOf={["warehouse.view"]}>
      <WarehousesView />
    </PermissionGate>
  );
}
