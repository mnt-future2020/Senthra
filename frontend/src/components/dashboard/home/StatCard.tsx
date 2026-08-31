import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Layers } from "lucide-react";

import { Sparkline } from "./Sparkline";
import { statCardDescribesSecondary, statCardLabel } from "./cardDestinations";

// A single KPI card: title, big count, optional secondary line (value or "N critical" chip), and an
// optional 8-week created-volume sparkline. Visual language mirrors reference/tabs/OverviewTab.tsx
// (CSS-variable themed, hover accent border).
//
// ── What a card OPENS ──────────────────────────────────────────────────────────────────────────
//
// Two shapes, and the difference is not cosmetic:
//
//   href    — the whole count opens on ONE pre-filtered list. The filter is the card's own predicate,
//             so the list's total is the number on the card. This is the normal case.
//   onOpen  — the count spans many entities and is WORKED inside one of them (Overdue Holdings is 6
//             jobs across three warehouses, chased from each warehouse's own Goods tab). There is no
//             single list, so the card opens a drill-down instead of pretending there is one. That is
//             the same rule the attention catalog applies to a count with nowhere honest to go.
//
// Exactly one of the two is required — a card is always openable, and never openable two ways. The
// icon says which: an out-arrow leaves for a list, stacked layers open a breakdown in place. They are
// the card's only decoration, and each of them means something.
//
// ── Why the card is a SHELL with a stretched primary control, not one big <Link> ────────────────
//
// It used to be a single anchor wrapping everything, which made two things impossible:
//
//   • A secondary line that is itself a QUEUE could not become a link, because an interactive element
//     inside an anchor is invalid HTML and unreachable by keyboard. "Expected This Week 0 · 9 overdue"
//     therefore printed its most urgent number with no way to reach it.
//   • The `aria-label` naming the card REPLACED the accessible name computed from its contents, so
//     "£2,819.52 committed" / "5 overdue · 2 due this week" / "2 critical" were announced to nobody.
//
// So: the shell is a plain <div>, the primary control covers it via `after:absolute after:inset-0`
// (the whole card is still one click target), and the secondary sits OUTSIDE that control as a
// sibling — described to assistive tech through `aria-describedby` when it is text, or lifted above
// the overlay with its own accessible name when it is an action.
type StatCardAction =
  | { href: string; onOpen?: never }
  | { onOpen: () => void; href?: never };

export type StatCardProps = {
  title: string;
  count: number;
  /**
   * NON-interactive detail. Announced with the card through `aria-describedby`, and clicks on it fall
   * through to the primary control, exactly as they did when the whole card was one anchor.
   */
  secondary?: React.ReactNode;
  /**
   * An ACTIONABLE secondary line — a second queue this card surfaces that its own destination does
   * NOT contain. Rendered above the primary control's overlay so it is clickable in its own right,
   * and it must carry its own accessible name (pass a link/button with real text).
   *
   * Use this ONLY when the value is genuinely unreachable from the card's own destination. A subset
   * — "5 overdue" inside Active Jobs, "2 critical" inside Low Stock — is already in the list the card
   * opens and marked there, so it stays plain `secondary`; making it a second link would offer two
   * destinations for one set of rows. Takes precedence over `secondary` when both are given.
   */
  secondaryAction?: React.ReactNode;
  spark?: number[];
  /**
   * What the card opens, said in words, for the accessible name — screen readers get
   * "Pending PRFs, 4. Open purchase requests awaiting Finance approval." rather than a bare number
   * followed by an unlabelled link. Describe the DESTINATION, not the click.
   */
  opens: string;
} & StatCardAction;

const SHELL_CLASS =
  "group relative flex flex-col justify-between gap-3 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs transition-colors hover:border-[var(--accent)] hover:shadow-md has-[:focus-visible]:border-[var(--accent)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]/40";

// The primary control. `after:inset-0` makes it cover the whole shell, so the card clicks as one
// target; the focus ring here is the fallback for browsers/builds where the shell's `has-` variant
// does not apply, so a keyboard user is never left without an indicator.
const PRIMARY_CLASS =
  "text-left after:absolute after:inset-0 after:z-10 after:rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40";

export function StatCard({ title, count, secondary, secondaryAction, spark, opens, href, onOpen }: StatCardProps) {
  const Icon = href ? ArrowUpRight : Layers;
  const secondaryId = React.useId();
  // Only PLAIN secondary text describes the card. An action has its own accessible name, and naming
  // it twice would have a screen reader read the queue out on the card and again on the link.
  const describes = statCardDescribesSecondary({
    hasSecondary: Boolean(secondary),
    hasSecondaryAction: Boolean(secondaryAction),
  });
  const describedBy = describes ? secondaryId : undefined;

  const header = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          <span className="truncate">{title}</span>
          {/* Muted at rest so a grid of eight cards doesn't read as a wall of arrows, and it takes
              the accent on hover/focus with the border — one affordance, two parts. `aria-hidden`
              because `opens` already says where this goes, in words. */}
          <Icon
            aria-hidden
            className="h-3 w-3 shrink-0 text-[var(--faint)] transition-colors group-hover:text-[var(--accent)]"
          />
        </div>
        <div className="mt-2 text-3xl font-extrabold text-[var(--ink)] tabular-nums">{count}</div>
      </div>
      {spark && spark.length > 0 ? (
        <div className="shrink-0 pt-1">
          <Sparkline data={spark} />
        </div>
      ) : null}
    </div>
  );

  // The count is inside the accessible name rather than left to be read off the page, so the control
  // announces what it measures, how many, and where it goes; `aria-describedby` adds the detail line.
  const label = statCardLabel(title, count, opens);

  return (
    <div className={SHELL_CLASS} style={{ borderRadius: "var(--radius)" }}>
      {href ? (
        <Link href={href} aria-label={label} aria-describedby={describedBy} className={PRIMARY_CLASS}>
          {header}
        </Link>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          aria-label={label}
          aria-describedby={describedBy}
          aria-haspopup="dialog"
          className={PRIMARY_CLASS}
        >
          {header}
        </button>
      )}

      {secondaryAction ? (
        // ABOVE the overlay (z-20 vs the `::after`'s z-10) so this line is genuinely clickable —
        // without it the stretched overlay would swallow every click meant for the action.
        <div className="relative z-20 text-sm text-[var(--muted)]">{secondaryAction}</div>
      ) : secondary ? (
        // Deliberately NOT raised: plain text belongs UNDER the overlay so a click on the words
        // opens the card, exactly as it did when the whole card was one anchor. Without the
        // overlay's `z-10` this text painted on top of it and swallowed those clicks, so the card
        // was live everywhere except the one line people read before deciding to open it.
        <div id={secondaryId} className="text-sm text-[var(--muted)]">
          {secondary}
        </div>
      ) : null}
    </div>
  );
}
