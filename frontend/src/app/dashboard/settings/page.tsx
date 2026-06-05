"use client";

import { SettingsPanel } from "@/components/dashboard/settings/SettingsPanel";
import { useDashboard } from "@/hooks/useDashboard";
import { PermissionGate } from "@/components/auth/PermissionGate";

export default function SettingsPage() {
  const d = useDashboard();
  return (
    <PermissionGate anyOf={["settings.manage", "email_templates.manage"]}>
      <SettingsPanel
        theme={d.theme}
        setTheme={d.setTheme}
        density={d.density}
        setDensity={d.setDensity}
        radius={d.radius}
        setRadius={d.setRadius}
        pushToast={d.pushToast}
      />
    </PermissionGate>
  );
}
