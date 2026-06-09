"use client";

import * as React from "react";
import { Check, Copy, Loader2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { CustomerSummary } from "@/types/customer";
import type { Msg } from "@/components/ui/types";

// Create / edit a customer. On create it provisions the read-only login and
// reveals the one-time temporary password (the same data the customer is emailed).
//
// Mount this only while open (the parent conditional-renders it): state is seeded
// from `customer` via useState initializers, so each open starts fresh without a
// setState-in-effect seed.
export function CustomerFormModal({
  mode,
  customer,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  customer?: CustomerSummary;
  onClose: () => void;
  onSaved: (customer: CustomerSummary) => void;
}) {
  const [name, setName] = React.useState(customer?.name ?? "");
  const [email, setEmail] = React.useState(customer?.email ?? "");
  const [contactPerson, setContactPerson] = React.useState(customer?.contactPerson ?? "");
  const [phone, setPhone] = React.useState(customer?.phone ?? "");
  const [status, setStatus] = React.useState<"active" | "inactive">(
    (customer?.status as "active" | "inactive") ?? "active",
  );
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);
  // After a successful create, the one-time credentials to reveal.
  const [creds, setCreds] = React.useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!name.trim()) return setMsg({ type: "error", text: "Customer name is required." });
    if (!email.trim()) return setMsg({ type: "error", text: "Email is required." });

    setSaving(true);
    try {
      if (mode === "create") {
        const result = await customerService.createCustomer({
          name: name.trim(),
          email: email.trim(),
          contactPerson: contactPerson.trim() || undefined,
          phone: phone.trim() || undefined,
          status,
        });
        onSaved(result.customer);
        setCreds({ email: result.customer.email, password: result.temporaryPassword });
      } else if (customer) {
        const updated = await customerService.updateCustomer(customer.id, {
          name: name.trim(),
          email: email.trim(),
          contactPerson: contactPerson.trim() || undefined,
          phone: phone.trim() || undefined,
          status,
        });
        onSaved(updated);
        onClose();
      }
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!creds) return;
    try {
      await navigator.clipboard.writeText(creds.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable — the value is visible to copy manually
    }
  };

  // Credentials reveal (after a successful create).
  if (creds) {
    return (
      <Modal
        open
        onClose={onClose}
        size="md"
        title="Customer created"
        subtitle={creds.email}
        footer={
          <button onClick={onClose} className={primaryBtn}>
            Done
          </button>
        }
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-[var(--muted)]">
            A portal access email has been sent to{" "}
            <strong className="text-[var(--ink)]">{creds.email}</strong>. You can share the
            temporary password securely if needed — it won&apos;t be shown again.
          </p>
          <div>
            <label className={labelCls}>Temporary password</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 font-mono text-sm text-[var(--ink)]">
                {creds.password}
              </code>
              <button onClick={copy} className={ghostBtn}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={saving ? () => {} : onClose}
      size="md"
      title={mode === "create" ? "Add customer" : "Edit customer"}
      subtitle={mode === "edit" ? customer?.customerCode : "Provisions a read-only portal login"}
      footer={
        <>
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-60"
          >
            Cancel
          </button>
          <button onClick={submit} disabled={saving} className={primaryBtn}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {mode === "create" ? "Create customer" : "Save changes"}
          </button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Company name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. BT"
            className={inputCls}
            aria-required
          />
        </Field>
        <Field label="Login email" required hint="The customer signs in with this email.">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="pm@customer.com"
            className={inputCls}
            aria-required
          />
        </Field>
        <Field label="Contact person">
          <input
            value={contactPerson}
            onChange={(e) => setContactPerson(e.target.value)}
            placeholder="e.g. John Smith"
            className={inputCls}
          />
        </Field>
        <Field label="Phone">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g. 020 1234 5678"
            className={inputCls}
          />
        </Field>
        <Field label="Status">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as "active" | "inactive")}
            className={inputCls}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </Field>
        <Notice msg={msg} />
      </form>
    </Modal>
  );
}
