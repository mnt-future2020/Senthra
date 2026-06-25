import { PermissionGate } from "@/components/auth/PermissionGate";
import { JobForm } from "@/components/dashboard/jobs/JobForm";

export default function NewJobPage() {
  return (
    <PermissionGate anyOf={["jobs.create"]}>
      <JobForm mode="create" />
    </PermissionGate>
  );
}
