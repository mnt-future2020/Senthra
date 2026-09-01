"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, TriangleAlert, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useAttention } from "@/hooks/useAttention";
import { countPillCls } from "@/components/ui/styles";
import { anchorMoved, anchorVisible, popoverPlacement, type Placement } from "@/components/ui/popoverPlacement";
import { clearedQuery, clearedQueryAll } from "./attentionChip";
import { activeItems, attentionRollup, triggerState } from "./attentionRollup";
import type { AttentionItem, AttentionTone } from "@/services/attention.service";

// ── The sidebar badge's breakdown, folded behind one control ───────────────────────────────────
//
// Same payload and same queues as <AttentionBar>, which this replaces on every LIST screen. The bar
// itself survives on the dashboard's worklist panel, where a full-width block with no competing
// controls is exactly the shape a chip row wants.
//
// Why a list screen needs the folded form instead:
//
// A chip is a full sentence plus a number — "Hires overdue for return 7" is ~190px, and a module can
// have up to ten. That is an unbounded row of alerts inside a bounded row of controls, and every
// screen was solving it differently and badly. On Jobs the chips sat between the filters and the New
// job button and simply wrapped, costing the line the inlining was meant to save AND crowding the
// filters. On Inventory they sat on the tab strip as `shrink-0`, so they took their width out of the
// TABS, which then had to scroll — primary navigation pushed off-screen to make room for alerts.
//
// So the trigger is fixed-width and states the total, and the queues move inside a panel that can
// scroll. That is the same bargain <FilterPopover> makes, and it carries the same obligation: hiding
// something is only safe if you can still tell at a glance that it is there. Hence a tone-coloured
// count on the trigger — a red 7 is still an alarm from across the room.
//
// FIXED WIDTH IN BOTH STATES, which took a second attempt. The applied queue was first rendered back
// beside the trigger as its own removable chip, on the reasoning that a narrowed list must never look
// like a short one. That put a ~230px sentence straight back into the slot this change existed to
// bound: on Inventory it ate the lens tab strip at 768px and left "All Invent…" at 425px — the
// original bug, reappearing in the active state.
//
// It was redundant as well as wide. Following an attention chip lands on the destination's OWN filter
// control, lit up, BY DESIGN — see the `custody` entry in OnHireView's filter list: "Hire damage &
// loss to settle" arrives with that register's Select already reading "To settle", "Jobs overdue"
// with the status Select on "Overdue". The chip was a second copy of state the page already showed.
//
// So the applied state lives ON the trigger, which BECOMES the applied queue: accent colours, a tick
// in place of the warning triangle, and the queue's own name and count in place of "Needs attention"
// and the backlog total.
//
// The name is there because the first fix went too far the other way. Colour-and-a-tick says that
// something is filtering the list but not WHICH, and the answer — the destination's own control, lit
// up — turned out to be undiscoverable in practice: on Purchase Orders the queue reads "Received —
// ready to close" while the Select two positions away reads "Ready to close", and nothing joins them.
// A control the user has to cross-reference to read has not been folded, only hidden.
//
// What keeps this from being the ~380px chip pair all over again is that the name replaces the label
// rather than sitting beside it, and is capped with `max-w` + truncate. Bounded in both states, which
// is the property the whole component exists for.
//
// Two things the row could not do that this can: the panel has no ten-chip cap (it scrolls, so
// "+3 more" — a number with no nouns, the exact problem this whole feature exists to fix — is gone),
// and a row has the width to explain itself, so a subset's warning and a no-destination count's note
// are visible text rather than a hover title nobody hovers.

/** Panel size, in px. Decided before first paint — see FilterPopover for why it isn't measured. */
const PANEL_W = 320;
const PANEL_H = 360;

const TONE_TRIGGER: Record<AttentionTone, string> = {
  critical: "border-[var(--neg)]/35 bg-[var(--neg)]/10 text-[var(--neg)]",
  attention: "border-amber-500/35 bg-amber-500/10 text-amber-600",
  info: "border-[var(--accent)]/35 bg-[var(--accent)]/10 text-[var(--accent)]",
};

const TONE_PILL: Record<AttentionTone, string> = {
  critical: "bg-[var(--neg)] text-white",
  attention: "bg-amber-500 text-white",
  info: "bg-[var(--accent)] text-white",
};

const TONE_DOT: Record<AttentionTone, string> = {
  critical: "bg-[var(--neg)]",
  attention: "bg-amber-500",
  info: "bg-[var(--accent)]",
};

const TONE_COUNT: Record<AttentionTone, string> = {
  critical: "bg-[var(--neg)]/12 text-[var(--neg)]",
  attention: "bg-amber-500/12 text-amber-600",
  info: "bg-[var(--accent)]/12 text-[var(--accent)]",
};

