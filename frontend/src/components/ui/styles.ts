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

/** Button sized to sit in a list toolbar beside a `<Select size="sm">` — e.g. Clear. */
export const toolbarBtn =
  "flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-60";
