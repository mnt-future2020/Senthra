import { Suspense } from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { InventoryHub } from "@/components/dashboard/inventory/InventoryHub";

export default function InventoryPage() {
  return (
    <PermissionGate anyOf={["inventory.view"]}>
      {/* Suspense satisfies useSearchParams (the ?tab= lens seed) during prerender. */}
      <Suspense>
        <InventoryHub />
      </Suspense>
    </PermissionGate>
  );
}
