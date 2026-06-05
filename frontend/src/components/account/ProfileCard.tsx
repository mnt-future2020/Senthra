"use client";

import { ListChecks, ShieldCheck } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { optimizeCloudinaryUrl } from "@/lib/utils";

// Status pill styling, keyed by state — active reads positive, anything else muted
// or negative. A small leading dot carries the colour so the label stays legible.
const STATUS: Record<string, { dot: string; text: string; label: string }> = {
  active: { dot: "bg-[var(--pos)]", text: "text-[var(--pos)]", label: "Active" },
  inactive: { dot: "bg-[var(--faint)]", text: "text-[var(--muted)]", label: "Inactive" },
  suspended: { dot: "bg-[var(--neg)]", text: "text-[var(--neg)]", label: "Suspended" },
};

// Read-only profile summary for the signed-in staff user, sized for the account
// page's sticky aside. Name and role are set by an administrator (no self-service
// edit by design), so this presents them. Shows the uploaded photo when present.
export function ProfileCard({ style }: { style?: React.CSSProperties }) {
  const { user } = useAuth();
  if (!user) return null;

  const initials = `${user.firstName[0] ?? ""}${user.lastName[0] ?? ""}`.toUpperCase() || "U";
  const status = STATUS[user.status] ?? STATUS.inactive;
  const access = user.permissions.includes("*")
    ? "Full access"
    : user.permissions.length === 0
      ? "No modules yet"
      : `${user.permissions.length} permission${user.permissions.length === 1 ? "" : "s"}`;

  return (
    <section
      className="border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xs"
      style={{ borderRadius: "var(--radius)", ...style }}
    >
      <div className="text-center">
        {/* Avatar */}
        <div className="flex justify-center">
          <span className="flex h-20 w-20 shrink-0 select-none items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-tr from-[#5b8def] to-[var(--accent)] text-xl font-extrabold text-white shadow-sm ring-1 ring-[var(--border)]">
            {user.profileImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={optimizeCloudinaryUrl(user.profileImageUrl)}
                alt={`${user.firstName} ${user.lastName}`}
                className="h-full w-full object-cover"
              />
            ) : (
              initials
            )}
          </span>
        </div>

        <h1 className="mt-3 truncate text-lg font-extrabold tracking-tight text-[var(--ink)]">
          {user.firstName} {user.lastName}
        </h1>
        <p className="truncate text-sm text-[var(--muted)]">{user.email}</p>

        <span
          className={`mt-3 inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1 text-[11px] font-extrabold uppercase tracking-wider ${status.text}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>

        {/* Role + effective access tiles. */}
        <dl className="mt-5 space-y-3 text-left">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
            <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
              Role
            </dt>
            <dd className="mt-1 flex items-center gap-1.5 truncate text-sm font-bold text-[var(--ink)]">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
              {user.role?.name ?? "No role assigned"}
            </dd>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
            <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
              Access
            </dt>
            <dd className="mt-1 flex items-center gap-1.5 truncate text-sm font-bold text-[var(--ink)]">
              <ListChecks className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
              {access}
            </dd>
          </div>
        </dl>

        <p className="mt-4 text-[11px] leading-relaxed text-[var(--faint)]">
          Your name, photo and role are managed by an administrator. Ask them if anything
          looks wrong.
        </p>
      </div>
    </section>
  );
}
