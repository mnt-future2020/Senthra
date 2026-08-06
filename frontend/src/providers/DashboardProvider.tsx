"use client";

import * as React from "react";

import {
  readAppearanceCookie,
  writeAppearanceCookie,
} from "@/lib/appearance";
import { useBranding } from "@/hooks/useBranding";

import { pushToastStack, type Toast, type ToastType } from "@/lib/toastStack";

// How long a toast survives. The STACK rules (merge a repeat, cap the total) live in lib/toastStack,
// which is pure and therefore testable — this suite has no DOM renderer.
const TOAST_MS = 4000;

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
  // `toastsRef` mirrors `toasts` and is the value pushToast READS. Deciding "is this message already
  // on screen?" needs the current list, but doing it inside a setState updater would put a setTimeout
  // in there — updaters must be pure, and StrictMode runs them twice, which would double every timer.
  // The ref is written synchronously by `commit`, so two pushes in one tick still see each other.
  const toastsRef = React.useRef<Toast[]>([]);
  const toastTimers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const toastSeq = React.useRef(0);

  React.useEffect(() => {
    const timers = toastTimers.current;
    return () => { for (const t of timers.values()) clearTimeout(t); };
  }, []);

  const commitToasts = React.useCallback((next: Toast[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const cancelToastTimer = React.useCallback((id: string) => {
    clearTimeout(toastTimers.current.get(id));
    toastTimers.current.delete(id);
  }, []);

  // (Re)start a toast's dismissal clock. Restarting matters for a repeat: the merged toast should
  // live from the LATEST occurrence, not disappear on the first one's timer.
  const scheduleToastDismiss = React.useCallback((id: string) => {
    cancelToastTimer(id);
    toastTimers.current.set(
      id,
      setTimeout(() => {
        toastTimers.current.delete(id);
        commitToasts(toastsRef.current.filter((t) => t.id !== id));
      }, TOAST_MS),
    );
  }, [cancelToastTimer, commitToasts]);

  const pushToast = React.useCallback(
    (msg: string, type: ToastType = "success") => {
      toastSeq.current += 1;
      const { toasts: next, keepAlive, dropped } = pushToastStack(
        toastsRef.current,
        msg,
        type,
        `t${toastSeq.current}`,
      );
      for (const id of dropped) cancelToastTimer(id);
      scheduleToastDismiss(keepAlive);
      commitToasts(next);
    },
    [cancelToastTimer, commitToasts, scheduleToastDismiss],
  );

  const dismissToast = React.useCallback((id: string) => {
    cancelToastTimer(id);
    commitToasts(toastsRef.current.filter((t) => t.id !== id));
  }, [cancelToastTimer, commitToasts]);

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
