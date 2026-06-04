// Shared Tailwind class strings for the settings forms.
export const inputCls =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none transition-all placeholder:text-[var(--faint)] focus:border-[var(--accent)]";

export const labelCls =
  "mb-1.5 block text-xs font-bold uppercase tracking-wider text-[var(--muted)]";

// Helper text shown under a field to describe what it's for.
export const hintCls = "mt-1.5 text-[11px] leading-snug text-[var(--faint)]";

export const primaryBtn =
  "flex items-center gap-2 rounded-xl bg-[var(--accent)] px-5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60";

// Secondary / outline button used for inline actions (upload, copy, etc.).
export const ghostBtn =
  "flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60";
