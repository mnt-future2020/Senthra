import { CustomerForm } from "@/components/dashboard/customers/CustomerForm";
import { PermissionGate } from "@/components/auth/PermissionGate";

export default function NewCustomerPage() {
  return (
    <PermissionGate anyOf={["customers.create"]}>
      <CustomerForm mode="create" />
    </PermissionGate>
  );
}
