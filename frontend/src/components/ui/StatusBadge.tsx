import type { UserStatus } from "@/types/user";

const MAP: Record<UserStatus, { label: string; cls: string; dot: string }> = {
  active: {
    label: "Active",
    cls: "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]",
    dot: "bg-[var(--pos)]",
  },
  inactive: {
    label: "Inactive",
    cls: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]",
    dot: "bg-[var(--faint)]",
  },
  suspended: {
    label: "Suspended",
    cls: "border-[var(--neg)]/30 bg-[var(--neg)]/10 text-[var(--neg)]",
    dot: "bg-[var(--neg)]",
  },
};

export function StatusBadge({ status }: { status: UserStatus }) {
  const s = MAP[status] ?? MAP.inactive;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ${s.cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
