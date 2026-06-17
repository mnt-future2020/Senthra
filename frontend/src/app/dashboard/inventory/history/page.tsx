import { PermissionGate } from "@/components/auth/PermissionGate";
import { MovementHistory } from "@/components/dashboard/inventory/MovementHistory";

export default function StockMovementsPage() {
  return (
    <PermissionGate anyOf={["inventory.history"]}>
      <MovementHistory />
    </PermissionGate>
  );
}
