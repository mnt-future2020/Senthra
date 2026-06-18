"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { StockRequest } from "@/types/customer";

export function EditApproveModal({
  customerId,
  request,
  onClose,
  onSaved,
}: {
  customerId: string;
  request: StockRequest;
  onClose: () => void;
  onSaved: (updated: StockRequest) => void;
}) {
  const [editedName, setEditedName] = React.useState(request.editedName ?? request.name);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editedName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await customerService.editAndApproveStockRequest(customerId, request.id, {
        editedName: editedName.trim(),
        note: note.trim() || undefined,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve the request.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Edit & approve request"
      subtitle={`Customer requested: "${request.name}" ×${request.quantity ?? "?"}`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" form="edit-approve-form" disabled={busy || !editedName.trim()} className={primaryBtn}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Approve
          </button>
        </>
      }
    >
      <form id="edit-approve-form" onSubmit={submit} className="space-y-4">
        <div>
          <label className={labelCls}>
            Corrected item name<RequiredMark />
          </label>
          <input
            className={inputCls}
            value={editedName}
            onChange={(e) => setEditedName(e.target.value)}
            maxLength={160}
            autoFocus
          />
          <p className="mt-1 text-[11px] text-[var(--faint)]">
            Edit the name if the customer typed something different from your catalogue.
          </p>
        </div>
        <div>
          <label className={labelCls}>Note to customer</label>
          <textarea
            className={inputCls}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional — shown to the customer on their portal."
            maxLength={500}
          />
        </div>
        {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}
      </form>
    </Modal>
  );
}
