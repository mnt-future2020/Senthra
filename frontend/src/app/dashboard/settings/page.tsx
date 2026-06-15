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
        "settings.view",
        "email_templates.view",
        "categories.view",
        "warehouse_types.view",
        "supplier_types.view",
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
