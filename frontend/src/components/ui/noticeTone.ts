// Severity tiers for the inline <Notice> banner, kept as a pure lookup so the mapping is testable
// without a DOM (this app's suite is Node-only) — the same split as jobAge.ts's ageTone/AGE_TONE_CLS.
//
// Notice used to be a boolean (`success ? green : red`), so every message that wasn't a success
// rendered as a hard error — including advisories that explicitly tell the user they can carry on.
// The tiers below exist so a message's LOOK matches what it is actually saying:
//
//   error   — broken or blocked. Something failed, or you cannot proceed.
//   warn    — nothing is blocked, but something is WRONG, degraded, or costing you: overdue hired
//             kit, a cancelled job with stock still out, counts that failed to load, a truncated
//             export. Carries the caution triangle, and should keep carrying it.
//   info    — nothing is wrong at all. A fact about what the user has just chosen, or a consequence
//             of it, stated so they can act on it if they want to.
//   success — the thing they asked for worked.
//
// WHY `info` HAD TO EXIST. Amber + a caution triangle is this app's danger-adjacent signal, used for
// low_stock, overdue and in_progress badges as well as here. Two advisories on the van-stock composer
// were borrowing it to say things that are not problems — "you already have an open request for this,
// you can still send it" and "this collects from 2 warehouses, you'll need 2 stops". Both describe a
// perfectly valid choice, and both REASSURE in their own text; opening them with a danger glyph read
// as an alarm the sentence then withdrew.
//
// The cost of that was not only the fright. Fourteen of the sixteen amber messages in this app are
// real cautions — hired kit past its return date, still billing. Spending the same amber on routine
// facts is what makes the urgent one stop standing out. This tier protects those, as much as it calms
// these.

export type NoticeType = "info" | "success" | "warn" | "error";

export const NOTICE_TONE_CLS: Record<NoticeType, string> = {
  // The accent, at the same 10% wash every other tier uses. Deliberately NOT `--surface-2`, which was
  // the obvious "neutral" pick and is #fafafa against a #ffffff card — a banner nobody would see is
  // not a calmer banner, it is a missing one. Deliberately NOT a new blue either: this app has no blue
  // semantic token, and inventing one to carry two messages is a new visual system for no gain.
  // `--accent` is defined once rather than per-theme, so this reads correctly in dark mode for the
  // same reason the amber tier does.
  info: "bg-[var(--accent)]/10 text-[var(--accent)]",
  success: "bg-[var(--pos)]/10 text-[var(--pos)]",
  // Amber rather than a new token: ~50 components already use text-amber-600 for advisory text, so
  // folding those bare <p> warnings into Notice costs no visual change.
  warn: "bg-amber-500/10 text-amber-600",
  error: "bg-[var(--neg)]/10 text-[var(--neg)]",
};

// A Notice does two jobs and they want different densities.
//
//  • "md" — the reply to "I pressed Save", sitting at the foot of a form. It has earned the room, and
//    it is the shape all the existing bare <Notice msg={…} /> call sites were written against, so it
//    stays the default.
//  • "xs" — a line INSIDE a read-only detail card, among 11px labels and 14px values. At sm it read
//    as the loudest thing on the card, louder than the figures it was commenting on. 11px is the
//    register every inline hint in the app already uses (hintCls in styles.ts).
//  • "sm" — a footnote pinned to something else on the page (a table row, a picker). At md, two
//    stacked advisories took up more height than the three items they were commenting on. Matches the
//    text-[11px]/text-xs register the surrounding inline hints already use, and rounded-LG, since
//    that is this app's radius for the compact control family (see toolbarBtn in styles.ts).
export type NoticeSize = "xs" | "sm" | "md";

export const NOTICE_SIZE_CLS: Record<NoticeSize, string> = {
  xs: "gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px]",
  sm: "gap-1.5 rounded-lg px-3 py-2 text-xs",
  md: "gap-2 rounded-xl px-3.5 py-2.5 text-sm",
};
