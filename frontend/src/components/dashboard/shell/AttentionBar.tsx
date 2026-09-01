"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useAttention } from "@/hooks/useAttention";
import { clearedQuery, isChipActive } from "./attentionChip";
import type { AttentionItem, AttentionTone } from "@/services/attention.service";

// ── "What is that badge actually made of?" ─────────────────────────────────────────────────────
//
// A sidebar badge is a number with no nouns: "Warehouses 30" says work exists but not what it is, and
// the warehouse table has no column that explains it. This bar is the answer — it names every queue
// behind the number, shows each one's size, and opens it.
//
// ── Which of the two to use ───────────────────────────────────────────────────────────────────
//
// This one is the WORKLIST-PANEL form: a full-width block with no controls competing for the row, so
// every queue can be on screen at once. That is the dashboard's "Awaiting Your Action" panel, and it
// is the only place it is used.
//
// LIST SCREENS use <AttentionMenu> instead — same payload, same queues, same URL rules, folded behind
// one fixed-width trigger. A chip is a full sentence plus a number and a module can have ten of them:
// an unbounded row of alerts inside a toolbar wrapped on Jobs and starved the tab strip on Inventory.
// Don't reintroduce the bar there.
//
// It takes no props but `className`. It USED to accept `nav` and `keys` to narrow itself to one
// sidebar row's queues or a hand-picked set — the two modes the list screens needed. Those screens
// are the menu's now, and the panel wants every queue the actor has, so both went with them rather
// than sitting here as options nothing selects. <AttentionMenu> carries them, and is where to add
// another.
//
// "Account for", not "add up to": a chip declared as a SUBSET of another (`subsetOf` — "Critical
// stock" is the urgent slice of "Items to reorder", never a separate five items of work) is already
// inside its parent's number, exactly as the server's rollup treats it. Adding the two would claim
// more work than exists, so the subset chip says so in its tooltip instead of being silently dropped:
// a red one-line warning is the reason it earns a chip at all.
//
// A chip is also the FILTER, not just a link: when the current URL already matches a chip's target it
// renders as selected and clicking it clears back to the unfiltered list. That is why there is one
// chip row per screen rather than a "counts" row and a separate "filters" row saying the same thing
// twice.
//
// A chip with NO href renders as a plain, non-interactive number. Some queues are aggregates across
// many warehouses or customers and are worked on one entity's own page, so no screen holds the rows
// they counted. This component used to give those the bare module list, which looked and behaved like
// a link but narrowed nothing — and on the module's own page navigated to the page the user was
// already standing on. Showing the number and no affordance is the honest version; the way IN to that
// work is the per-row count on the list (useEntityAttention), not this bar.
//
// Reads the shared attention context: no fetch, no arithmetic, no permission logic (the server has
// already dropped every key this actor can't act on and every count that is zero). Renders nothing at
// all when there is no pending work, so a clear desk stays visually clear.

const MAX_CHIPS = 10;

const TONE_CHIP: Record<AttentionTone, string> = {
  critical: "bg-[var(--neg)]/12 text-[var(--neg)] hover:bg-[var(--neg)]/20",
  attention: "bg-amber-500/12 text-amber-600 hover:bg-amber-500/20",
  info: "bg-[var(--accent)]/12 text-[var(--accent)] hover:bg-[var(--accent)]/20",
};

/** Same colours, no hover state — a count with nowhere to go must not look pressable. */
const TONE_STATIC: Record<AttentionTone, string> = {
  critical: "bg-[var(--neg)]/12 text-[var(--neg)]",
  attention: "bg-amber-500/12 text-amber-600",
  info: "bg-[var(--accent)]/12 text-[var(--accent)]",
};

export function AttentionBar({ className }: { className?: string }) {
  const { attention } = useAttention();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const items = attention.items;
  if (items.length === 0) return null;

  // Server-sorted by tone then size, so the leftmost chip is the most urgent thing here.
  const shown = items.slice(0, MAX_CHIPS);
  const hidden = items.length - shown.length;

  // Both URL rules live in attentionChip.ts as pure functions — see the reasoning there.
  const isActive = (item: AttentionItem) => isChipActive(item.href, pathname, searchParams);
  const clear = (item: AttentionItem) => {
    const qs = clearedQuery(item.href, new URLSearchParams(searchParams.toString()));
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <div className={className ?? "flex flex-wrap items-center gap-1.5"}>
      {/* Names what the chips are, so the connection to the sidebar badge is stated rather than
          inferred. The TOTAL used to be printed here too — dropped: it restated the number already
          on the sidebar row about 200px to the left, and its width was what pushed a five-chip row
          onto a second line. The chips are what this row is for. */}
      <span className="mr-0.5 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
        Needs attention
      </span>
      {shown.map((item) => {
        const active = isActive(item);
        // Named so the chip can say what it is a slice OF. Looked up in `shown`, not `items`, so a
        // child that survived the MAX_CHIPS cut while its parent did not degrades to the plain
        // tooltip rather than printing a key nobody can see on screen.
        const parent = item.subsetOf ? shown.find((i) => i.key === item.subsetOf) : undefined;
        const subsetNote = parent ? ` — ${item.count} of the ${parent.count} in “${parent.label}”, not work on top of them` : "";
        const chip = (
          <>
            <span className="truncate">{item.label}</span>
            <span className="tabular-nums font-extrabold">{item.count}</span>
          </>
        );
        // Hover feedback belongs to things you can click. A static count keeps the tone colour (it
        // still says how urgent this is) and drops the affordance entirely — no pointer, no hover,
        // nothing to press.
        const cls = `inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
          active
            ? "bg-[var(--accent)] text-white transition-colors hover:opacity-90"
            : item.href
              ? `transition-colors ${TONE_CHIP[item.tone]}`
              : TONE_STATIC[item.tone]
        }`;
        if (!item.href) {
          return (
            <span
              key={item.key}
              title={`${item.label} — ${item.count}. Worked inside each record, so there is no one list to open.${subsetNote}`}
              className={cls}
            >
              {chip}
            </span>
          );
        }
        return active ? (
          <button key={item.key} type="button" aria-pressed onClick={() => clear(item)} title={`Showing ${item.label.toLowerCase()} — click to clear${subsetNote}`} className={cls}>
            {chip}
          </button>
        ) : (
          // A plain anchor, not router.push: middle-click and "open in new tab" are how people
          // actually work a queue list.
          <a key={item.key} href={item.href} title={`${item.label} — ${item.count}${subsetNote}`} className={cls}>
            {chip}
          </a>
        );
      })}
      {/* Never silently truncate: if the bar is capped, say by how much. */}
      {hidden > 0 ? <span className="px-1 text-[11px] font-semibold text-[var(--muted)]">+{hidden} more</span> : null}
    </div>
  );
}
