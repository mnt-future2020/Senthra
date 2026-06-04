"use client";

import { SettingsPanel } from "@/components/dashboard/settings/SettingsPanel";
import { useDashboard } from "@/hooks/useDashboard";

export default function SettingsPage() {
  const d = useDashboard();
  return (
    <SettingsPanel
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
