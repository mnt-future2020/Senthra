import { PermissionGate } from "@/components/auth/PermissionGate";
import { JobsView } from "@/components/dashboard/jobs/JobsView";

export default function JobsPage() {
  return (
    <PermissionGate anyOf={["jobs.view"]}>
      <JobsView />
    </PermissionGate>
  );
}
