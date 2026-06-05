"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2, ShieldCheck } from "lucide-react";

import * as roleService from "@/services/role.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import type { PermissionGroup, Role } from "@/types/role";
import { inputCls, labelCls, primaryBtn } from "@/components/dashboard/settings/ui/styles";
import { FormAsideCard, FormPageHeader, FormSection } from "./FormScaffold";

const ROLES_LIST = "/dashboard/users?tab=roles";

// The "view" action's key for a group (e.g. "users.view"), if it has one.
const viewKeyOf = (group: PermissionGroup): string | undefined =>
  group.permissions.find((p) => p.action === "View")?.key;

// Full-page Add/Edit role form: full-width two-column layout with a roomy
// permission matrix (scales as new modules add groups) and a live summary aside.
export function RoleForm({ mode, role }: { mode: "create" | "edit"; role?: Role | null }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();

  const isSystem = Boolean(role?.isSystem);
  const isFullAccess = role?.key === "super_admin" || (role?.permissions ?? []).includes("*");

  const [name, setName] = React.useState(role?.name ?? "");
  const [description, setDescription] = React.useState(role?.description ?? "");
  const [permissions, setPermissions] = React.useState<string[]>(role?.permissions ?? []);
  const [groups, setGroups] = React.useState<PermissionGroup[]>([]);
  const [catalogLoading, setCatalogLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    roleService
      .listPermissionGroups()
      .then((g) => {
        if (active) setGroups(g);
      })
      .catch(() => {
        // leave empty — the form still works without the catalog
      })
      .finally(() => {
        if (active) setCatalogLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Toggle one permission, keeping each module coherent: enabling any action also
  // enables its "View"; disabling "View" clears every action in that module.
  const togglePerm = (group: PermissionGroup, key: string) => {
    const viewKey = viewKeyOf(group);
    setPermissions((prev) => {
      const has = prev.includes(key);
      if (!has) {
        const next = [...prev, key];
        if (viewKey && key !== viewKey && !next.includes(viewKey)) next.push(viewKey);
        return next;
      }
      if (viewKey && key === viewKey) {
        const groupKeys = new Set(group.permissions.map((p) => p.key));
        return prev.filter((p) => !groupKeys.has(p));
      }
      return prev.filter((p) => p !== key);
    });
  };

  const permsChanged =
    [...permissions].sort().join(",") !== [...(role?.permissions ?? [])].sort().join(",");
  const isDirty =
    !saved &&
    (name !== (role?.name ?? "") ||
      description !== (role?.description ?? "") ||
      (!isFullAccess && permsChanged));

  useReportDirty("role-form", isDirty);

  const goBack = () => guard.attemptLeave(() => router.push(ROLES_LIST));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Role name is required.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        permissions: isFullAccess ? undefined : permissions,
      };
      if (mode === "edit" && role) await roleService.updateRole(role.id, payload);
      else await roleService.createRole(payload);
      setSaved(true);
      pushToast(mode === "edit" ? "Role saved." : "Role created.", "success");
      router.push(ROLES_LIST);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
      setSaving(false);
    }
  };

  // Granted actions grouped by module, for the live summary aside.
  const grantedByGroup = groups
    .map((g) => ({ label: g.label, actions: g.permissions.filter((p) => permissions.includes(p.key)) }))
    .filter((g) => g.actions.length > 0);

  const actions = (
    <>
      <button
        type="button"
        onClick={goBack}
        disabled={saving}
        className="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-60"
      >
        Cancel
      </button>
      <button type="submit" form="role-form" disabled={saving} className={primaryBtn}>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {mode === "edit" ? "Save changes" : "Create role"}
      </button>
    </>
  );

  return (
    <div className="space-y-6">
      <FormPageHeader
        title={mode === "edit" ? "Edit role" : "Add role"}
        subtitle={mode === "edit" ? (role?.key ?? undefined) : "Create a new role to assign to users."}
        onBack={goBack}
        actions={actions}
      />

      <form id="role-form" onSubmit={submit} className="grid gap-6 lg:grid-cols-3">
        {/* Main column */}
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Details">
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Role name</label>
                <input
                  className={inputCls}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Site Supervisor"
                  disabled={isSystem}
                />
                {isSystem && (
                  <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                    This is a built-in role — its name is fixed, but you can edit the description.
                  </p>
                )}
              </div>
              <div>
                <label className={labelCls}>Description</label>
                <textarea
                  className={inputCls}
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this role is for."
                />
              </div>
            </div>
          </FormSection>

          <FormSection
            title="Permissions"
            description="Pick what this role can do in each module. Choosing any action automatically includes “View”."
          >
            {isFullAccess ? (
              <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3 text-sm text-[var(--muted)]">
                <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                Full access — this role can do everything and can&apos;t be changed.
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
                        const checked = permissions.includes(p.key);
                        return (
                          <button
                            type="button"
                            key={p.key}
                            onClick={() => togglePerm(group, p.key)}
                            title={p.description}
                            aria-pressed={checked}
                            className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-all ${
                              checked
                                ? "border-[var(--accent)] bg-[var(--accent-10)] text-[var(--accent)]"
                                : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--border-2)] hover:text-[var(--ink)]"
                            }`}
                          >
                            {p.action}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </FormSection>

          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-[var(--neg)]/10 px-3.5 py-2.5 text-sm font-semibold text-[var(--neg)]">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        {/* Sticky aside: live summary */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <FormAsideCard title="Summary">
            <p className="truncate text-sm font-bold text-[var(--ink)]">{name.trim() || "Untitled role"}</p>
            {isFullAccess ? (
              <div className="mt-3 flex items-center gap-2 text-xs font-semibold text-[var(--accent)]">
                <ShieldCheck className="h-4 w-4" /> Full access
              </div>
            ) : (
              <>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  {permissions.length} permission{permissions.length === 1 ? "" : "s"} across{" "}
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
                    No permissions yet — a user with this role can sign in but won&apos;t see any
                    modules.
                  </p>
                )}
              </>
            )}
          </FormAsideCard>
        </aside>
      </form>
    </div>
  );
}
