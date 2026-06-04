"use client";

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

// Lightweight confirmation modal for destructive / irreversible actions.
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="anim-fade-in w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
              danger
                ? "bg-[var(--neg)]/10 text-[var(--neg)]"
                : "bg-[var(--accent-10)] text-[var(--accent)]"
            }`}
          >
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-extrabold text-[var(--ink)]">{title}</h3>
            <div className="mt-1 text-sm text-[var(--muted)]">{message}</div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60 ${
              danger ? "bg-[var(--neg)]" : "bg-[var(--accent)]"
            }`}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
