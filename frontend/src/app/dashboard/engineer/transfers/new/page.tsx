import { EngineerGuard } from "@/components/dashboard/engineer/EngineerGuard";
import { TransferComposer } from "@/components/dashboard/transfers/TransferComposer";

export default function NewEngineerRequestPage() {
  return (
    <EngineerGuard perm="engineer.transfer">
      <TransferComposer mode="engineer" returnUrl="/dashboard/engineer/transfers" />
    </EngineerGuard>
  );
}
