import { PermissionGate } from "@/components/auth/PermissionGate";
import { IrmItemForm } from "@/components/dashboard/irm/IrmItemForm";

export default function NewIrmItemPage() {
  return (
    <PermissionGate anyOf={["irm.create"]}>
      <IrmItemForm mode="create" />
    </PermissionGate>
  );
}
