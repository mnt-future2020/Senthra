import { PermissionGate } from "@/components/auth/PermissionGate";
import { PurchaseOrderForm } from "@/components/dashboard/purchase-orders/PurchaseOrderForm";

export default function NewPurchaseOrderPage() {
  return (
    <PermissionGate anyOf={["purchase_orders.create"]}>
      <PurchaseOrderForm mode="create" />
    </PermissionGate>
  );
}
