import { PermissionGate } from "@/components/auth/PermissionGate";
import { SupplierForm } from "@/components/dashboard/suppliers/SupplierForm";

export default function NewSupplierPage() {
  return (
    <PermissionGate anyOf={["suppliers.create"]}>
      <SupplierForm mode="create" />
    </PermissionGate>
  );
}
