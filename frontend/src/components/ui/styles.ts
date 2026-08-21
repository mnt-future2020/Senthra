// Shared Tailwind class strings for forms across the dashboard.
export const inputCls =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none transition-all placeholder:text-[var(--faint)] focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-[var(--neg)] aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-[var(--neg)]/20";

export const labelCls =
  "mb-1.5 block text-xs font-bold uppercase tracking-wider text-[var(--muted)]";

// Helper text shown under a field to describe what it's for.
export const hintCls = "mt-1.5 text-[11px] leading-snug text-[var(--faint)]";

export const primaryBtn =
  "flex items-center gap-2 rounded-xl bg-[var(--accent)] px-5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60";

// Danger button — same shape as primary, red fill. For confirming a DESTRUCTIVE action (decline,
// delete). Signals the action's severity so it never reads the same as a positive primary.
export const dangerBtn =
  "flex items-center gap-2 rounded-xl bg-[var(--neg)] px-5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60";

// Secondary / outline button used for inline actions (upload, copy, etc.).
export const ghostBtn =
  "flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60";

// Secondary button sized to sit beside primaryBtn (same height/radius) — e.g. a
// Cancel/Discard next to Save. Outline style so the primary stays the clear default.
export const secondaryBtn =
  "flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-5 py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-60";

// ── List-toolbar controls ─────────────────────────────────────────────────────────────────────
// The compact family that sits in a list/filter row: a search box, one or more `<Select size="sm">`,
// and a Clear. All three MUST share `rounded-lg` + `py-2.5` + `text-xs` or the row looks ragged.
//
// This is deliberately NOT `inputCls` / `secondaryBtn`. Those belong to FORMS — `rounded-xl`,
// `text-sm`, and `px-5` on the button — and dropping them into a toolbar leaves the search box and
// the Clear visibly rounder and taller than the Select between them. The pattern was already
// established by hand in CustomersView / UsersView; naming it here stops the next toolbar guessing.
//
// Not for the PILL toolbars (pool chips, the GRN bucket filter): those are `rounded-full px-3
// py-1.5 text-[11px]` and a control from this family next to one of those is just as ragged.

/** Search input for a list toolbar. Pair with `pl-9` when it carries a leading search icon. */
export const toolbarInputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs text-[var(--ink)] outline-none transition-all placeholder:text-[var(--faint)] focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Date input for a list toolbar. Same `rounded-lg` / `py-2.5` / `text-xs` family as the search box and
 * `<Select size="sm">`, so a From/To pair sits level with the controls beside it. Wrap it in a
 * `<label>` carrying the From/To word — a bare date input gives no clue which end of the range it is.
 */
export const toolbarDateCls =
  "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60";

/** Button sized to sit in a list toolbar beside a `<Select size="sm">` — e.g. Clear, Export CSV. */
export const toolbarBtn =
  "flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-60";

/**
 * The toolbar's PRIMARY action — "Submit stock", "Move stock". Accent fill so it reads as the
 * page's main verb, but on `toolbarBtn`'s geometry (`rounded-lg`, `py-2.5`, `text-xs`) rather than
 * `primaryBtn`'s form geometry (`rounded-xl`, `px-5`), which sits visibly taller and rounder than
 * the Select and Clear beside it.
 */
export const toolbarPrimaryBtn =
  "flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60";

/**
 * Wrapper that pushes a toolbar's ACTIONS to the right-hand end of the row, away from the filters.
 *
 * Page actions live here rather than in the top bar via `<PageActions>`. The top bar is right for a
 * TabPills switcher — navigation, which people scan for at the top — but an action that operates on
 * the list is a different thing: on a wide screen the top bar's right edge is most of a screen away
 * from the rows it acts on, and it sits close enough to the browser's own chrome to read as part of
 * it. The toolbar row already exists and its right half is empty, so this costs no vertical space.
 *
 * The `ml-auto` that does the pushing is left to the CALL SITE, and must carry that toolbar's own
 * row breakpoint — `sm:ml-auto` on the portal lists, `lg:ml-auto` on the audit filter bar. Baking
 * one in here would push the group to the right edge while the toolbar was still stacked in a
 * column, leaving the actions marooned opposite the filters on exactly the narrow screens where
 * they should sit directly under them.
 */
export const toolbarActionsCls = "flex flex-wrap items-center gap-2";

/**
 * A COUNT PILL — the shape every pending-work number wears, wherever it appears.
 *
 * The height and the minimum width are stated, not inherited from padding, and that is the whole
 * point of the constant. Without them the badge's box was whatever its text happened to measure:
 * "9" came out ~18x18 and read as a circle, "28" came out ~24x18 and read as an oval, so one
 * sidebar column showed two different shapes depending on the number in it. `rounded-full` on a box
 * that is not square gives a stadium, never a circle — the round ones were an accident of padding.
 *
 * `min-w` equal to `h` makes a single digit a TRUE circle and lets 2–3 characters grow into a pill
 * of the same height, which is the convention every dense product uses for unbounded counts. A fixed
 * circle sized for "99+" was the alternative, and it leaves every single-digit badge sitting in an
 * oversized ring.
 *
 * Geometry only. TONE stays with the caller: the sidebar badge is solid and loud, the tab and row
 * counts are tinted and quiet, and that difference is deliberate.
 */
export const countPillCls =
  "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-extrabold leading-none tabular-nums";
