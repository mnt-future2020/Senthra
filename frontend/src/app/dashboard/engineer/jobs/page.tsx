import { EngineerGuard } from "@/components/dashboard/engineer/EngineerGuard";
import { EngineerJobs } from "@/components/dashboard/engineer/EngineerJobs";

export default function EngineerJobsPage() {
  return (
    <EngineerGuard perm="engineer.jobs.view">
      <EngineerJobs />
    </EngineerGuard>
  );
}
