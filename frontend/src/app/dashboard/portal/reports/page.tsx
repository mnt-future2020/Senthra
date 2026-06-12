import { CustomerGuard } from "@/components/dashboard/portal/CustomerGuard";
import { PortalReports } from "@/components/dashboard/portal/PortalReports";

// Customer portal — Reports (coming soon).
export default function PortalReportsPage() {
  return (
    <CustomerGuard>
      <PortalReports />
    </CustomerGuard>
  );
}
