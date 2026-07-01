import { Suspense } from "react";

import { EngineerGuard } from "@/components/dashboard/engineer/EngineerGuard";
import { EngineerTransfers } from "@/components/dashboard/engineer/EngineerTransfers";

export default function EngineerTransfersPage() {
  return (
    <EngineerGuard perm="engineer.transfer">
      {/* EngineerTransfers reads the active tab from ?view= via useSearchParams — needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <EngineerTransfers />
      </Suspense>
    </EngineerGuard>
  );
}
