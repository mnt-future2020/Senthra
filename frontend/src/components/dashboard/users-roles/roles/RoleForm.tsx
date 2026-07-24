"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, AlertTriangle, Loader2, ShieldCheck } from "lucide-react";

import * as roleService from "@/services/role.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { reachabilityWarnings } from "@/lib/roleReachability";
import { applyImplied } from "@/lib/permissionImplications";
import type { PermissionGroup, Role } from "@/types/role";
import { inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { PermissionMatrix } from "./PermissionMatrix";

const ROLES_LIST = "/dashboard/users?tab=roles";

// Full-page Add/Edit role form: full-width two-column layout with a roomy
// permission matrix (scales as new modules add groups) and a live summary aside.
export function RoleForm({ mode, role }: { mode: "create" | "edit"; role?: Role | null }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();

  const isSystem = Boolean(role?.isSystem);
  const isFullAccess = role?.key === "super_admin" || (role?.permissions ?? []).includes("*");
  // A warehouse-scoped role isn't forced the global customers.view just for holding a customer-child
  // permission (e.g. stock_requests.* on the Warehouse Manager) — mirrors the backend. New roles
  // are never warehouse-scoped, so this is only ever true when editing an existing scoped role.
  const isWarehouseScoped = role?.isWarehouseScoped === true;

  const [name, setName] = React.useState(role?.name ?? "");
  const [description, setDescription] = React.useState(role?.description ?? "");
  const [permissions, setPermissions] = React.useState<string[]>(role?.permissions ?? []);
  const [groups, setGroups] = React.useState<PermissionGroup[]>([]);
  const [categories, setCategories] = React.useState<string[]>([]);
  const [catalogLoading, setCatalogLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    let active = true;
    roleService
      .listPermissionCatalog()
      .then(({ groups: g, categories: c }) => {
        if (active) {
          setGroups(g);
          setCategories(c);
        }
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

  // Apply any matrix change (single toggle, row all/none, category bulk) and coerce the
  // result to its implied closure so the matrix mirrors exactly what the server stores.
  const onPermissionsChange = (next: string[]) =>
    setPermissions(applyImplied(next, groups, isWarehouseScoped));

  const permsChanged =
    [...permissions].sort().join(",") !== [...(role?.permissions ?? [])].sort().join(",");
  const isDirty =
    !saved &&
    (name !== (role?.name ?? "") ||
      description !== (role?.description ?? "") ||
      (!isFullAccess && permsChanged));

  useReportDirty("role-form", isDirty);

  const goBack = () =>
    guard.attemptLeave(() => {
      if (window.history.length > 1) router.back();
      else router.push(ROLES_LIST);
    });

  // Surface errors as a toast (instant, scroll-independent) as well as inline — the
  // Save button is in the sticky header, far from the inline message at the bottom.
  const showError = (msg: string) => {
    setError(msg);
    pushToast(msg, "alert");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    const fieldErrors: Record<string, string> = {};
    if (!trimmed) fieldErrors.name = "Role name is required.";
    else if (trimmed.length > 60) fieldErrors.name = "Keep this under 60 characters.";
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      pushToast("Please fix the highlighted fields.", "alert");
      return;
    }
    setErrors({});
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
      router.replace(ROLES_LIST);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Save failed.");
      setSaving(false);
    }
  };

  // Granted actions grouped by module, for the live summary aside.
  const grantedByGroup = groups
    .map((g) => ({ label: g.label, actions: g.permissions.filter((p) => permissions.includes(p.key)) }))
    .filter((g) => g.actions.length > 0);

  // Advisory: groups granted but unreachable in the UI without a host module's View (e.g. Goods
  // Management needs Warehouses view). Non-blocking — the role still saves. Skipped for full access.
  const reachability = isFullAccess ? [] : reachabilityWarnings(permissions);

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
        {/* Main column — min-w-0 stops wide permission rows from forcing the
            track wider than its 2fr share (grid children default to min-width:auto). */}
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <FormSection title="Details">
            <div className="space-y-4">
              <div>
                <label className={labelCls}>
                  Role name
                  {!isSystem && <RequiredMark />}
                </label>
                <input
                  className={inputCls}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (errors.name) setErrors({});
                  }}
                  placeholder="e.g. Site Supervisor"
                  disabled={isSystem}
                  maxLength={60}
                  aria-required={!isSystem}
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? "role-name-error" : undefined}
                />
                {errors.name && (
                  <p
                    id="role-name-error"
                    className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]"
                  >
                    {errors.name}
                  </p>
                )}
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
              <PermissionMatrix
                groups={groups}
                categories={categories}
                granted={permissions}
                onChange={onPermissionsChange}
              />
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
                {reachability.length > 0 && (
                  <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-600">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      Won&apos;t be reachable
                    </div>
                    <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-[var(--muted)]">
                      {reachability.map((w) => (
                        <li key={w.label}>
                          <span className="font-semibold text-[var(--ink)]">{w.label}</span> lives
                          inside {w.hostLabel} — also grant {w.hostLabel} “View” so this role can
                          open it.
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </FormAsideCard>
        </aside>
      </form>
    </div>
  );
}
