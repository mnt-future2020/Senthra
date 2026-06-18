"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { StockRequest } from "@/types/customer";

// Admin creates a stock submission on behalf of a customer (e.g. taken over the
// phone). Same queue + review flow as a portal-submitted one; the optional
// "requested by" captures the customer contact the admin spoke to.
export function AdminStockSubmissionModal({
  customerId,
  customerName,
  onClose,
  onCreated,
}: {
  customerId: string;
  customerName: string;
  onClose: () => void;
  onCreated: (request: StockRequest) => void;
}) {
  const [name, setName] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [requestedByName, setRequestedByName] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<{ name?: string; quantity?: string }>({});
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!name.trim()) errs.name = "Item name is required.";
    const qty = Number(quantity);
    if (!quantity.trim() || !Number.isInteger(qty) || qty < 1) {
      errs.quantity = "Enter a whole quantity of 1 or more.";
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setBusy(true);
    setError(null);
    try {
      const request = await customerService.createStockRequestForCustomer(customerId, {
        name: name.trim(),
        quantity: qty,
        requestedByName: requestedByName.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      onCreated(request);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the submission.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="New stock submission"
      subtitle={`Created on behalf of ${customerName}. Queued for the normal review flow.`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" form="admin-submission-form" disabled={busy} className={primaryBtn}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create submission
          </button>
        </>
      }
    >
      <form id="admin-submission-form" onSubmit={submit} className="space-y-4">
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
          <div>
            <label className={labelCls}>Requested by</label>
            <input
              className={inputCls}
              value={requestedByName}
              onChange={(e) => setRequestedByName(e.target.value)}
              placeholder="Customer contact (optional)"
              maxLength={160}
            />
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
