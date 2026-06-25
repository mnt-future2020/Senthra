"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { JobForm } from "@/components/dashboard/jobs/JobForm";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as jobService from "@/services/job.service";
import type { Job } from "@/types/job";

export default function EditJobPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["jobs.edit"]}>
      <Loader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function Loader({ idOrCode }: { idOrCode: string }) {
  const [job, setJob] = React.useState<Job | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    jobService
      .getJob(idOrCode)
      .then((j) => active && setJob(j))
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load this job."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [idOrCode]);

  if (loading) return <FormPageSkeleton />;
  if (error || !job) return <FormError message={error ?? "Job not found."} />;
  return <JobForm mode="edit" job={job} />;
}
