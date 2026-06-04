"use client";

import * as React from "react";
import { X } from "lucide-react";

// Reusable modal shell — header (title/subtitle + close), scrollable body and an
// optional footer. Closes on backdrop click or Escape.
export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = "lg",
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const max = size === "sm" ? "max-w-sm" : size === "md" ? "max-w-md" : "max-w-lg";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className={`my-8 w-full ${max} anim-fade-in rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border-2)] p-5">
          <div className="min-w-0">
            <h3 className="text-base font-extrabold tracking-tight text-[var(--ink)]">
              {title}
            </h3>
            {subtitle && <p className="mt-0.5 text-xs text-[var(--muted)]">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
            aria-label="Close"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>
        <div className="p-5">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-[var(--border-2)] p-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
