"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, X } from "lucide-react";

import { anchorMoved, anchorVisible, popoverPlacement, type Placement } from "./popoverPlacement";

/** Panel size, in px. Kept here (not measured) so placement is decided BEFORE the first paint — a
 *  measure-then-reposition would show the panel in the wrong place for a frame. `w-72` = 288px; the
 *  height is a working estimate for the flip-above decision, which only needs to be roughly right. */
const PANEL_W = 288;
const PANEL_H = 320;

// ── Secondary filters, folded behind one control ───────────────────────────────────────────────
//
// A filter row that wraps costs a whole band above the table. On a 1024px laptop the stock list ran
// search + five Selects + Export onto two rows, ~56px of a screen that was already showing four rows
// of data. The Selects were not the problem — their NUMBER was: most screens use one or two of them
// and the rest are set once a week.
//
// So the row keeps what people touch (search, and anything the caller leaves outside) and everything
// else moves in here, behind a trigger that states how many are ACTIVE. That count is the whole
// bargain: hiding a filter is only safe if you can still tell at a glance that it is on, otherwise a
// list silently shows a subset and nobody knows why it looks short.
//
// The same reasoning the warehouse Expected-deliveries menu already applies to its buckets, which is
// where this pattern comes from — generalised here because a second screen now needs it.

export function FilterPopover({
  activeCount,
  onClear,
  children,
  label = "Filters",
}: {
  /** How many of the filters inside are currently set. Rendered on the trigger. */
  activeCount: number;
  /** Reset every filter inside. Omit to hide the Clear action. */
  onClear?: () => void;
  children: React.ReactNode;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<Placement | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  /** The trigger's rect as of the last placement — see the scroll handler for why. */
  const anchorRef = React.useRef<DOMRect | null>(null);

  const close = React.useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);

  const openPanel = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Placement is decided by popoverPlacement, which prefers opening RIGHTWARD: this panel used to
    // right-align under a trigger in the middle of the toolbar and land on the Item column — hiding
    // the one column you read the list by, to show the controls meant to help you find it.
    // Portalled + fixed for the same reason the row menus are: a filter row inside a scrolling card
    // would otherwise clip it.
    anchorRef.current = rect;
    setPos(
      popoverPlacement(rect, { width: PANEL_W, height: PANEL_H }, { width: window.innerWidth, height: window.innerHeight }),
    );
    setOpen(true);
  };

  React.useEffect(() => {
    if (!open) return;
    // FOLLOW the trigger rather than dismissing on any scroll.
    //
    // The capture-phase `scroll` listener fires for scrolling anywhere in the document — including
    // inside a <Select> dropdown, which Base UI portals to <body>, outside this panel. Closing on
    // that event meant opening the warehouse list here and scrolling it destroyed the whole panel.
    // A containment check cannot help, because the portalled popup is not a descendant of the panel.
    //
    // So the handler asks the only question that matters: has the ANCHOR moved? Page scroll moves it
    // and we reposition; scrolling inside a popup doesn't and we do nothing. Dismissal is reserved
    // for the case the original rule was really aiming at — the trigger leaving the viewport, where
    // the panel would be floating beside nothing.
    const onMove = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (!anchorVisible(rect, { height: window.innerHeight })) {
        setOpen(false);
        return;
      }
      if (!anchorMoved(anchorRef.current ?? rect, rect)) return;
      anchorRef.current = rect;
      setPos(
        popoverPlacement(rect, { width: PANEL_W, height: PANEL_H }, { width: window.innerWidth, height: window.innerHeight }),
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLElement>("button, select, input")?.focus();
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? close() : openPanel())}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs font-bold transition-all ${
          activeCount > 0
            ? "border-[var(--accent)] bg-[var(--accent-10)] text-[var(--accent)]"
            : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
        }`}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {label}
        {/* The count is what makes folding these away safe — a narrowed list must never look like a
            short one. */}
        {activeCount > 0 && (
          <span className="rounded-full bg-[var(--accent)] px-1.5 py-px text-[10px] font-extrabold leading-none text-white tabular-nums">
            {activeCount}
          </span>
        )}
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[55]" onClick={close} />
            <div
              ref={panelRef}
              role="dialog"
              aria-label={label}
              className="anim-fade-in fixed z-[60] w-72 max-h-[min(20rem,70vh)] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-2xl"
              style={pos}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</span>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close filters"
                  className="rounded p-0.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* Stacked full-width: this is a form, not a toolbar, so the controls read top to
                  bottom and each gets the width its longest option needs. */}
              <div className="flex flex-col gap-2 [&>*]:w-full">{children}</div>
              {onClear && activeCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onClear();
                    close();
                  }}
                  className="mt-2 w-full rounded-lg border border-[var(--border)] py-1.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
                >
                  Clear {activeCount} filter{activeCount === 1 ? "" : "s"}
                </button>
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
