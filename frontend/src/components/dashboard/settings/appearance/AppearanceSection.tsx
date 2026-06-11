"use client";

import { RotateCcw, Palette } from "lucide-react";

import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { Field } from "@/components/ui/Field";
import { hintCls, labelCls } from "@/components/ui/styles";
import type { AppearanceProps } from "@/components/dashboard/settings/types";

export function AppearanceSection({
  theme,
  setTheme,
  density,
  setDensity,
  radius,
  setRadius,
  pushToast,
}: AppearanceProps) {
  const reset = () => {
    setTheme("light");
    setDensity("regular");
    setRadius(18);
    pushToast("Appearance reset to defaults.", "info");
  };

  const segBtn = (active: boolean) =>
    `py-3 rounded-xl border text-sm font-bold transition-all cursor-pointer ${
      active
        ? "border-[var(--accent)] bg-[var(--accent-6)] text-[var(--accent)]"
        : "border-[var(--border)] text-[var(--ink)] hover:bg-[var(--surface-2)]"
    }`;

  return (
    <SettingsCard
      icon={Palette}
      title="Appearance"
      desc="Theme, density and corners — applied instantly."
    >
      <div className="space-y-6">
        <Field label="Theme" hint="Light or dark dashboard.">
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setTheme("light")} className={segBtn(theme === "light")}>
              Light
            </button>
            <button onClick={() => setTheme("dark")} className={segBtn(theme === "dark")}>
              Dark
            </button>
          </div>
        </Field>

        <Field
          label="Density"
          hint="Compact fits more; Regular is roomier."
        >
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setDensity("compact")} className={segBtn(density === "compact")}>
              Compact
            </button>
            <button onClick={() => setDensity("regular")} className={segBtn(density === "regular")}>
              Regular
            </button>
          </div>
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className={labelCls + " mb-0"}>Corner radius</span>
            <span className="num font-mono text-xs text-[var(--muted)]">{radius}px</span>
          </div>
          <input
            type="range"
            min="6"
            max="26"
            value={radius}
            onChange={(e) => setRadius(parseInt(e.target.value))}
            className="w-full accent-[var(--accent)]"
          />
          <p className={hintCls}>
            Roundness of cards, buttons and inputs.
          </p>
        </div>

        <div className="flex justify-end border-t border-[var(--border-2)] pt-4">
          <button
            onClick={reset}
            className="flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold text-[var(--muted)] transition-all hover:text-[var(--neg)]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to defaults
          </button>
        </div>
      </div>
    </SettingsCard>
  );
}
