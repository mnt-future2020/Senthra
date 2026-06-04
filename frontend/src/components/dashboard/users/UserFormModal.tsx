"use client";

import * as React from "react";
import { AlertCircle, Loader2, Trash2, Upload } from "lucide-react";

import * as userService from "@/services/user.service";
import type { Role } from "@/types/role";
import type { User, UserStatus } from "@/types/user";
import {
  ghostBtn,
  inputCls,
  labelCls,
  primaryBtn,
} from "@/components/dashboard/settings/ui/styles";
import { Avatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

export function UserFormModal({
  mode,
  user,
  roles,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  user?: User | null;
  roles: Role[];
  onClose: () => void;
  onSaved: (result: { user: User; temporaryPassword?: string }) => void;
}) {
  // The parent mounts this only while open, so initial state comes straight from
  // the current user — no reset effect needed.
  const [firstName, setFirstName] = React.useState(user?.firstName ?? "");
  const [lastName, setLastName] = React.useState(user?.lastName ?? "");
  const [email, setEmail] = React.useState(user?.email ?? "");
  const [phone, setPhone] = React.useState(user?.phone ?? "");
  const [roleId, setRoleId] = React.useState(user?.role?.id ?? "");
  const [status, setStatus] = React.useState<UserStatus>(user?.status ?? "active");
  const [notes, setNotes] = React.useState(user?.notes ?? "");
  const [imageData, setImageData] = React.useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(
    user?.profileImageUrl ?? null,
  );
  const [removeImage, setRemoveImage] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Derived: has the user changed anything since the form opened? Used to guard
  // against accidentally discarding input by closing the dialog.
  const isDirty =
    firstName !== (user?.firstName ?? "") ||
    lastName !== (user?.lastName ?? "") ||
    email !== (user?.email ?? "") ||
    phone !== (user?.phone ?? "") ||
    roleId !== (user?.role?.id ?? "") ||
    status !== (user?.status ?? "active") ||
    notes !== (user?.notes ?? "") ||
    imageData !== null ||
    removeImage;

  // Every dismissal path (backdrop, Esc, ✕, Cancel) goes through here, so unsaved
  // input is never lost without a confirmation.
  const attemptClose = () => {
    if (saving) return;
    if (isDirty) setConfirmDiscard(true);
    else onClose();
  };

  const pickImage = async (file: File) => {
    setError(null);
    if (file.size > MAX_IMAGE_BYTES) {
      setError("Image must be under 2 MB.");
      return;
    }
    const data = await readFileAsDataUrl(file);
    setImageData(data);
    setPreviewUrl(data);
    setRemoveImage(false);
  };

  const removeAvatar = () => {
    setImageData(null);
    setPreviewUrl(null);
    setRemoveImage(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required.");
      return;
    }
    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
    setSaving(true);
    try {
      if (mode === "create") {
        const result = await userService.createUser({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          roleId: roleId || undefined,
          status,
          notes: notes.trim() || undefined,
          profileImage: imageData ?? undefined,
        });
        onSaved({ user: result.user, temporaryPassword: result.temporaryPassword });
      } else if (user) {
        const payload: userService.UpdateUserPayload = {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          roleId: roleId || null,
          status,
          notes: notes.trim(),
        };
        if (imageData) payload.profileImage = imageData;
        else if (removeImage) payload.removeProfileImage = true;
        const updated = await userService.updateUser(user.id, payload);
        onSaved({ user: updated });
      }
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
        title={mode === "create" ? "Add user" : "Edit user"}
        subtitle={
          mode === "create"
            ? "Create an account — sign-in details are emailed automatically."
            : (user?.email ?? undefined)
        }
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
            <button type="submit" form="user-form" disabled={saving} className={primaryBtn}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {mode === "create" ? "Create user" : "Save changes"}
            </button>
          </>
        }
      >
        <form id="user-form" onSubmit={submit} className="space-y-4">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <Avatar url={previewUrl} firstName={firstName || "?"} lastName={lastName} size={56} />
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className={ghostBtn}
                >
                  <Upload className="h-3.5 w-3.5" />
                  {previewUrl ? "Replace" : "Upload"}
                </button>
                {previewUrl && (
                  <button
                    type="button"
                    onClick={removeAvatar}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-[var(--muted)] transition-all hover:text-[var(--neg)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                )}
              </div>
              <span className="text-[11px] text-[var(--faint)]">
                PNG/JPG, max 2 MB. Optional.
              </span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickImage(f);
                e.target.value = "";
              }}
            />
          </div>

          {/* Name */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls}>First name</label>
              <input
                className={inputCls}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Alex"
              />
            </div>
            <div>
              <label className={labelCls}>Last name</label>
              <input
                className={inputCls}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Morgan"
              />
            </div>
          </div>

          {/* Contact */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Email address</label>
              <input
                type="email"
                className={inputCls}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alex@company.com"
                autoComplete="off"
              />
            </div>
            <div>
              <label className={labelCls}>Phone</label>
              <input
                type="tel"
                className={inputCls}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+44 7700 900000"
              />
            </div>
          </div>

          {/* Role + status */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Role</label>
              <select
                className={inputCls}
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
              >
                <option value="">No role</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Status</label>
              <select
                className={inputCls}
                value={status}
                onChange={(e) => setStatus(e.target.value as UserStatus)}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="suspended">Suspended</option>
              </select>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className={labelCls}>Notes</label>
            <textarea
              className={inputCls}
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional internal notes about this user."
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-[var(--neg)]/10 px-3.5 py-2.5 text-sm font-semibold text-[var(--neg)]">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {mode === "create" && (
            <p className="text-[11px] leading-relaxed text-[var(--faint)]">
              A secure temporary password is generated and emailed to the user
              automatically. You&apos;ll also see it once after creating.
            </p>
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
