"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { listWarehouses } from "@/services/warehouse.service";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { preferredWarehouseOptions, shouldShowPreferredWarehouse } from "@/lib/preferredWarehouse";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { ghostBtn, hintCls, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";
import {
  StockItemPicker,
  toStockItemOptions,
  type StockItemOption,
  type StockItemValue,
} from "@/components/dashboard/stock/StockItemPicker";
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
  const [item, setItem] = React.useState<StockItemValue>({ entryId: null, name: "" });
  const [options, setOptions] = React.useState<StockItemOption[]>([]);
  const [loadingItems, setLoadingItems] = React.useState(true);
  const [quantity, setQuantity] = React.useState("");
  const [requestedByName, setRequestedByName] = React.useState("");
  // What the customer asked for on the phone. Same PREFERENCE semantics as the portal field — the
  // reviewer still assigns the real destination — so it is optional and never pre-selected here:
  // an admin who wasn't told a warehouse must not have one guessed on the customer's behalf.
  const [warehouses, setWarehouses] = React.useState<{ id: string; name: string; code: string }[]>([]);
  const [warehousesLoaded, setWarehousesLoaded] = React.useState(false);
  const [preferredWarehouseId, setPreferredWarehouseId] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<{ name?: string; quantity?: string }>({});
  const [error, setError] = React.useState<string | null>(null);

  // This customer's existing stock — pick one to top up instead of creating a duplicate.
  React.useEffect(() => {
    let alive = true;
    customerService
      .listCustomerStockOptions(customerId)
      .then((entries) => alive && setOptions(toStockItemOptions(entries)))
      .catch(() => alive && setOptions([]))
      .finally(() => alive && setLoadingItems(false));
    return () => {
      alive = false;
    };
  }, [customerId]);

  // Active, non-deleted warehouses — the same set the portal offers, read through the staff service
  // this screen already has permission for. A failed lookup costs only the optional field.
  React.useEffect(() => {
    let alive = true;
    listWarehouses({ status: "active", pageSize: 200 })
      .then((r) => alive && setWarehouses(r.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))))
      .catch(() => alive && setWarehouses([]))
      .finally(() => alive && setWarehousesLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!item.name.trim()) errs.name = "Select an existing item or enter an item name.";
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
        name: item.name.trim(),
        quantity: qty,
        requestedByName: requestedByName.trim() || undefined,
        notes: notes.trim() || undefined,
        linkedStockEntryId: item.entryId ?? undefined,
        preferredWarehouseId: preferredWarehouseId || undefined,
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
          {/* Mirrors the portal's own Submit stock form — same field, same position, same wording —
              so a reviewer reading either submission sees the preference expressed the same way. */}
          {shouldShowPreferredWarehouse(warehousesLoaded, warehouses) && (
            <div className="sm:col-span-2">
              <label className={labelCls}>Preferred warehouse</label>
              <Select
                value={preferredWarehouseId}
                onChange={setPreferredWarehouseId}
                options={preferredWarehouseOptions(warehouses)}
                placeholder="No preference"
              />
              <p className={hintCls}>What the customer asked for. You still assign the final destination.</p>
            </div>
          )}
          <div className="sm:col-span-2">
            <label className={labelCls}>
              Item<RequiredMark />
            </label>
            <StockItemPicker
              items={options}
              value={item}
              onChange={(v) => {
                setItem(v);
                setErrors((p) => ({ ...p, name: undefined }));
              }}
              loading={loadingItems}
              invalid={Boolean(errors.name)}
              autoFocus
            />
            <FieldErr msg={errors.name} />
          </div>
          <div>
            <label className={labelCls}>
              Quantity<RequiredMark />
            </label>
            <NumberInput
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
            {/* Says what happens if it's left blank. The submission row only shows a "requested by"
                line when there's a name — it no longer guesses one. */}
            <p className={hintCls}>Who asked for this. Left blank, the submission shows no requester.</p>
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
