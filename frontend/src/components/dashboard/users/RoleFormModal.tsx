"use client";

import * as React from "react";
import { AlertCircle, Loader2, ShieldCheck } from "lucide-react";

import * as roleService from "@/services/role.service";
import type { PermissionDef, Role } from "@/types/role";
import { inputCls, labelCls, primaryBtn } from "@/components/dashboard/settings/ui/styles";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";

export function RoleFormModal({
  role,
  onClose,
  onSaved,
}: {
  role?: Role | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = Boolean(role);
  const isSystem = Boolean(role?.isSystem);
  // A full-access role carries "*". Its permissions are fixed (the backend won't
  // accept edits to super_admin), so the UI shows it read-only — and detecting it
  // by the "*" value, not just the super_admin key, means a "*" role can never be
  // rendered as checkboxes that would silently strip the wildcard on save.
  const isFullAccess = role?.key === "super_admin" || (role?.permissions ?? []).includes("*");

  // Mounted only while open, so initial state comes straight from the role.
  const [name, setName] = React.useState(role?.name ?? "");
  const [description, setDescription] = React.useState(role?.description ?? "");
  const [permissions, setPermissions] = React.useState<string[]>(role?.permissions ?? []);
  const [catalog, setCatalog] = React.useState<PermissionDef[]>([]);
  const [catalogLoading, setCatalogLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    roleService
      .listPermissionCatalog()
      .then((c) => {
        if (active) setCatalog(c);
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

  const togglePerm = (key: string) =>
    setPermissions((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
    );

  const groups = React.useMemo(() => {
    const m = new Map<string, PermissionDef[]>();
    for (const p of catalog) {
      const list = m.get(p.group) ?? [];
      list.push(p);
      m.set(p.group, list);
    }
    return [...m.entries()];
  }, [catalog]);

  const permsChanged =
    [...permissions].sort().join(",") !== [...(role?.permissions ?? [])].sort().join(",");
  const isDirty =
    name !== (role?.name ?? "") ||
    description !== (role?.description ?? "") ||
    (!isFullAccess && permsChanged);

  // Guard every dismissal so unsaved input isn't lost without a confirmation.
  const attemptClose = () => {
    if (saving) return;
    if (isDirty) setConfirmDiscard(true);
    else onClose();
  };

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
        // Don't send permissions for the fixed full-access role.
        permissions: isFullAccess ? undefined : permissions,
      };
      if (isEdit && role) await roleService.updateRole(role.id, payload);
      else await roleService.createRole(payload);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        open
        onClose={attemptClose}
        size="md"
        title={isEdit ? "Edit role" : "Add role"}
        subtitle={isEdit ? role?.key : "Create a new role to assign to users."}
        footer={
          <>
            <button
              type="button"
              onClick={attemptClose}
              disabled={saving}
              className="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-60"
            >
              Cancel
            </button>
            <button type="submit" form="role-form" disabled={saving} className={primaryBtn}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isEdit ? "Save changes" : "Create role"}
            </button>
          </>
        }
      >
        <form id="role-form" onSubmit={submit} className="space-y-4">
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

          <div>
            <label className={labelCls}>Permissions</label>
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
              <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
                {groups.map(([group, perms]) => (
                  <div key={group}>
                    <p className="mb-1.5 text-[11px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
                      {group}
                    </p>
                    <div className="space-y-0.5">
                      {perms.map((p) => (
                        <label
                          key={p.key}
                          className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--surface-2)]"
                        >
                          <input
                            type="checkbox"
                            checked={permissions.includes(p.key)}
                            onChange={() => togglePerm(p.key)}
                            className="mt-0.5 h-4 w-4 rounded accent-[var(--accent)]"
                          />
                          <span className="leading-tight">
                            <span className="block text-sm font-semibold text-[var(--ink)]">
                              {p.label}
                            </span>
                            <span className="block text-[11px] text-[var(--muted)]">
                              {p.description}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-[var(--neg)]/10 px-3.5 py-2.5 text-sm font-semibold text-[var(--neg)]">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmDiscard}
        danger
        title="Discard changes?"
        message="You have unsaved changes. If you close now, they'll be lost."
        confirmLabel="Discard"
        onConfirm={onClose}
        onClose={() => setConfirmDiscard(false)}
      />
    </>
  );
}
