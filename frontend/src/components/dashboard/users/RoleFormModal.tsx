"use client";

import * as React from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import * as roleService from "@/services/role.service";
import type { Role } from "@/types/role";
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
  // Mounted only while open, so initial state comes straight from the role.
  const [name, setName] = React.useState(role?.name ?? "");
  const [description, setDescription] = React.useState(role?.description ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);

  const isDirty =
    name !== (role?.name ?? "") || description !== (role?.description ?? "");

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
      const payload = { name: name.trim(), description: description.trim() || undefined };
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
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this role is for."
            />
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
