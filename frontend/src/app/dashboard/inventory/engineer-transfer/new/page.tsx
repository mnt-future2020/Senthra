import { PermissionGate } from "@/components/auth/PermissionGate";
import { TransferComposer } from "@/components/dashboard/transfers/TransferComposer";

export default function NewEngineerTransferPage() {
  return (
    <PermissionGate anyOf={["engineer_stock.transfer"]}>
      <TransferComposer mode="admin" returnUrl="/dashboard/inventory?tab=engineer&view=transfers" />
    </PermissionGate>
  );
}
