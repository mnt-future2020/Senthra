"use client";

import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { JobDetail } from "@/components/dashboard/jobs/JobDetail";

// :id may be a database id OR a job number (the list links by jobNumber).
export default function ViewJobPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["jobs.view"]}>
      <JobDetail key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}
