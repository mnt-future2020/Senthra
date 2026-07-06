"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

// Focusable controls inside the dialog — used to seed initial focus and trap Tab.
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Reusable modal shell — header (title/subtitle + close), scrollable body and an
// optional footer. Closes on backdrop click or Escape. Announced to assistive tech as
// a dialog (role/aria-modal/labelledby); moves focus into the panel on open, traps Tab
// inside it, and restores focus to the trigger on close.
export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = "lg",
  scrollBody = false,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  // Opt-in: cap the panel to the viewport with a FIXED header/footer and an internally-scrolling body
  // (for tall content). OFF by default because an internally-scrolling body CLIPS any in-flow (non-
  // portaled) dropdown rendered inside it — so only pass this on modals whose controls portal their
  // menus (the shared Select) or use inline lists, never ones containing e.g. StockItemPicker.
  scrollBody?: boolean;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  // Route onClose through a ref so the focus effect depends only on `open` — callers
  // pass a changing onClose (e.g. `busy ? noop : onClose`), and re-running the effect
  // would otherwise clobber the captured trigger element and break focus restoration.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const titleId = React.useId();
  const subtitleId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []).filter(
        (el) => el.offsetParent !== null,
      );
    // Respect a form's own autoFocus; only pull focus in if nothing inside is focused.
    if (panel && !panel.contains(document.activeElement)) {
      (focusables()[0] ?? panel).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (active && !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Return focus to whatever opened the dialog (if it's still in the document).
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  const max = size === "sm" ? "max-w-sm" : size === "md" ? "max-w-md" : "max-w-lg";

  // Render through a portal to <body>: keeps the dialog (and any <form> it contains) OUT of whatever
  // parent it's declared in — so a modal opened from inside a page <form> can't nest forms or submit
  // the outer form, and the fixed overlay is never clipped by an ancestor's overflow/stacking context.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        className={`my-8 w-full ${max} anim-fade-in rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl outline-none ${scrollBody ? "flex max-h-[calc(100dvh-4rem)] flex-col overflow-hidden" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`flex items-start justify-between gap-4 border-b border-[var(--border-2)] p-5 ${scrollBody ? "shrink-0" : ""}`}>
          <div className="min-w-0">
            <h3 id={titleId} className="text-base font-extrabold tracking-tight text-[var(--ink)]">
              {title}
            </h3>
            {subtitle && (
              <p id={subtitleId} className="mt-0.5 text-xs text-[var(--muted)]">
                {subtitle}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
            aria-label="Close"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>
        {/* With scrollBody, the body scrolls INTERNALLY so the header + footer stay fixed on tall content
            (min-h-0 lets a flex child shrink below its content height so overflow-y-auto engages).
            Without it, the body is a plain block and the whole modal scrolls via the overlay (default). */}
        <div className={scrollBody ? "min-h-0 flex-1 overflow-y-auto p-5" : "p-5"}>{children}</div>
        {footer && (
          <div className={`flex justify-end gap-2 border-t border-[var(--border-2)] p-5 ${scrollBody ? "shrink-0" : ""}`}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
