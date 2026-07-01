import { Suspense } from "react";

import { EngineerGuard } from "@/components/dashboard/engineer/EngineerGuard";
import { EngineerInventory } from "@/components/dashboard/engineer/EngineerInventory";

export default function EngineerInventoryPage() {
  return (
    <EngineerGuard perm="engineer.inventory.view">
      {/* Suspense satisfies useSearchParams (?section= seed) during prerender. */}
      <Suspense>
        <EngineerInventory />
      </Suspense>
    </EngineerGuard>
  );
}
