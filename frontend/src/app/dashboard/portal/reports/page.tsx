import { Suspense } from "react";

import { CustomerGuard } from "@/components/dashboard/portal/CustomerGuard";
import { PortalReports } from "@/components/dashboard/portal/PortalReports";

// Customer portal — Reports (FLOW 9). Read-only, customer-scoped server-side.
export default function PortalReportsPage() {
  return (
    <CustomerGuard>
      {/* Suspense satisfies useSearchParams (the ?type= / filter state) during prerender. */}
      <Suspense>
        <PortalReports />
      </Suspense>
    </CustomerGuard>
  );
}
