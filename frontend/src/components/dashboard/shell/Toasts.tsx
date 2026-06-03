"use client";

import { CheckCircle2, X } from "lucide-react";

import { useDashboard } from "@/hooks/useDashboard";

export function Toasts() {
  const d = useDashboard();
  return (
    <div className="fixed bottom-4 right-4 z-[99] flex flex-col gap-2 max-w-md w-full pointer-events-none">
      {d.toasts.map((t) => (
        <div
          key={t.id}
          className="p-3 bg-gray-900 text-white dark:bg-white dark:text-gray-900 rounded-xl shadow-2xl flex items-start gap-2.5 animate-bounce pointer-events-auto border border-white/10"
        >
          <div className="p-1 text-emerald-500 flex-none bg-emerald-500/10 rounded-full mt-0.5">
            <CheckCircle2 className="w-4.5 h-4.5" />
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
      ))}
    </div>
  );
}
