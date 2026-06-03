"use client";

import { RotateCcw, Palette } from "lucide-react";

import { AVAILABLE_ACCENTS } from "@/data/dashboard";
import { SettingsCard } from "./ui/SettingsCard";
import { labelCls } from "./ui/styles";
import type { AppearanceProps } from "./types";

export function AppearanceSection({
  accent,
  setAccent,
  theme,
  setTheme,
  density,
  setDensity,
  radius,
  setRadius,
  pushToast,
}: AppearanceProps) {
  const reset = () => {
    setAccent("#7b6ef0");
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
      desc="Customize the look of your dashboard. Changes apply instantly."
    >
      <div className="space-y-6">
        <div>
          <label className={labelCls}>Theme</label>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setTheme("light")} className={segBtn(theme === "light")}>
              Light
            </button>
            <button onClick={() => setTheme("dark")} className={segBtn(theme === "dark")}>
              Dark
            </button>
          </div>
        </div>

        <div>
          <label className={labelCls}>Accent color</label>
          <div className="flex flex-wrap gap-2.5">
            {AVAILABLE_ACCENTS.map((acc) => (
              <button
                key={acc.hex}
                onClick={() => setAccent(acc.hex)}
                className="flex items-center gap-1.5 rounded-xl border px-3.5 py-2.5 text-xs font-bold transition-all hover:scale-105"
                style={{
                  borderColor: accent === acc.hex ? "var(--accent)" : "var(--border)",
                  backgroundColor: accent === acc.hex ? "var(--accent-6)" : "var(--surface)",
                }}
              >
                <span
                  className="inline-block h-3.5 w-3.5 rounded-full"
                  style={{ backgroundColor: acc.hex }}
                />
                <span className="text-[var(--ink)]">{acc.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className={labelCls}>Density</label>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setDensity("compact")} className={segBtn(density === "compact")}>
              Compact
            </button>
            <button onClick={() => setDensity("regular")} className={segBtn(density === "regular")}>
              Regular
            </button>
          </div>
        </div>

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
