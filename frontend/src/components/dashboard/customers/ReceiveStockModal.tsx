"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { WarehouseAssignment } from "@/types/customer";

export function ReceiveStockModal({
  assignment,
  itemName,
  onClose,
  onSaved,
}: {
  assignment: WarehouseAssignment;
  itemName: string;
  onClose: () => void;
  onSaved: (updated: WarehouseAssignment, stockEntryId: string) => void;
}) {
  const remaining = assignment.quantity - assignment.receivedQuantity;
  const [quantity, setQuantity] = React.useState(String(remaining));
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) return;
    if (qty > remaining) {
      setError(`Only ${remaining} remaining to receive.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await customerService.receiveStockAssignment(assignment.id, {
        receivedQuantity: qty,
        notes: notes.trim() || undefined,
      });
      onSaved(result.assignment, result.stockEntryId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record receipt.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Receive stock"
      subtitle={`${itemName} at ${assignment.warehouseName} — ${remaining} of ${assignment.quantity} remaining`}
      onClose={busy ? () => {} : onClose}
      size="sm"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>
            Cancel
          </button>
          <button
            type="submit"
            form="receive-form"
            disabled={busy || !parseInt(quantity, 10)}
            className={primaryBtn}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Receive
          </button>
        </>
      }
    >
      <form id="receive-form" onSubmit={submit} className="space-y-4">
        <div>
          <label className={labelCls}>
            Quantity received<RequiredMark />
          </label>
          <input
            type="number"
            min={1}
            max={remaining}
            step={1}
            className={inputCls}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            autoFocus
          />
        </div>
        <div>
          <label className={labelCls}>Notes</label>
          <textarea
            className={inputCls}
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional — delivery reference, condition notes, etc."
            maxLength={2000}
          />
        </div>
        {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}
      </form>
    </Modal>
  );
}
