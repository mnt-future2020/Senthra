import { Suspense } from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { AddStockForm } from "@/components/dashboard/inventory/AddStockForm";
import { FormPageSkeleton } from "@/components/ui/FormScaffold";

export default function AddStockPage() {
  return (
    <PermissionGate anyOf={["inventory.adjust"]}>
      {/* AddStockForm reads optional ?warehouse=&item= via useSearchParams — needs a Suspense boundary. */}
      <Suspense fallback={<FormPageSkeleton />}>
        <AddStockForm />
      </Suspense>
    </PermissionGate>
  );
}
