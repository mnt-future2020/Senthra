import { CustomerGuard } from "@/components/dashboard/portal/CustomerGuard";
import { PortalDashboard } from "@/components/dashboard/portal/PortalDashboard";

// Customer portal landing — the Dashboard overview.
export default function PortalDashboardPage() {
  return (
    <CustomerGuard>
      <PortalDashboard />
    </CustomerGuard>
  );
}
