import { PermissionGate } from "@/components/auth/PermissionGate";
import { WarehouseForm } from "@/components/dashboard/warehouses/WarehouseForm";

export default function NewWarehousePage() {
  return (
    <PermissionGate anyOf={["warehouse.create"]}>
      <WarehouseForm mode="create" />
    </PermissionGate>
  );
}
