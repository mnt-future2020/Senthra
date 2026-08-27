import { Suspense } from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { FinancePanel } from "@/components/dashboard/reports/FinancePanel";

export default function FinancePage() {
  // Finance-only. `reports.view` deliberately does NOT admit here any more: it gates the general
  // Reports hub (Custom Reports, operational reporting), which is a different concept and a different
  // audience. Whoever may see money holds `reports.finance.view`, and the SERVER enforces that on
  // every figure regardless of what this gate allows through.
  return (
    <PermissionGate anyOf={["reports.finance.view"]}>
      {/* Suspense satisfies useSearchParams (the ?period= filter) during prerender. */}
      <Suspense>
        <FinancePanel />
      </Suspense>
    </PermissionGate>
  );
}
