"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2 } from "lucide-react";

// Focusable controls inside the dialog — used to seed initial focus and trap Tab. Same list as Modal.
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Lightweight confirmation modal for destructive / irreversible actions.
//
// Rendered through a PORTAL, like the full Modal shell, and both buttons carry an explicit
// type="button". Neither is cosmetic. A <button> with no type inside a <form> is a SUBMIT button, and
// this dialog used to render inline wherever it was declared — so putting a "Delete this?" confirm
// inside an edit form (the most natural place for one) made both Cancel AND Confirm submit that form.
// No call site does that today; RoleForm misses it by two lines, which is not a guarantee, it is luck.
// The portal also keeps `fixed inset-0` measured against the VIEWPORT: inside a transformed or
// overflow-hidden ancestor it would otherwise be positioned against that ancestor and end up clipped
// or offset. Stopping submit/reset at the panel closes the last route — React propagates events along
// the React tree, not the DOM tree, so a portal alone does not stop them reaching an outer form.
//
// It is also a real dialog to assistive tech and to the keyboard — role/aria-modal/labelledby, Escape
// to dismiss, focus moved in on open, Tab trapped inside, focus restored to the trigger on close.
// This carries the app's DESTRUCTIVE confirmations, so "keyboard user cannot reach the buttons, and
// screen-reader users are never told a question was asked" is the worst place to leave that gap. The
// behaviour is deliberately identical to Modal's rather than a lighter variant: two dialogs that
// answer Escape and Tab differently is its own bug.
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
  const panelRef = React.useRef<HTMLDivElement>(null);
  // Escape and backdrop dismissal go through refs so the focus effect depends only on `open`.
  // Callers pass a fresh onClose each render and re-running the effect would clobber the captured
  // trigger element, breaking focus restoration. `busy` rides along for the same reason: a confirm
  // in flight must not be dismissable, and reading it live avoids re-arming the listener each tick.
  const onCloseRef = React.useRef(onClose);
  const busyRef = React.useRef(busy);
  React.useEffect(() => {
    onCloseRef.current = onClose;
    busyRef.current = busy;
  }, [onClose, busy]);
  const titleId = React.useId();
  const messageId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []).filter(
        (el) => el.offsetParent !== null,
      );
    // Lands on Cancel (the first control), NOT the destructive button — a stray Enter on a "Delete
    // this?" dialog must not be what deletes it.
    if (panel && !panel.contains(document.activeElement)) {
      (focusables()[0] ?? panel).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Matches the backdrop: while the action is running there is nothing safe to cancel.
        if (!busyRef.current) onCloseRef.current();
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
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        className="anim-fade-in w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl outline-none"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => e.stopPropagation()}
        onReset={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
              danger
                ? "bg-[var(--neg)]/10 text-[var(--neg)]"
                : "bg-[var(--accent-10)] text-[var(--accent)]"
            }`}
          >
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 id={titleId} className="text-base font-extrabold text-[var(--ink)]">{title}</h3>
            <div id={messageId} className="mt-1 text-sm text-[var(--muted)]">{message}</div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
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
    </div>,
    document.body,
  );
}
