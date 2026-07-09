import { PermissionGate } from "@/components/auth/PermissionGate";
import { PurchaseRequestForm } from "@/components/dashboard/purchase-requests/PurchaseRequestForm";

export default function NewPurchaseRequestPage() {
  return (
    <PermissionGate anyOf={["purchase_requests.create"]}>
      <PurchaseRequestForm mode="create" />
    </PermissionGate>
  );
}
