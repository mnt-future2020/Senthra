import { Suspense } from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { ReportsAuditHub } from "@/components/dashboard/reports/ReportsAuditHub";

export default function ReportsAuditPage() {
  // ANY of the three rights opens the hub, because it hosts three independent surfaces: Custom
  // Reports (`reports.view`), Scheduled Reports (either reporting right) and the Audit Trail
  // (`audit.view`). A user holding one sees that tab only — the hub decides which tabs exist, and
  // each underlying surface enforces its own access server-side regardless.
  //
  // `reports.finance.view` is NOT optional here, and leaving it out was a real lockout rather than a
  // tightening: the nav row, DASHBOARD_SECTIONS and the hub's own tab list all admit it (scheduling
  // the Finance report is the whole reason it does), so the seeded Finance Director — who holds
  // `reports.finance.view` + `reports.export` and deliberately NOT `reports.view` — saw the
  // "Reports & Audit" row, clicked it, and was told they had no access to the one page that could
  // automate their report. Kept in lockstep with Sidebar.NAV; Sidebar.nav.test.ts pins that list.
  return (
    <PermissionGate anyOf={["reports.view", "reports.finance.view", "audit.view"]}>
      {/* Suspense satisfies useSearchParams (the ?tab= lens) during prerender. */}
      <Suspense>
        <ReportsAuditHub />
      </Suspense>
    </PermissionGate>
  );
}
