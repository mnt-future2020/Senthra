import { PermissionGate } from "@/components/auth/PermissionGate";
import { IrmItemsView } from "@/components/dashboard/irm/IrmItemsView";

export default function IrmPage() {
  return (
    <PermissionGate anyOf={["irm.view"]}>
      <IrmItemsView />
    </PermissionGate>
  );
}
