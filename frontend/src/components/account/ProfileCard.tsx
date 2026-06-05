"use client";

import { ShieldCheck, User } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { labelCls } from "@/components/dashboard/settings/ui/styles";

// Colour the status pill by state — active reads positive, anything else muted.
const STATUS_STYLES: Record<string, string> = {
  active: "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]",
  inactive: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]",
  suspended: "border-[var(--neg)]/30 bg-[var(--neg)]/10 text-[var(--neg)]",
};

// Read-only view of the signed-in staff user's own profile. Name and role are
// managed by an administrator (no self-service edit endpoint by design), so this
// card displays them rather than editing them.
export function ProfileCard() {
  const { user } = useAuth();
  if (!user) return null;

  const initials =
    `${user.firstName[0] ?? ""}${user.lastName[0] ?? ""}`.toUpperCase() || "U";
  const statusCls = STATUS_STYLES[user.status] ?? STATUS_STYLES.inactive;

  return (
    <SettingsCard
      icon={User}
      title="Profile"
      desc="Your account details. Ask an administrator to change your name or role."
    >
      <div className="flex items-center gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-tr from-[#5b8def] to-[var(--accent)] text-base font-extrabold text-white shadow-sm select-none">
          {initials}
        </span>
        <div className="min-w-0">
          <p className="truncate text-base font-extrabold tracking-tight text-[var(--ink)]">
            {user.firstName} {user.lastName}
          </p>
          <p className="truncate text-sm text-[var(--muted)]">{user.email}</p>
        </div>
      </div>

      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <div>
          <p className={labelCls}>Role</p>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--accent)]/30 bg-[var(--accent-10)] px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wider text-[var(--accent)]">
            <ShieldCheck className="h-3 w-3" />
            {user.role?.name ?? "No role assigned"}
          </span>
        </div>
        <div>
          <p className={labelCls}>Account status</p>
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wider ${statusCls}`}
          >
            {user.status}
          </span>
        </div>
      </div>
    </SettingsCard>
  );
}
