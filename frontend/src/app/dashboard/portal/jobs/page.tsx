import { CustomerGuard } from "@/components/dashboard/portal/CustomerGuard";
import { PortalJobs } from "@/components/dashboard/portal/PortalJobs";

// Customer portal — Jobs (read-only). Scoped to the signed-in customer server-side.
export default function PortalJobsPage() {
  return (
    <CustomerGuard>
      <PortalJobs />
    </CustomerGuard>
  );
}
