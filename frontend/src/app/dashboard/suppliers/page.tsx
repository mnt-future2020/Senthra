import { Suspense } from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { SuppliersPanel } from "@/components/dashboard/suppliers/SuppliersPanel";

export default function SuppliersPage() {
  return (
    <PermissionGate anyOf={["suppliers.view", "supplier_types.view"]}>
      {/* Suspense satisfies useSearchParams (the ?tab= seed) during prerender. */}
      <Suspense>
        <SuppliersPanel />
      </Suspense>
    </PermissionGate>
  );
}
