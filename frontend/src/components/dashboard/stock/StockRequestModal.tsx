"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { StockRequest } from "@/types/customer";

// Portal: a customer user submits a stock / replenishment REQUEST — an order ask, not
// a catalogue write. Item name, quantity and a business reason are mandatory; the
// request is queued for an internal reviewer to approve or reject. Approval never
// writes the catalogue or inventory directly.
export function StockRequestModal({
  onClose,
  onSubmitted,
}: {
  onClose: () => void;
  onSubmitted: (request: StockRequest) => void;
}) {
  const [name, setName] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<{ name?: string; quantity?: string; reason?: string }>(
    {},
  );
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!name.trim()) errs.name = "Item name is required.";
    const qty = Number(quantity);
    if (!quantity.trim() || !Number.isInteger(qty) || qty < 1) {
      errs.quantity = "Enter a whole quantity of 1 or more.";
    }
    if (!reason.trim()) errs.reason = "A business reason is required.";
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setBusy(true);
    setError(null);
    try {
      const request = await customerService.submitStockRequest({
        name: name.trim(),
        quantity: qty,
        reason: reason.trim(),
        notes: notes.trim() || undefined,
      });
      onSubmitted(request);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit the request.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Request stock"
      subtitle="Sent to your account team to review. Approval doesn't ship stock on its own."
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" form="stock-request-form" disabled={busy} className={primaryBtn}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Submit request
          </button>
        </>
      }
    >
      <form id="stock-request-form" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelCls}>
              Item name<RequiredMark />
            </label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErrors((p) => ({ ...p, name: undefined }));
              }}
              placeholder="e.g. SFP-LX optical module"
              maxLength={160}
              autoFocus
              aria-invalid={Boolean(errors.name)}
            />
            <FieldErr msg={errors.name} />
          </div>
          <div>
            <label className={labelCls}>
              Quantity<RequiredMark />
            </label>
            <input
              type="number"
              min={1}
              step={1}
              className={inputCls}
              value={quantity}
              onChange={(e) => {
                setQuantity(e.target.value);
                setErrors((p) => ({ ...p, quantity: undefined }));
              }}
              placeholder="e.g. 25"
              aria-invalid={Boolean(errors.quantity)}
            />
            <FieldErr msg={errors.quantity} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>
              Reason / business justification<RequiredMark />
            </label>
            <textarea
              className={inputCls}
              rows={2}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setErrors((p) => ({ ...p, reason: undefined }));
              }}
              placeholder="Why you need this — e.g. replenishment for the Leeds rollout."
              maxLength={1000}
              aria-invalid={Boolean(errors.reason)}
            />
            <FieldErr msg={errors.reason} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Notes</label>
            <textarea
              className={inputCls}
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional — anything else the reviewer should know."
              maxLength={2000}
            />
          </div>
        </div>

        {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}
      </form>
    </Modal>
  );
}

function FieldErr({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{msg}</p>;
}
