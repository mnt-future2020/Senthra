import { Suspense } from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { PurchaseOrdersView } from "@/components/dashboard/purchase-orders/PurchaseOrdersView";

export default function PurchaseOrdersPage() {
  return (
    <PermissionGate anyOf={["purchase_orders.view"]}>
      {/* Suspense satisfies useSearchParams (?q, ?status, ?page) during prerender. */}
      <Suspense>
        <PurchaseOrdersView />
      </Suspense>
    </PermissionGate>
  );
}
