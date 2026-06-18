import { Suspense } from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { WarehousesPanel } from "@/components/dashboard/warehouses/WarehousesPanel";

export default function WarehousesPage() {
  return (
    <PermissionGate anyOf={["warehouse.view", "warehouse_types.view"]}>
      {/* Suspense satisfies useSearchParams (the ?tab= seed) during prerender. */}
      <Suspense>
        <WarehousesPanel />
      </Suspense>
    </PermissionGate>
  );
}
