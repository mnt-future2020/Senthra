import { Lock } from "lucide-react";

// Shown at the top of a settings section when the user can view it but not edit it
// (holds *.view without *.manage). The inputs are also disabled, and the API
// enforces the real rule — this just explains why nothing can be changed.
export function ReadOnlyNotice({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-xs font-semibold text-[var(--muted)]">
      <Lock className="h-3.5 w-3.5 shrink-0" />
      {children ??
        "Read-only — you don't have permission to change this. Ask an administrator if you need access."}
    </div>
  );
}
