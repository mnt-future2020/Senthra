"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { EMAIL_RE, isPhone } from "@/lib/validation";
import type { CustomerUser } from "@/types/customer";

// Add / edit a customer portal / contact user — full name, email, phone,
// designation and status. One user type (no per-user roles for now).
export function CustomerUserModal({
  customerId,
  user,
  onClose,
  onSaved,
}: {
  customerId: string;
  user: CustomerUser | null; // null = create
  onClose: () => void;
  // On create, `temporaryPassword` carries the new login's one-time password.
  onSaved: (u: CustomerUser, temporaryPassword?: string) => void;
}) {
  const isEdit = Boolean(user);
  const [fullName, setFullName] = React.useState(user?.fullName ?? "");
  const [email, setEmail] = React.useState(user?.email ?? "");
  const [phone, setPhone] = React.useState(user?.phone ?? "");
  const [designation, setDesignation] = React.useState(user?.designation ?? "");
  const [status, setStatus] = React.useState<"active" | "inactive">(user?.status ?? "active");
  const [busy, setBusy] = React.useState(false);
  const [errs, setErrs] = React.useState<{ fullName?: string; email?: string; phone?: string }>({});
  const [error, setError] = React.useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const next: typeof errs = {};
    if (!fullName.trim()) next.fullName = "Full name is required.";
    if (!email.trim()) next.email = "Email is required.";
    else if (!EMAIL_RE.test(email.trim())) next.email = "Enter a valid email address.";
    if (phone.trim() && !isPhone(phone.trim())) next.phone = "Enter a valid UK phone number.";
    setErrs(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    try {
      const payload = {
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        designation: designation.trim() || undefined,
        status,
      };
      if (isEdit && user) {
        const updated = await customerService.updateCustomerUser(customerId, user.id, payload);
        onSaved(updated);
      } else {
        const { user: created, temporaryPassword } = await customerService.addCustomerUser(
          customerId,
          payload,
        );
        onSaved(created, temporaryPassword);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the user.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={isEdit ? "Edit user" : "Add user"}
      subtitle="A contact / portal user for this customer."
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" form="customer-user-form" disabled={busy} className={primaryBtn}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isEdit ? "Save changes" : "Add user"}
          </button>
        </>
      }
    >
      <form id="customer-user-form" onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelCls}>Full name<RequiredMark /></label>
            <input
              className={inputCls}
              value={fullName}
              onChange={(e) => {
                setFullName(e.target.value);
                setErrs((p) => ({ ...p, fullName: undefined }));
              }}
              placeholder="e.g. Jane Doe"
              maxLength={120}
              autoFocus
              aria-invalid={Boolean(errs.fullName)}
            />
            {errs.fullName && (
              <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{errs.fullName}</p>
            )}
          </div>
          <div>
            <label className={labelCls}>Email<RequiredMark /></label>
            <input
              type="email"
              className={inputCls}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setErrs((p) => ({ ...p, email: undefined }));
              }}
              placeholder="jane@customer.com"
              autoComplete="off"
              maxLength={160}
              aria-invalid={Boolean(errs.email)}
            />
            {errs.email && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{errs.email}</p>}
          </div>
          <div>
            <label className={labelCls}>Phone</label>
            <input
              type="tel"
              className={inputCls}
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setErrs((p) => ({ ...p, phone: undefined }));
              }}
              placeholder="07700 900000"
              maxLength={20}
              aria-invalid={Boolean(errs.phone)}
            />
            {errs.phone && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{errs.phone}</p>}
          </div>
          <div>
            <label className={labelCls}>Designation</label>
            <input
              className={inputCls}
              value={designation}
              onChange={(e) => setDesignation(e.target.value)}
              placeholder="e.g. Project Manager"
              maxLength={120}
            />
          </div>
          <div>
            <label className={labelCls}>Status</label>
            <select
              className={inputCls}
              value={status}
              onChange={(e) => setStatus(e.target.value as "active" | "inactive")}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>

        {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}
      </form>
    </Modal>
  );
}
