"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, AlertTriangle, Loader2, ShieldCheck } from "lucide-react";

import * as roleService from "@/services/role.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { reachabilityWarnings } from "@/lib/roleReachability";
import { applyImplied, capabilityGrant, grantableGroups, stripUngrantable } from "@/lib/permissionImplications";
import type { PermissionGroup, Role, RoleCapabilities } from "@/types/role";
import { inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PermissionMatrix } from "./PermissionMatrix";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";

const ROLES_LIST = "/dashboard/users?tab=roles";

// Full-page Add/Edit role form: full-width two-column layout with a roomy
// permission matrix (scales as new modules add groups) and a live summary aside.
export function RoleForm({ mode, role }: { mode: "create" | "edit"; role?: Role | null }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();
  const { can } = useAuth();

  // A role CAPABILITY isn't delegatable like a permission, so the backend reserves changing it for
  // a full-access actor. `can("*")` is exactly that test (it's true for the admin principal and for
  // a "*" holder). Everyone else sees the toggle read-only rather than not at all, so it stays
  // obvious WHY the Engineer Portal is or isn't on offer.
  const canChangeCapability = can("*");

  const isSystem = Boolean(role?.isSystem);
  const isFullAccess = role?.key === "super_admin" || (role?.permissions ?? []).includes("*");
  // A warehouse-scoped role isn't forced the global customers.view just for holding a customer-child
  // permission (e.g. stock_requests.* on the Warehouse Manager) — mirrors the backend. New roles
  // are never warehouse-scoped, so this is only ever true when editing an existing scoped role.
  const isWarehouseScoped = role?.isWarehouseScoped === true;

  const storedPermissions = React.useMemo(() => role?.permissions ?? [], [role?.permissions]);

  const [name, setName] = React.useState(role?.name ?? "");
  const [description, setDescription] = React.useState(role?.description ?? "");
  const [permissions, setPermissions] = React.useState<string[]>(storedPermissions);
  // Dirty-check baseline. Not simply `role.permissions`: a role saved before a dependency was
  // declared can hold an incoherent set (e.g. `engineer.jobs.accept` with no portal base), which
  // the closure repairs the moment the catalog loads. Comparing against the repaired set keeps the
  // form from opening "dirty" over a correction the admin never made.
  const [baseline, setBaseline] = React.useState<string[]>(storedPermissions);
  // Field-operations capability. New roles start off — a field role is a deliberate choice.
  const [canHoldStock, setCanHoldStock] = React.useState<boolean>(role?.canHoldStock ?? false);
  const [groups, setGroups] = React.useState<PermissionGroup[]>([]);
  const [categories, setCategories] = React.useState<string[]>([]);
  const [catalogLoading, setCatalogLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Coerce the loaded set to its implied closure once the catalog arrives, so the matrix and the
  // summary show exactly what a save would store rather than a stale incoherent set. Guarded by a
  // ref so a re-run can never clobber edits already in progress.
  const normalized = React.useRef(false);

  React.useEffect(() => {
    let active = true;
    roleService
      .listPermissionCatalog()
      .then(({ groups: g, categories: c }) => {
        if (!active) return;
        setGroups(g);
        setCategories(c);
        if (normalized.current || isFullAccess) return;
        normalized.current = true;
        // Closure first, then strip: a legacy role can hold Engineer Portal keys without the
        // field-operations capability (granted before the capability rule existed). Those keys are
        // dead — the server drops them on the next save — so the editor shows the truth up front.
        const closure = applyImplied(storedPermissions, g, isWarehouseScoped);
        const usable = stripUngrantable(closure, g, { field_ops: role?.canHoldStock ?? false });
        setPermissions(usable);
        setBaseline(usable);
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
  }, [isFullAccess, isWarehouseScoped, storedPermissions, role?.canHoldStock]);

  const capabilities = React.useMemo<RoleCapabilities>(
    () => ({ field_ops: canHoldStock }),
    [canHoldStock],
  );

  // Only the modules this role is capable of holding are offered. The Engineer Portal disappears
  // for a non-field role rather than sitting there grantable-but-useless.
  const visibleGroups = React.useMemo(
    () => grantableGroups(groups, capabilities),
    [groups, capabilities],
  );

  // Apply any matrix change (single toggle, row all/none, category bulk) and coerce the
  // result to its implied closure so the matrix mirrors exactly what the server stores.
  const onPermissionsChange = (next: string[]) =>
    setPermissions(applyImplied(next, groups, isWarehouseScoped));

  // Turning "Field role" OFF never touches the selection — the keys a non-field role can't hold are
  // filtered out of `effectivePermissions` below, so switching back on brings them straight back.
  //
  // The earlier version deleted the keys from state and kept a ref of what it deleted so it could
  // undo. That was broken twice over: a ref mutated INSIDE a setState updater is impure, and React
  // re-invokes updaters (StrictMode does it on every call in dev), so the second run read an
  // already-cleared ref and restored nothing. Deriving instead of deleting removes the problem
  // rather than patching it — and that is still how OFF works.
  //
  // Turning it ON now GRANTS the capability's modules and reveals them. The toggle's own copy says
  // it "offers the Engineer Portal permissions below", but the modules appeared collapsed and empty,
  // so the next step — scroll, find the section, expand it, tick everything — was manual every time
  // for the one outcome nearly every field role wants.
  //
  // Only when nothing in those modules is selected yet. That covers the case this exists for (a new
  // field role) while leaving a curated selection alone: an edit that toggles off and back on gets
  // its own picks restored, not silently replaced with everything.
  const [reveal, setReveal] = React.useState<string[] | undefined>(undefined);

  const onCapabilityChange = (next: boolean) => {
    setCanHoldStock(next);
    if (!next) return;
    const grant = capabilityGrant(groups, permissions, "field_ops");
    if (!grant) return; // nothing tagged, or the user has already curated it
    // Through applyImplied so the grant pulls in whatever these keys depend on, exactly as ticking
    // them by hand would.
    setPermissions(applyImplied([...new Set([...permissions, ...grant.keys])], groups, isWarehouseScoped));
    // A fresh array — the matrix keys its reveal effect on identity.
    setReveal(grant.categories);
  };

  // What a save would actually store: the selection minus anything this role's capabilities can't
  // support. Mirrors the server's splitByCapability, so the summary and the dirty check describe
  // the real outcome rather than the raw selection.
  const effectivePermissions = React.useMemo(
    () => stripUngrantable(permissions, groups, capabilities),
    [permissions, groups, capabilities],
  );

  const permsChanged =
    [...effectivePermissions].sort().join(",") !== [...baseline].sort().join(",");
  const capabilityChanged = canHoldStock !== (role?.canHoldStock ?? false);
  const isDirty =
    !saved &&
    (name !== (role?.name ?? "") ||
      description !== (role?.description ?? "") ||
      capabilityChanged ||
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

  // Revoking the field capability is the one edit here that reaches beyond this page: saving it
  // strips the Engineer Portal keys and every holder of the role loses the portal on web AND the
  // mobile app at once. Flipping the toggle itself is reversible (nothing is deleted until save),
  // so the confirmation belongs HERE, at the irreversible step, not on the toggle.
  const capabilityRevoked = mode === "edit" && role?.canHoldStock === true && !canHoldStock;
  // What the save would actually drop — the keys currently hidden by the revoke.
  const revokedPermissions = React.useMemo(() => {
    if (!capabilityRevoked) return [];
    const effective = new Set(effectivePermissions);
    return permissions.filter((k) => !effective.has(k));
  }, [capabilityRevoked, permissions, effectivePermissions]);
  // Nothing to lose (a field role with no portal keys and no holders) → don't manufacture friction.
  const needsRevokeConfirm =
    capabilityRevoked && (revokedPermissions.length > 0 || (role?.userCount ?? 0) > 0);

  const [confirmRevoke, setConfirmRevoke] = React.useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    const fieldErrors: Record<string, string> = {};
    if (!trimmed) fieldErrors.name = "Role name is required.";
    else if (trimmed.length > 60) fieldErrors.name = "Keep this under 60 characters.";
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      pushToast("Please fix the highlighted fields.", "alert");
      focusFirstInvalid();
      return;
    }
    setErrors({});
    if (needsRevokeConfirm) {
      setConfirmRevoke(true);
      return;
    }
    void save();
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        permissions: isFullAccess ? undefined : effectivePermissions,
        // Sent only when this actor may change it — a delegate is refused the field outright, so a
        // read-only toggle must not put its value on the wire.
        canHoldStock: canChangeCapability ? canHoldStock : undefined,
      };
      if (mode === "edit" && role) await roleService.updateRole(role.id, payload);
      else await roleService.createRole(payload);
      setSaved(true);
      pushToast(mode === "edit" ? "Role saved." : "Role created.", "success");
      router.replace(ROLES_LIST);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Save failed.");
      setSaving(false);
      setConfirmRevoke(false);
    }
  };

  // Granted actions grouped by module, for the live summary aside.
  const grantedByGroup = visibleGroups
    .map((g) => ({
      label: g.label,
      actions: g.permissions.filter((p) => effectivePermissions.includes(p.key)),
    }))
    .filter((g) => g.actions.length > 0);

  // Advisory: groups granted but unreachable in the UI without a host module's View (e.g. Goods
  // Management needs Warehouses view). Non-blocking — the role still saves. Skipped for full access.
  const reachability = isFullAccess ? [] : reachabilityWarnings(effectivePermissions);

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
              {/* Shown for a full-access role too: the capability is independent of permissions, and
                  a "*" role whose users do field work still has to be able to hold stock. Hiding it
                  there previously made the flag permanently unsettable for such a role. */}
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3">
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-[var(--ink)]">Field role</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
                        Its users can hold van stock, be assigned jobs, and use the Engineer Portal
                        (web + mobile). Turn this on to offer the Engineer Portal permissions below.
                      </p>
                      {!canChangeCapability && (
                        <p className="mt-1.5 text-[11px] font-semibold text-[var(--faint)]">
                          Only the super-admin can change this.
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={canHoldStock}
                      aria-label="Field role"
                      disabled={!canChangeCapability}
                      onClick={() => onCapabilityChange(!canHoldStock)}
                      className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 ${
                        canHoldStock ? "bg-[var(--accent)]" : "bg-[var(--faint)]"
                      }`}
                    >
                      {/* The knob needs an explicit `left` — a bare `absolute` span falls back to
                          its static position, which the button's centred text-align pushes to the
                          middle of the track (and the ON transform then off the end of it). */}
                      <span
                        aria-hidden
                        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform ${
                          canHoldStock ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                </div>
              </div>
            </div>
          </FormSection>

          <FormSection
            title="Permissions"
            description="Pick what this role can do in each module. Choosing an action automatically includes whatever it depends on — the module's “View”, and anything else needed to reach it."
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
            ) : visibleGroups.length === 0 ? (
              <p className="px-1 text-xs text-[var(--faint)]">No permissions available.</p>
            ) : (
              <PermissionMatrix
                groups={visibleGroups}
                catalog={groups}
                categories={categories}
                /* Raw selection, not the filtered one: the matrix only renders `visibleGroups`, so
                   a hidden module's keys are neither shown nor touched — they ride along in the
                   array and come straight back if the capability is switched on again. */
                granted={permissions}
                onChange={onPermissionsChange}
                /* Opens the modules that "Field role" just granted, so the tick marks land somewhere
                   the user can actually see rather than inside a collapsed section. */
                revealCategories={reveal}
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
                  {effectivePermissions.length} permission
                  {effectivePermissions.length === 1 ? "" : "s"} across{" "}
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

      <ConfirmDialog
        open={confirmRevoke}
        danger
        busy={saving}
        title="Turn off field role?"
        confirmLabel="Turn off & save"
        onClose={() => setConfirmRevoke(false)}
        onConfirm={() => void save()}
        /* Deliberately terse: the "Field role" card the admin just toggled already spells out what
           a field role can do, so repeating it here only buries the two numbers that decide the
           answer. State the consequence, show the counts, note it isn't a clean undo. */
        message={
          <>
            <p>
              <span className="font-bold text-[var(--ink)]">{role?.name}</span> stops being a field
              role.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-4 marker:text-[var(--faint)]">
              {(role?.userCount ?? 0) > 0 && (
                <li>
                  <span className="font-bold text-[var(--ink)]">
                    {role?.userCount} user{role?.userCount === 1 ? "" : "s"}
                  </span>{" "}
                  lose the Engineer Portal (web + mobile)
                </li>
              )}
              {revokedPermissions.length > 0 && (
                <li>
                  <span className="font-bold text-[var(--ink)]">
                    {revokedPermissions.length} permission
                    {revokedPermissions.length === 1 ? "" : "s"}
                  </span>{" "}
                  removed from the role
                </li>
              )}
            </ul>
            {/* Deliberately makes no promise about what happens if it is turned back on: the
                startup seed re-seeds the default Engineer Portal set for a field-ops role that
                holds none, so "won't restore them" was not reliably true. */}
            <p className="mt-2 text-[11px]">You can turn it back on later.</p>
          </>
        }
      />
    </div>
  );
}
