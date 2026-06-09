"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, ShieldCheck } from "lucide-react";

import * as roleService from "@/services/role.service";
import { useAuth } from "@/hooks/useAuth";
import type { PermissionGroup, Role } from "@/types/role";
import { FormAsideCard, FormPageHeader, FormSection } from "@/components/ui/FormScaffold";

const ROLES_LIST = "/dashboard/users?tab=roles";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold text-[var(--ink)]">
        {empty ? <span className="text-[var(--faint)]">—</span> : value}
      </dd>
    </div>
  );
}

// Read-only role page: same chrome as the role form, but pure display — the
// permission matrix renders as non-interactive chips (granted highlighted).
// Reached from the Roles list "View" action; gated by roles.view.
export function RoleDetail({ role }: { role: Role }) {
  const router = useRouter();
  const { admin, can } = useAuth();
  const isFullAccess = role.key === "super_admin" || role.permissions.includes("*");

  const [groups, setGroups] = React.useState<PermissionGroup[]>([]);
  const [catalogLoading, setCatalogLoading] = React.useState(true);

  React.useEffect(() => {
    let active = true;
    roleService
      .listPermissionGroups()
      .then((g) => active && setGroups(g))
      .catch(() => {})
      .finally(() => active && setCatalogLoading(false));
    return () => {
      active = false;
    };
  }, []);

  // Mirrors the list's rule: system roles are admin-only to edit; a delegate can
  // edit a custom role only if it grants nothing beyond its own permissions.
  const manageable = Boolean(admin) || role.permissions.every((p) => can(p));
  const editable = role.isSystem ? Boolean(admin) : can("roles.edit") && manageable;

  const grantedByGroup = groups
    .map((g) => ({
      label: g.label,
      actions: g.permissions.filter((p) => role.permissions.includes(p.key)),
    }))
    .filter((g) => g.actions.length > 0);

  return (
    <div className="space-y-6">
      <FormPageHeader
        title="Role details"
        subtitle={role.key}
        onBack={() => router.push(ROLES_LIST)}
        actions={
          editable ? (
            <button
              onClick={() => router.push(`/dashboard/roles/${role.key}/edit`)}
              className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90"
            >
              <Pencil className="h-4 w-4" /> Edit
            </button>
          ) : null
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main column */}
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Details">
            <dl className="grid gap-5 sm:grid-cols-2">
              <Field label="Name" value={role.name} />
              <Field label="Type" value={role.isSystem ? "System (built-in)" : "Custom"} />
              <Field label="Users" value={String(role.userCount)} />
              <Field label="Key" value={role.key} />
              <div className="sm:col-span-2">
                <Field label="Description" value={role.description} />
              </div>
            </dl>
          </FormSection>

          <FormSection title="Permissions" description="What this role can do in each module.">
            {isFullAccess ? (
              <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3 text-sm text-[var(--muted)]">
                <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                Full access — this role can do everything.
              </div>
            ) : catalogLoading ? (
              <div className="flex items-center gap-2 px-1 py-2 text-xs text-[var(--faint)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading permissions…
              </div>
            ) : groups.length === 0 ? (
              <p className="px-1 text-xs text-[var(--faint)]">No permissions available.</p>
            ) : (
              <div className="divide-y divide-[var(--border-2)] overflow-hidden rounded-xl border border-[var(--border)]">
                {groups.map((group) => (
                  <div
                    key={group.key}
                    className="flex flex-col gap-2.5 p-4 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0 sm:pr-4">
                      <p className="text-sm font-bold text-[var(--ink)]">{group.label}</p>
                      <p className="text-[11px] text-[var(--muted)]">{group.description}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5 sm:justify-end">
                      {group.permissions.map((p) => {
                        const granted = role.permissions.includes(p.key);
                        return (
                          <span
                            key={p.key}
                            title={p.description}
                            className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-bold ${
                              granted
                                ? "border-[var(--accent)] bg-[var(--accent-10)] text-[var(--accent)]"
                                : "border-[var(--border)] text-[var(--faint)] opacity-60"
                            }`}
                          >
                            {p.action}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </FormSection>
        </div>

        {/* Sticky summary aside */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <FormAsideCard title="Summary">
            <p className="truncate text-sm font-bold text-[var(--ink)]">{role.name}</p>
            {isFullAccess ? (
              <div className="mt-3 flex items-center gap-2 text-xs font-semibold text-[var(--accent)]">
                <ShieldCheck className="h-4 w-4" /> Full access
              </div>
            ) : (
              <>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  {role.permissions.length} permission{role.permissions.length === 1 ? "" : "s"} across{" "}
                  {grantedByGroup.length} module{grantedByGroup.length === 1 ? "" : "s"}
                </p>
                {grantedByGroup.length > 0 ? (
                  <dl className="mt-4 space-y-2.5">
                    {grantedByGroup.map((g) => (
                      <div key={g.label}>
                        <dt className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                          {g.label}
                        </dt>
                        <dd className="mt-0.5 text-xs font-semibold text-[var(--ink)]">
                          {g.actions.map((a) => a.action).join(" · ")}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="mt-4 rounded-lg bg-[var(--surface-2)] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--muted)]">
                    No permissions — a user with this role can sign in but won&apos;t see any modules.
                  </p>
                )}
              </>
            )}
          </FormAsideCard>
        </aside>
      </div>
    </div>
  );
}
