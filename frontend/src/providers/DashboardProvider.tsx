"use client";

import * as React from "react";

import {
  readAppearanceCookie,
  writeAppearanceCookie,
} from "@/lib/appearance";
import { useBranding } from "@/hooks/useBranding";

type ToastType = "success" | "info" | "alert";
type Toast = { id: string; msg: string; type: ToastType };

export type DashboardContextValue = {
  // Appearance (synced to CSS variables). The accent follows the global brand
  // color (Settings → Branding); theme/density/radius are personal preferences.
  accent: string;
  theme: "light" | "dark";
  setTheme: (v: "light" | "dark") => void;
  density: "compact" | "regular";
  setDensity: (v: "compact" | "regular") => void;
  radius: number;
  setRadius: (v: number) => void;

  // Toasts (transient success/info/alert notifications).
  toasts: Toast[];
  pushToast: (msg: string, type?: ToastType) => void;
  dismissToast: (id: string) => void;
};

export const DashboardContext = React.createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  // The accent is the *global* brand color (Settings → Branding, stored
  // server-side), so the dashboard, login page and sent emails share one source
  // of truth. It's derived straight from branding — no local state to drift — so
  // a brand-color save updates the live --accent (below) with no reload, and it
  // matches the SSR'd <html> accent (no hydration flash). Theme/density/radius
  // stay per-device (cookie).
  const branding = useBranding();
  const accent = branding.brandColor;
  const [theme, setTheme] = React.useState<"light" | "dark">(
    () => readAppearanceCookie().theme,
  );
  const [density, setDensity] = React.useState<"compact" | "regular">(
    () => readAppearanceCookie().density,
  );
  const [radius, setRadius] = React.useState(() => readAppearanceCookie().radius);

  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const pushToast = React.useCallback(
    (msg: string, type: ToastType = "success") => {
      const id = Math.random().toString(36).slice(2, 7);
      setToasts((prev) => [...prev, { id, msg, type }]);
      setTimeout(
        () => setToasts((prev) => prev.filter((t) => t.id !== id)),
        4000,
      );
    },
    [],
  );

  const dismissToast = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Keep CSS variables in sync, and persist the personal prefs (theme/density/
  // radius) to the cookie so they survive reloads and SSR correctly next time.
  // The accent comes from server branding, so it isn't sourced from the cookie.
  React.useEffect(() => {
    const doc = document.documentElement;
    doc.style.setProperty("--accent", accent);
    doc.style.setProperty("--radius", `${radius}px`);
    doc.dataset.theme = theme;
    doc.dataset.density = density;
    writeAppearanceCookie({ theme, accent, density, radius });
  }, [accent, theme, density, radius]);

  const value: DashboardContextValue = {
    accent,
    theme,
    setTheme,
    density,
    setDensity,
    radius,
    setRadius,
    toasts,
    pushToast,
    dismissToast,
  };

  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
}
