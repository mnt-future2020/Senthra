import { Suspense } from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { PurchaseRequestsView } from "@/components/dashboard/purchase-requests/PurchaseRequestsView";

export default function PurchaseRequestsPage() {
  return (
    <PermissionGate anyOf={["purchase_requests.view"]}>
      {/* Suspense satisfies useSearchParams (?q, ?status, ?page) during prerender. */}
      <Suspense>
        <PurchaseRequestsView />
      </Suspense>
    </PermissionGate>
  );
}