export function AttentionMenu({
  nav,
  keys,
  className,
}: {
  /** Limit to one sidebar row's queues. Omit for every queue the actor has. */
  nav?: string;
  /**
   * Limit to specific catalog keys, for a screen that owns only PART of a nav row. Takes precedence
   * over `nav`. (The GRN list is one of nine queues under Warehouses.)
   */
  keys?: readonly string[];
  className?: string;
}) {
  const { attention } = useAttention();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<Placement | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const anchorRef = React.useRef<DOMRect | null>(null);

  const items = keys
    ? attention.items.filter((i) => keys.includes(i.key))
    : nav
      ? attention.items.filter((i) => i.nav === nav)
      : attention.items;

  const rollup = attentionRollup(items);
  const applied = activeItems(items, pathname, searchParams);

  // `open` is INTENT; this is whether a panel can actually be on screen.
  //
  // The render below bails to null the moment this screen's last queue empties, but `open` is state
  // and survives that. A socket refresh that empties the queue while the panel is open — a colleague
  // closing the last order — would otherwise leave the panel merely hidden rather than closed, with
  // `aria-expanded` still claiming it was open and no trigger left to press.
  //
  // DERIVED during render rather than synced with an effect: `setOpen` inside an effect is a
  // cascading render, and this lint config rejects it (react-hooks/set-state-in-effect). Deriving is
  // also simply the correct shape — this is a fact about the current render, not a state to keep.
  const panelOpen = open && rollup !== null;

  const close = React.useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);

  const openPanel = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    anchorRef.current = rect;
    setPos(popoverPlacement(rect, { width: PANEL_W, height: PANEL_H }, { width: window.innerWidth, height: window.innerHeight }));
    setOpen(true);
  };

  // Identical to FilterPopover's: FOLLOW the anchor rather than dismissing on any scroll, because a
  // capture-phase scroll listener fires for scrolling anywhere in the document — including inside a
  // portalled popup that is not a descendant of this panel.
  React.useEffect(() => {
    if (!panelOpen) return;
    const onMove = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (!anchorVisible(rect, { height: window.innerHeight })) {
        setOpen(false);
        return;
      }
      if (!anchorMoved(anchorRef.current ?? rect, rect)) return;
      anchorRef.current = rect;
      setPos(popoverPlacement(rect, { width: PANEL_W, height: PANEL_H }, { width: window.innerWidth, height: window.innerHeight }));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("keydown", onKey);
    // The first QUEUE, not the Close button that precedes it in the DOM — opening this panel is how
    // you pick something to work on, so that is where the keyboard should land.
    (panelRef.current?.querySelector<HTMLElement>("ul a, ul button") ??
      panelRef.current?.querySelector<HTMLElement>("button"))?.focus();
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [panelOpen, close]);

  const go = (qs: string) => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  const clear = (item: AttentionItem) => go(clearedQuery(item.href, new URLSearchParams(searchParams.toString())));
  const clearAll = () =>
    go(clearedQueryAll(applied.map((i) => i.href), new URLSearchParams(searchParams.toString())));

  // No pending work, no control. A clear desk stays visually clear — and unlike the chip row, there
  // is no "NEEDS ATTENTION" label left behind announcing an empty set.
  if (!rollup) return null;

  // Is one of these queues what the screen is currently showing? Drives the trigger's whole applied
  // treatment — colour, icon, wording and accessible name — so they can never disagree.
  const { label, count, filtered } = triggerState(rollup.count, applied);
  const appliedNames = applied.map((i) => i.label).join(", ");

  return (
    <div className={className ?? "flex shrink-0 items-center gap-1.5"}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (panelOpen ? close() : openPanel())}
        aria-haspopup="dialog"
        aria-expanded={panelOpen}
        aria-label={
          filtered
            ? `Showing ${appliedNames} — ${count}. ${rollup.count} needing attention on this screen in total. Open to clear or switch queue.`
            : `Needs attention — ${rollup.count} across ${items.length} ${items.length === 1 ? "queue" : "queues"}`
        }
        // The label truncates; the tooltip does not. Whatever the width clips is one hover away, and
        // the accessible name above always carries it in full.
        title={
          filtered
            ? `Showing ${appliedNames.toLowerCase()} — ${count} of ${rollup.count} needing attention here. Open to clear or switch queue.`
            : `${rollup.count} needing attention on this screen — click for the breakdown`
        }
        className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs font-bold transition-all hover:opacity-85 ${
          filtered ? "border-[var(--accent)] bg-[var(--accent-10)] text-[var(--accent)]" : TONE_TRIGGER[rollup.tone]
        }`}
      >
        {/* A tick where the warning triangle sits, meaning what it means on the panel row below —
            this is what you are looking at — so the control and its menu read as one thing. */}
        {filtered ? <Check className="h-3.5 w-3.5 shrink-0" /> : <TriangleAlert className="h-3.5 w-3.5 shrink-0" />}
        {/* The applied queue's NAME once a filter is on, because accent-and-a-tick says only that
            something is filtering, not which thing — and a user who cannot answer "which" has to
            cross-reference the destination's own control to find out.
            TRUNCATED, not wrapped, and that cap is what keeps this whole control bounded: the first
            attempt put the name in a chip BESIDE the trigger at its natural width, which is how a
            ~380px pair ended up eating Inventory's tab strip. Hidden below `sm` (with the toolbar
            already stacked) so a phone keeps the tick-and-count form. */}
        {/* inline-BLOCK, not inline: `max-width` does nothing to a non-replaced inline box, so the cap
            above would be decorative. It happens to work today because a flex item is blockified
            anyway — which is exactly the kind of thing that breaks silently when the parent stops
            being a flex container. */}
        <span className="hidden max-w-[10rem] truncate sm:inline-block">{label}</span>
        {/* Pairs with the label: the total while the label is "Needs attention", that queue's own
            count once the label names a queue. The two must always describe the same thing — see
            triggerState, which is where the rule lives and is tested. */}
        <span className={`${countPillCls} shrink-0 ${filtered ? "bg-[var(--accent)] text-white" : TONE_PILL[rollup.tone]}`}>
          {count > 99 ? "99+" : count}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${panelOpen ? "rotate-180" : ""}`} />
      </button>

      {panelOpen &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[55]" onClick={close} />
            <div
              ref={panelRef}
              role="dialog"
              aria-label="Needs attention"
              className="anim-fade-in fixed z-[60] max-h-[min(24rem,70vh)] w-80 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-2xl"
              style={pos}
            >
              <div className="mb-1 flex items-center justify-between px-1 pt-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Needs attention</span>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close the attention breakdown"
                  className="rounded p-0.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* Server-sorted by tone then size, so the most urgent queue is the first row — and,
                  unlike the chip row, none of them is dropped for want of space. */}
              <ul className="flex flex-col">
                {items.map((item) => (
                  <li key={item.key}>
                    <QueueRow
                      item={item}
                      parent={item.subsetOf ? items.find((i) => i.key === item.subsetOf) : undefined}
                      active={applied.some((a) => a.key === item.key)}
                      onClear={() => {
                        clear(item);
                        close();
                      }}
                      onNavigate={close}
                    />
                  </li>
                ))}
              </ul>
              {/* The way OUT of a filter, in the same place FilterPopover puts it. The ticked row
                  above clears it too; this states the escape in words for anyone who did not read a
                  tick as "press me to undo". */}
              {filtered && (
                <button
                  type="button"
                  onClick={() => {
                    clearAll();
                    close();
                  }}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] py-1.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
                >
                  Clear {applied.length === 1 ? "this filter" : `these ${applied.length} filters`}
                </button>
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

/**
 * One queue. Three shapes, because a queue is one of three things and the row must not lie about
 * which: a link to its filtered list, the filter that is currently ON (press to clear), or a count
 * with no screen behind it — an aggregate worked inside each record, which gets no pointer, no hover
 * and a line saying where the work actually is.
 */
function QueueRow({
  item,
  parent,
  active,
  onClear,
  onNavigate,
}: {
  item: AttentionItem;
  /** The item this one is a slice OF, when that item is also in this menu. */
  parent?: AttentionItem;
  active: boolean;
  onClear: () => void;
  onNavigate: () => void;
}) {
  const body = (
    <>
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[item.tone]}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-bold text-[var(--ink)]">{item.label}</span>
        {parent && (
          // Earns its row by saying so: these rows are already inside the parent's number, and a
          // reader who adds the two gets a backlog that does not exist.
          <span className="mt-0.5 block text-[10px] leading-snug text-[var(--neg)]">
            {item.count} of the {parent.count} in &ldquo;{parent.label}&rdquo; — not work on top of them
          </span>
        )}
        {!item.href && (
          <span className="mt-0.5 block text-[10px] leading-snug text-[var(--faint)]">
            Worked inside each record — no single list to open.
          </span>
        )}
      </span>
      <span className={`${countPillCls} mt-px shrink-0 ${active ? "bg-[var(--accent)] text-white" : TONE_COUNT[item.tone]}`}>
        {item.count > 99 ? "99+" : item.count}
      </span>
      {active && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden />}
    </>
  );

  const cls = "flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors";

  if (!item.href) {
    return <span className={`${cls} cursor-default`}>{body}</span>;
  }
  if (active) {
    return (
      <button
        type="button"
        onClick={onClear}
        aria-pressed
        title="Click to clear this filter"
        className={`${cls} bg-[var(--accent-10)] hover:bg-[var(--surface-2)]`}
      >
        {body}
      </button>
    );
  }
  // A plain anchor, not router.push: middle-click and "open in new tab" are how people work a queue.
  return (
    <a href={item.href} onClick={onNavigate} className={`${cls} hover:bg-[var(--surface-2)]`}>
      {body}
    </a>
  );
}
