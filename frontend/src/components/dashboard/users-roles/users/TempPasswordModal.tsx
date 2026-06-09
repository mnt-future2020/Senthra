"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";

import { ghostBtn, labelCls, primaryBtn } from "@/components/ui/styles";
import { Modal } from "@/components/ui/Modal";

// Shown once after creating a user or re-sending an invite — reveals the one-time
// temporary password (never shown again) with a copy button.
export function TempPasswordModal({
  open,
  email,
  password,
  isResend,
  onClose,
}: {
  open: boolean;
  email: string;
  password: string;
  isResend: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable — the value is visible to copy manually
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={isResend ? "Invite re-sent" : "User created"}
      subtitle={email}
      footer={
        <button onClick={onClose} className={primaryBtn}>
          Done
        </button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-[var(--muted)]">
          An account email has been sent to{" "}
          <strong className="text-[var(--ink)]">{email}</strong>. You can share the
          temporary password securely if needed — it won&apos;t be shown again.
        </p>
        <div>
          <label className={labelCls}>Temporary password</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 font-mono text-sm text-[var(--ink)]">
              {password}
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
