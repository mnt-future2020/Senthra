// Shared styling for the signed-out auth screens (login, the 2FA code step).
//
// These screens sit on AuthLayout rather than inside the dashboard shell, so they use their own
// input treatment instead of the one in components/ui/styles.ts. It lives here because the login
// form and the 2FA step are two halves of ONE flow that swap in place — the moment the string was
// copied into the second of them, the two could drift and the code field would stop matching the
// password field it replaced.
export const authInputCls =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none transition-all placeholder:text-[var(--faint)] focus:border-[var(--accent)]";
