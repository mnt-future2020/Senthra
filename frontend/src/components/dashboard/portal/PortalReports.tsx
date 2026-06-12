"use client";

import { BarChart3 } from "lucide-react";

import { ComingSoon, PortalHeader } from "./portalUi";

// Customer portal — Reports. An honest placeholder until the reporting + inventory
// modules exist; shown so the customer knows it's planned, not missing.
export function PortalReports() {
  return (
    <div className="space-y-6">
      <PortalHeader title="Reports" subtitle="Downloadable summaries of your stock and activity." />
      <ComingSoon
        icon={BarChart3}
        title="Reports are on the way"
        body="Stock summaries, request history and movement reports will be available to download here once your inventory data is connected."
      />
    </div>
  );
}
