"use client";

import * as React from "react";
import { createPortal } from "react-dom";

import { FOCUSABLE_SELECTOR, leavesPanel, tabOutTarget } from "./focusOrder";
import {
  anchorCovered,
  anchorVisible,
  popoverPlacement,
  shouldReposition,
  viewportBox,
  type PlacementAlign,
  type PlacementCause,
} from "./popoverPlacement";
import { dropdownRadius, dropdownSurfaceCls } from "./styles";

// ── The floating half of a combobox ────────────────────────────────────────────────────────────
//
// Every search-and-pick control in the app (items, rental items, customer stock, master-data types,
// departments, job titles) is a trigger button plus a panel holding a search box and a list. They all
// rendered that panel the same way — `absolute z-30 mt-1 w-full`, a plain child of the field — and
// that is a bug they all shared, reported on the purchase-order form:
//
//   The page that scrolls is not the window; it is a container inside the dashboard shell. The form's
//   sticky header bar lives INSIDE that container at `z-20`, pinned across its top. Scroll an item
//   row up behind the bar with the dropdown open and the panel, glued to a trigger nobody can see any
//   more, painted straight across the header — an `absolute z-30` child outranks it — while its own
//   search box was clipped away under the topbar. The list hung there attached to nothing.
//
//   It showed on Purchase Orders and not on Purchase Requests for no better reason than form length:
//   the shorter form runs out of scroll before its item rows can reach the bar.
//
// An in-flow panel cannot fix this on its own. It is clipped by the scroll container, it is sized
// before anyone asks whether that much room exists below the trigger, and its z-index is a bet
// against whatever page chrome it happens to be under. So the panel moves to where the app's other
// floating panels already live — portalled to <body>, `position: fixed`, placed by popoverPlacement,
// following its trigger while that trigger is genuinely visible and dismissed the moment it is not.
// `FilterPopover` and `SitePicker` do exactly this; this component exists so the six comboboxes get
// it once rather than six hand-wired copies of it.
//
// WHAT IT DOES NOT OWN: the trigger, the list, the keyboard handling, and the meaning of "dismiss".
// Callers keep their own Escape/Enter/arrow behaviour, and `onDismiss` is theirs to interpret — some
// clear the search term as well as closing, some deliberately keep it.

/**
 * The panel height to plan for, in px — the cap it WANTS, not a measurement, exactly as
 * popoverPlacement documents. Declared rather than measured so placement is decided BEFORE the first
 * paint; measuring would mean showing the panel somewhere wrong for a frame.
 *
 * 352 is the tallest of the combobox panels as built: a ~58px search row, a list capped at
 * `max-h-64` (256px), and a footer note or create-row. Placement hands back the smaller of this and
 * the room its chosen side actually had, and the panel wears that as a `max-height` — so a panel with
 * three rows in it is still three rows tall, and one on a short window scrolls its list instead of
 * hanging off the screen.
 */
const PANEL_H = 352;

