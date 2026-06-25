"use client";

import { useParams } from "next/navigation";

import { EngineerGuard } from "@/components/dashboard/engineer/EngineerGuard";
import { EngineerJobDetail } from "@/components/dashboard/engineer/EngineerJobDetail";

export default function EngineerJobDetailPage() {
  const params = useParams();
  const id = String(params.id);
  return (
    <EngineerGuard perm="engineer.jobs.view">
      <EngineerJobDetail key={id} id={id} />
    </EngineerGuard>
  );
}
