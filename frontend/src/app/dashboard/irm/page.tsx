import { Suspense } from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { IrmPanel } from "@/components/dashboard/irm/IrmPanel";

export default function IrmPage() {
  return (
    <PermissionGate anyOf={["irm.view", "irm_types.view", "irm_categories.view"]}>
      {/* Suspense satisfies useSearchParams (the ?tab= seed) during prerender. */}
      <Suspense>
        <IrmPanel />
      </Suspense>
    </PermissionGate>
  );
}