export function AnchoredPanel({
  anchorRef,
  open,
  onDismiss,
  id,
  className,
  panelHeight = PANEL_H,
  width = "anchor",
  align = "start",
  children,
}: {
  /** The trigger the panel hangs from — placement, dismissal and outside-click all key off it. */
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  /**
   * Close the panel. Called for a click outside, and when the trigger stops being visible — see the
   * scroll handler. NOT called for Escape: that key belongs to whatever has focus inside.
   */
  onDismiss: () => void;
  /** Forwarded to the panel element, for a trigger whose `aria-controls` points at it. */
  id?: string;
  className?: string;
  /** Override only for a panel meaningfully taller or shorter than the combobox family. */
  panelHeight?: number;
  /**
   * "anchor" (default) makes the panel exactly as wide as its trigger — what `w-full` meant when the
   * panel still lived inside the field, and what every combobox here wants.
   *
   * "content" leaves the width to the panel's own classes, for a MENU hanging off a small button: a
   * `w-44` action list or a `min-w-[13rem]` filter menu would be squeezed to the width of the pill
   * that opens it. Placement then measures what the panel actually came out as.
   */
  width?: "anchor" | "content";
  /** "end" pins the panel to the trigger's right edge — for the menus that were `absolute right-0`. */
  align?: PlacementAlign;
  children: React.ReactNode;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  /** The trigger's rect as of the last placement — see the scroll handler for why it is kept. */
  const lastRect = React.useRef<DOMRect | null>(null);
  // `onDismiss` is an inline arrow at every call site. Held in a ref so the listener effect depends
  // on `open` alone instead of tearing down and re-subscribing on every keystroke in the search box.
  const dismissRef = React.useRef(onDismiss);
  React.useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  /**
   * Place the panel by WRITING ITS STYLES, rather than by holding the placement in state.
   *
   * Two reasons, and the first is the load-bearing one: a panel whose position lived in state would
   * have to set that state the moment `open` arrives as a prop, and setState in an effect body is a
   * cascading render this project's React-Compiler lint rejects outright. Placement is also exactly
   * the case the rule carves out — pushing React's state into an external system, here the DOM.
   *
   * The second is that a scroll then costs no render at all. The panel is repainted by the browser at
   * new coordinates while the list inside it, which can be twenty-five search results deep, is left
   * completely alone.
   *
   * Both axes are written every time, blanking the side that lost. A flip from below the trigger to
   * above it sets `bottom` — and a stale `top` left behind from the previous placement would stretch
   * the panel between the two.
   */
  const place = React.useCallback(
    (anchor: HTMLElement) => {
      const panel = panelRef.current;
      if (!panel) return;
      const rect = anchor.getBoundingClientRect();
      // Matching the trigger's width is now an explicit measurement: a `fixed` panel cannot inherit
      // `w-full` from a field it is no longer inside. A "content"-width menu instead reports what it
      // laid out as — readable here because the panel is already in the DOM, just not yet visible.
      const panelWidth = width === "anchor" ? rect.width : panel.offsetWidth;
      const at = popoverPlacement(
        rect,
        { width: panelWidth, height: panelHeight },
        // The ICB, not `window.innerWidth` — see viewportBox for the 6px that costs.
        viewportBox(),
        align,
      );
      if (width === "anchor") panel.style.width = `${rect.width}px`;
      panel.style.left = at.left === undefined ? "" : `${at.left}px`;
      panel.style.right = at.right === undefined ? "" : `${at.right}px`;
      panel.style.top = at.top === undefined ? "" : `${at.top}px`;
      panel.style.bottom = at.bottom === undefined ? "" : `${at.bottom}px`;
      panel.style.maxHeight = at.maxHeight === undefined ? "" : `${at.maxHeight}px`;
      // Only now is the panel allowed to be seen — see the className for why this is a data
      // attribute and not a style.
      panel.dataset.placed = "true";
      lastRect.current = rect;
    },
    [panelHeight, width, align],
  );

  // A LAYOUT effect: it runs after the panel is in the DOM but before the browser paints, so the
  // first frame anyone sees is already in the right place.
  React.useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!open || !anchor) return;
    place(anchor);
    // The search box is focused HERE, and not by an `autoFocus` on the input itself, because the
    // panel is `invisible` until `place` has run and a hidden element cannot take focus — React's
    // autoFocus fires during the commit, before this effect, and the browser simply declines it.
    // Every one of these panels exists to be typed into immediately, so losing that focus is not a
    // detail; it left the caret on <body> and the first thing typed went nowhere.
    //
    // preventScroll, as in FilterPopover and SitePicker: the panel wears a height cap, so it can be
    // a scrolling box, and letting the browser bring the freshly focused box "into view" would
    // scroll the search row off the top of it.
    panelRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [open, anchorRef, place]);

  React.useEffect(() => {
    if (!open) return;

    // FOLLOW the trigger; dismiss only when following it stops making sense.
    //
    // Three questions in order, because they fail differently:
    //
    //  1. Is the trigger still in the window? If not, the panel is floating beside nothing.
    //  2. Is anything painted OVER it? This is the reported bug — a trigger scrolled up behind the
    //     form's sticky header is still inside the window, so question 1 says yes, and the panel
    //     used to follow it up there and cover the header. A trigger clipped by a scroll container's
    //     overflow fails here too, which is the other way it ended up half under the topbar.
    //  3. Did it MOVE? A capture-phase scroll listener fires for scrolling anywhere in the document,
    //     including inside a <Select> that Base UI portals out of this panel. Re-placing on that is
    //     pointless churn; `shouldReposition` is what tells the two apart (and always re-places on a
    //     resize, where every number placement returns has just changed).
    const check = (cause: PlacementCause) => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      if (!anchorVisible(rect, { height: window.innerHeight })) {
        dismissRef.current();
        return;
      }
      if (anchorCovered(anchor, rect, panelRef.current)) {
        dismissRef.current();
        return;
      }
      if (!shouldReposition(cause, lastRect.current, rect)) return;
      place(anchor);
    };

    // Dismissing on mousedown OUTSIDE, which is what the six callers each did against their own
    // wrapper element. That check no longer works now the panel is portalled — the panel is not
    // inside the field any more, so "outside the field" would include clicking an option — hence
    // both refs are consulted. Deliberately still mousedown rather than a full-screen backdrop: a
    // click meant for the next field should land on that field, not be spent closing this panel.
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      // The trigger toggles itself on click; swallowing its mousedown here would fight that.
      if (anchorRef.current?.contains(target)) return;
      dismissRef.current();
    };

    const onScroll = () => check("scroll");
    const onResize = () => check("resize");
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("mousedown", onDown);

    // The trigger can change SIZE under an open panel, and no scroll or resize event says so: a
    // multi-select grows a line taller the moment its chips wrap, which is a pick made with the menu
    // still open. Nothing moved and the window is the same, so `shouldReposition` — rightly, for the
    // question it answers — says there is nothing to do, and the panel is left lying across the
    // bottom of the control it belongs to.
    //
    // Guarded because jsdom has no ResizeObserver; a component test that opens a dropdown would take
    // a TypeError on the constructor. Without it the panel simply keeps its opening position, which
    // is what it did before this existed.
    const sizeWatch =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const el = anchorRef.current;
            if (el) place(el);
          });
    if (anchorRef.current) sizeWatch?.observe(anchorRef.current);

    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousedown", onDown);
      sizeWatch?.disconnect();
    };
  }, [open, anchorRef, place]);

  /**
   * Tab out of the panel goes where Tab out of the FIELD would have gone.
   *
   * Portalling the panel put it after every other control in the document, which the eye never
   * notices and the Tab key cannot ignore: tabbing past the last row of an item picker halfway up a
   * form used to carry on to Quantity, and instead walked out of the page. In a dialog it was worse —
   * `Modal`'s trap sees focus land outside its own panel and pulls it back to the first field.
   *
   * Movement INSIDE the panel is left to the browser: four of these lists have no arrow-key
   * navigation, so Tab is the only way a keyboard reaches their options. Only the press that steps
   * off the edge is redirected — and it closes the panel, which is both the ARIA combobox rule and
   * the end of a long-standing annoyance where a tabbed-past popup hung over the fields below it
   * (see the same note in SuggestInput).
   *
   * EVERY Tab press stops here, though, whether it is redirected or not. While this panel is open it
   * owns the key, because `Modal` traps Tab on `document`: with focus inside a portalled panel its
   * trap reads "focus has escaped my dialog" and hauls it back to the dialog's first field, leaving
   * the dropdown open behind it. Tabbing from the search box to the first option in a dialog did
   * exactly that. Both calls are needed, and MultiSelect's Escape handler carries the same note for
   * the same reason: React's synthetic `stopPropagation` halts React handlers above this one, but
   * the App Router hydrates onto `document`, so React's delegated listener and Modal's own
   * `addEventListener` sit on the SAME target — and same-target listeners are only stopped by
   * `stopImmediatePropagation`.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!panel || !anchor) return;
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    const inPanel = [...panel.querySelectorAll(FOCUSABLE_SELECTOR)];
    if (!leavesPanel(inPanel, document.activeElement, e.shiftKey)) return;
    e.preventDefault();
    const target = tabOutTarget(
      [...document.querySelectorAll(FOCUSABLE_SELECTOR)],
      anchor,
      panel,
      e.shiftKey,
    );
    dismissRef.current();
    // Never drop focus: with nothing after the trigger, the trigger itself is the answer.
    (target instanceof HTMLElement ? target : anchor).focus();
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      onKeyDown={onKeyDown}
      /* z-[80] is the layer <Select> already portals its menu to, and for the same reason: these
         comboboxes are used inside dialogs (`Modal` is z-50), so anything lower would open the panel
         behind the form it belongs to. Toasts stay above at z-[99].

         A flex column, because the height cap arrives as a `max-height`: the search row keeps its
         size and the list underneath takes whatever room is left, scrolling inside it.

         `invisible` until `place` has run, flipped by a DATA ATTRIBUTE rather than by a style — every
         geometry property here belongs to `place` alone, and nothing this element declares may
         compete with it. A `top-0` sat here at first, as a fallback for the pre-paint frame, and it
         quietly broke every upward flip: `place` clears the inline `top` to hang the panel from
         `bottom` instead, the CLASS was still in force, and a box given both edges takes the top one
         — so a panel that should have opened just above its trigger was pinned to the top of the
         window, 350px away from it and across the page header. */
      /* NO `anim-fade-in`, unlike the menus that place themselves. It was added for consistency and
         taken straight back out: this panel is `invisible` until `place` has run, and a keyframe
         fade on an element that starts un-rendered does not reliably get a start time — measured on
         a clean load, the panel sat at the animation's opening frame (opacity 0, translateY(-4px),
         "running") 600ms after opening, i.e. simply not there, and how long it stayed that way
         varied run to run. An invisible dropdown is a far worse bug than a missing flourish, and
         these ten never animated before. The `invisible` guard stays; it is what stops a panel being
         painted at the wrong coordinates for a frame. */
      className={`fixed invisible z-[80] flex flex-col overflow-hidden data-[placed=true]:visible ${dropdownSurfaceCls} ${className ?? ""}`}
      style={dropdownRadius}
    >
      {children}
    </div>,
    document.body,
  );
}
