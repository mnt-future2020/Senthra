"use client";

import { ClipboardList } from "lucide-react";

import { ComingSoon, PortalHeader } from "@/components/dashboard/portal/portalUi";

// Phase 1 placeholder — no Job model/API exists yet. The real assigned-jobs list arrives with the
// Job Pack module. The message is fixed by product.
export function EngineerJobs() {
  return (
    <div className="space-y-6">
      <PortalHeader title="Jobs" subtitle="Your assigned jobs." />
      <ComingSoon
        icon={ClipboardList}
        title="Jobs"
        body="Jobs will be available once the Job Pack module is implemented."
      />
    </div>
  );
}
