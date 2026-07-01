import { Suspense } from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { JobsView } from "@/components/dashboard/jobs/JobsView";

export default function JobsPage() {
  return (
    <PermissionGate anyOf={["jobs.view"]}>
      {/* Suspense satisfies useSearchParams (?q, ?status, ?customer, ?engineer, ?page) during prerender. */}
      <Suspense>
        <JobsView />
      </Suspense>
    </PermissionGate>
  );
}
