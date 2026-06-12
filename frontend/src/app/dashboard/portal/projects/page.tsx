import { CustomerGuard } from "@/components/dashboard/portal/CustomerGuard";
import { PortalProjects } from "@/components/dashboard/portal/PortalProjects";

// Customer portal — Projects (read-only).
export default function PortalProjectsPage() {
  return (
    <CustomerGuard>
      <PortalProjects />
    </CustomerGuard>
  );
}
