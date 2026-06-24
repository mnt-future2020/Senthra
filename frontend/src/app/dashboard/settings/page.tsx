"use client";

import { Suspense } from "react";

import { SettingsPanel } from "@/components/dashboard/settings/SettingsPanel";
import { useDashboard } from "@/hooks/useDashboard";
import { PermissionGate } from "@/components/auth/PermissionGate";

export default function SettingsPage() {
  const d = useDashboard();
  return (
    <PermissionGate
      anyOf={[
        // Only perms that map to an actual Settings section. Domain master-data (warehouse/supplier/
        // IRM types + IRM categories) lives in its own module's tabs, not here — so those perms must
        // NOT grant Settings access, or the user lands on an empty Settings page.
        "settings.view",
        "email_templates.view",
        "categories.view",
      ]}
    >
      {/* Suspense satisfies useSearchParams (the ?section= the panel reads). */}
      <Suspense>
        <SettingsPanel
          theme={d.theme}
          setTheme={d.setTheme}
          density={d.density}
          setDensity={d.setDensity}
          radius={d.radius}
          setRadius={d.setRadius}
          pushToast={d.pushToast}
        />
      </Suspense>
    </PermissionGate>
  );
}
