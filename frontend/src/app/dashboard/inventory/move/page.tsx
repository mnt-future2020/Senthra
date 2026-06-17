import { Suspense } from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { TransferForm } from "@/components/dashboard/inventory/TransferForm";
import { FormPageSkeleton } from "@/components/ui/FormScaffold";

export default function MoveStockPage() {
  return (
    <PermissionGate anyOf={["inventory.move"]}>
      {/* TransferForm reads optional ?item=&from= via useSearchParams — needs a Suspense boundary. */}
      <Suspense fallback={<FormPageSkeleton />}>
        <TransferForm />
      </Suspense>
    </PermissionGate>
  );
}
