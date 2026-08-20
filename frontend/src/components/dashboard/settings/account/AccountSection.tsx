"use client";

import * as React from "react";
import { Loader2, ShieldCheck, User } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import * as authService from "@/services/auth.service";
import { useDashboard } from "@/hooks/useDashboard";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { Notice } from "@/components/ui/Notice";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Field } from "@/components/ui/Field";
import { inputCls, primaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";

export function AccountSection() {
  const { admin, refresh } = useAuth();
  const [email, setEmail] = React.useState(admin?.email ?? "");
  // The name printed on issued documents. `Admin.name` existed in the schema with no way to set it,
  // so a purchase order raised by a super admin was signed by an email address.
  const [name, setName] = React.useState(admin?.name ?? "");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  // ERRORS ONLY. A failure has to stay on screen until it is fixed; the success is a moment and
  // goes to a toast. Keeping both here left the receipt under the form while the user typed new
  // changes into it — a "saved" that had stopped being true, and this card has no dirty bar to
  // contradict it.
  const [msg, setMsg] = React.useState<Msg>(null);
  const { pushToast } = useDashboard();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    // Either field may be the one that changed — send only what actually did, so a name edit does
    // not re-submit the same email (which the server reads as no change at all).
    const emailChanged = email.trim().toLowerCase() !== (admin?.email ?? "");
    const nameChanged = name.trim() !== (admin?.name ?? "");
    if (!emailChanged && !nameChanged) {
      setMsg({ type: "error", text: "Change your name or email before saving." });
      return;
    }
    if (!currentPassword) {
      setMsg({ type: "error", text: "Enter your current password to confirm." });
      return;
    }
    setSaving(true);
    try {
      await authService.updateAccount(currentPassword, {
        ...(emailChanged ? { email } : {}),
        ...(nameChanged ? { name } : {}),
      });
      await refresh();
      setCurrentPassword("");
      pushToast(emailChanged && nameChanged ? "Account updated." : emailChanged ? "Email updated successfully." : "Name updated.");
    } catch (err) {
      setMsg({
        type: "error",
        text: err instanceof Error ? err.message : "Update failed.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={User}
      title="Account"
      badge={
        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)]/30 bg-[var(--accent-10)] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-[var(--accent)]">
          <ShieldCheck className="h-3 w-3" />
          Super Admin
        </span>
      }
      desc="The primary Super Admin login. Your name appears on the documents you issue."
    >
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Full name"
            hint="Printed as Prepared / Approved by on the purchase orders you issue. Left blank, they show your email instead."
          >
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="e.g. Shahul Hameed"
              className={inputCls}
            />
          </Field>
          <Field
            label="Email address"
            hint="You sign in and get security alerts here."
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field
            label="Current password"
            hint="Confirms the change is really you."
          >
            <PasswordInput
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Required to confirm"
              autoComplete="current-password"
            />
          </Field>
        </div>
        <Notice msg={msg} />
        <div className="flex justify-end">
          <button type="submit" disabled={saving} className={primaryBtn}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save changes
          </button>
        </div>
      </form>
    </SettingsCard>
  );
}
