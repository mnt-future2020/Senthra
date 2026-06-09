import { CustomersView } from "@/components/dashboard/customers/CustomersView";
import { PermissionGate } from "@/components/auth/PermissionGate";

export default function CustomersPage() {
  return (
    <PermissionGate anyOf={["customers.view"]}>
      <CustomersView />
    </PermissionGate>
  );
}
