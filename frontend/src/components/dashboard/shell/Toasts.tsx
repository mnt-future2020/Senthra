"use client";

import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

import { useDashboard } from "@/hooks/useDashboard";

// Icon + accent per toast type, so an error doesn't look like a success.
const TOAST_ICON = {
  success: { Icon: CheckCircle2, cls: "text-emerald-500 bg-emerald-500/10" },
  alert: { Icon: AlertCircle, cls: "text-rose-500 bg-rose-500/10" },
  info: { Icon: Info, cls: "text-sky-500 bg-sky-500/10" },
} as const;

export function Toasts() {
  const d = useDashboard();
  return (
    <div className="fixed bottom-4 right-4 z-[99] flex flex-col gap-2 max-w-md w-full pointer-events-none">
      {d.toasts.map((t) => {
        const { Icon, cls } = TOAST_ICON[t.type] ?? TOAST_ICON.success;
        return (
          <div
            key={t.id}
            className="p-3 bg-gray-900 text-white dark:bg-white dark:text-gray-900 rounded-xl shadow-2xl flex items-center gap-2.5 animate-bounce pointer-events-auto border border-white/10"
          >
            <div className={`p-1 flex-none rounded-full ${cls}`}>
              <Icon className="w-4.5 h-4.5" />
            </div>
            <div className="flex-1">
              <p className="text-xs font-bold leading-normal">{t.msg}</p>
            </div>
            <button
              onClick={() => d.dismissToast(t.id)}
              className="p-0.5 text-gray-400 hover:text-white dark:text-gray-500 dark:hover:text-black transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
