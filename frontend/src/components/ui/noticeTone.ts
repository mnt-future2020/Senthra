// Severity tiers for the inline <Notice> banner, kept as a pure lookup so the mapping is testable
// without a DOM (this app's suite is Node-only) — the same split as jobAge.ts's ageTone/AGE_TONE_CLS.
//
// The middle tier is the point. Notice used to be a boolean (`success ? green : red`), so every
// message that wasn't a success rendered as a hard error — including advisories that explicitly tell
// the user they can carry on. Red is now reserved for "this is broken or blocked"; amber is
// "worth knowing, not in your way".

export type NoticeType = "success" | "warn" | "error";

export const NOTICE_TONE_CLS: Record<NoticeType, string> = {
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
//  • "sm" — a footnote pinned to something else on the page (a table row, a picker). At md, two
//    stacked advisories took up more height than the three items they were commenting on. Matches the
//    text-[11px]/text-xs register the surrounding inline hints already use, and rounded-LG, since
//    that is this app's radius for the compact control family (see toolbarBtn in styles.ts).
export type NoticeSize = "sm" | "md";

export const NOTICE_SIZE_CLS: Record<NoticeSize, string> = {
  sm: "gap-1.5 rounded-lg px-3 py-2 text-xs",
  md: "gap-2 rounded-xl px-3.5 py-2.5 text-sm",
};
