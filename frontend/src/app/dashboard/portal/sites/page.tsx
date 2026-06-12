import { CustomerGuard } from "@/components/dashboard/portal/CustomerGuard";
import { PortalSites } from "@/components/dashboard/portal/PortalSites";

// Customer portal — Sites (read-only).
export default function PortalSitesPage() {
  return (
    <CustomerGuard>
      <PortalSites />
    </CustomerGuard>
  );
}
