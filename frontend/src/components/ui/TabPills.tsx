"use client";

import * as React from "react";

/**
 * The pill switcher a module panel uses to move between its own tabs — Users / Roles / Departments /
 * Job titles, Customers / Categories, Suppliers / Types, and so on.
 *
 * Five panels carried this exact markup inline, byte for byte: the same rounded rail, the same
 * accent-filled active pill, the same icon-plus-label button. Nobody had a reason for five copies;
 * they simply grew one at a time. A change to how a selected tab looks now happens once.
 *
 * The caller still owns which tabs exist and which are permitted — this only draws them. It renders
 * nothing for a single tab, because a switcher with one option is a label pretending to be a control.
 *
 * ── The rail SCROLLS rather than clipping ─────────────────────────────────────────────────────
 *
 * It used to be a plain non-wrapping row, which is fine until the labels are wider than the phone.
 * Users & Roles is four pills and Rentals five; measured in Chrome at a 390px viewport, the rail
 * came out 418px wide and hung 44px past the right edge of the screen. Nothing there scrolls — the
 * shell's `#app` is `overflow-hidden` — so the far end of "Job titles" was simply cut off, with no
 * scrollbar to say so and no gesture that reached it. Not a cosmetic clip: a tab nobody could open.
 * The pills also shrank as far as they could first, wrapping their labels onto a second line and
 * standing the rail up to 48px tall, and still did not fit.
 *
 * The fix is the smallest one that keeps every tab reachable: the rail is a horizontal scroll
 * container, the pills refuse to shrink or wrap inside it, and the scrollbar is hidden the way the
 * Select popup already hides its own. Wrapping to a second line was the alternative and is wrong
 * here — the rail lives in the top bar, where a second line of chrome pushes the page down on the
 * screen that can least afford it. Nothing changes on a width where the pills already fit.
 *
 * The rail can only be narrower than its pills if its CONTAINER is allowed to be too — see the
 * `min-w-0` on the top bar's action slot in Topbar, which is half of this fix.
 */
export interface TabPillItem<Id extends string = string> {
  id: Id;
  label: string;
  icon: React.ElementType;
}

/**
 * How far to move a scrolling rail so a pill sits fully inside it: positive scrolls right, negative
 * left, `0` means it is already visible and the rail must not be touched.
 *
 * Deliberately arithmetic on two rects rather than `scrollIntoView`, which is free to scroll every
 * scrollable ANCESTOR as well — including the page — and would answer "reveal the active tab" by
 * jumping the whole dashboard. The caller adds this to `scrollLeft` and the browser clamps it, so
 * `pad` overshooting at either end costs nothing.
 *
 * A pill wider than the rail can satisfy both tests; the left one wins, because the start of a
 * label is the half that identifies it.
 */
export function railScrollDelta(
  rail: { left: number; right: number },
  pill: { left: number; right: number },
  pad = 4,
): number {
  if (pill.left < rail.left) return pill.left - rail.left - pad;
  if (pill.right > rail.right) return pill.right - rail.right + pad;
  return 0;
}

export function TabPills<Id extends string>({
  tabs,
  active,
  onSelect,
  ariaLabel,
}: {
  tabs: readonly TabPillItem<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Names the group for screen readers, e.g. "Users & Roles sections". */
  ariaLabel?: string;
}) {
  const railRef = React.useRef<HTMLDivElement>(null);
  const activeRef = React.useRef<HTMLButtonElement>(null);

  // Scroll the rail — and ONLY the rail — until this pill is fully inside it. See railScrollDelta
  // for why this is arithmetic on rects rather than scrollIntoView.
  const reveal = React.useCallback((pill: HTMLElement | null) => {
    const rail = railRef.current;
    if (!rail || !pill) return;
    const delta = railScrollDelta(rail.getBoundingClientRect(), pill.getBoundingClientRect());
    if (delta !== 0) rail.scrollLeft += delta;
  }, []);

  // Bring the selected pill into view — on mount too, so a shared `?tab=jobTitles` link opens on a
  // phone showing the tab it asked for rather than the first one.
  React.useEffect(() => {
    reveal(activeRef.current);
  }, [active, reveal]);

  // After the hooks, never before: a panel whose permissions collapse its tab list to one would
  // otherwise change how many hooks this component runs between two renders.
  if (tabs.length <= 1) return null;

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-label={ariaLabel}
      className="flex min-w-0 max-w-full gap-1 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((t) => {
        const selected = active === t.id;
        return (
          <button
            key={t.id}
            ref={selected ? activeRef : undefined}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(t.id)}
            // Tabbing to a pill must show it, and the browser cannot be trusted to do that on its
            // own: measured in Chrome, focusing the last Users & Roles pill scrolled the rail at a
            // 360px viewport and did nothing at 375 or 390, leaving the focus ring on something
            // off-view. Same arithmetic, run where a keyboard user actually needs it.
            onFocus={(e) => reveal(e.currentTarget)}
            className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-xs font-bold transition-all ${
              selected
                ? "bg-[var(--accent)] text-white shadow-xs"
                : "text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
