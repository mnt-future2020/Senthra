"use client";

import { SettingsPanel } from "@/components/dashboard/settings/SettingsPanel";
import { useDashboard } from "@/components/dashboard/DashboardProvider";

export default function SettingsPage() {
  const d = useDashboard();
  return (
    <SettingsPanel
      accent={d.accent}
      setAccent={d.setAccent}
      theme={d.theme}
      setTheme={d.setTheme}
      density={d.density}
      setDensity={d.setDensity}
      radius={d.radius}
      setRadius={d.setRadius}
      pushToast={d.pushToast}
    />
  );
}
