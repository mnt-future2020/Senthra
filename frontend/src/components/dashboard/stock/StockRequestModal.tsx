"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { NumberInput } from "@/components/ui/NumberInput";
import { Select } from "@/components/ui/Select";
import {
  autoSelectedWarehouseId,
  preferredWarehouseOptions,
  shouldShowPreferredWarehouse,
} from "@/lib/preferredWarehouse";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { ghostBtn, hintCls, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import {
  StockItemPicker,
  toStockItemOptions,
  type StockItemOption,
  type StockItemValue,
} from "@/components/dashboard/stock/StockItemPicker";
// Portal-only (mounted from the customer's Stock Requests view), so the submitted row comes back in
// the customer-facing shape — no staff emails, no internal warehouse notes.
import type { PortalStockRequest } from "@/types/customer";

// Portal: a customer user submits a stock REQUEST — an ask, not a catalogue write.
// Item name and quantity are mandatory; notes are optional. The request is queued for
// an internal reviewer to approve or reject. Approval never writes inventory directly.
export function StockRequestModal({
  onClose,
  onSubmitted,
}: {
  onClose: () => void;
  onSubmitted: (request: PortalStockRequest) => void;
}) {
  const [item, setItem] = React.useState<StockItemValue>({ entryId: null, name: "" });
  const [options, setOptions] = React.useState<StockItemOption[]>([]);
  const [loadingItems, setLoadingItems] = React.useState(true);
  const [itemQuery, setItemQuery] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [notes, setNotes] = React.useState("");
  // Preferred warehouse — its own state, so changing it never touches item / quantity / notes.
  const [warehouses, setWarehouses] = React.useState<{ id: string; name: string; code: string }[]>([]);
  const [warehousesLoaded, setWarehousesLoaded] = React.useState(false);
  const [preferredWarehouseId, setPreferredWarehouseId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<{ name?: string; quantity?: string }>({});
  const [error, setError] = React.useState<string | null>(null);

  // Existing stock the customer can top up (pick one instead of typing a duplicate name). Consignment
  // history grows past one page, so the picker searches SERVER-SIDE: its query drives this refetch
  // (the endpoint filters by item name/SKU/serial/barcode) rather than showing only the first page.
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) setLoadingItems(true);
      try {
        const r = await customerService.getOwnStockEntries({ q: itemQuery || undefined, pageSize: 100 });
        if (alive) setOptions(toStockItemOptions(r.entries));
      } catch {
        if (alive) setOptions([]);
      } finally {
        if (alive) setLoadingItems(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [itemQuery]);

  // The warehouses a customer may express a preference for: every active, non-deleted one.
  // Fetched ONCE (no query dependency) — the list is small and never filtered. An empty list makes
  // the field hide itself rather than block a submission, because the preference is optional.
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await customerService.getOwnSubmissionWarehouses();
        if (!alive) return;
        setWarehouses(list);
        // Auto-select the only option, matching how the app treats a single-choice reference list
        // elsewhere (firstActiveId). With two or more, the customer chooses — never guess.
        setPreferredWarehouseId(autoSelectedWarehouseId(list));
      } catch {
        // A failed lookup must not cost the customer their submission: an OPTIONAL preference
        // simply becomes unavailable, and the reviewer assigns the warehouse as they do today.
        if (alive) setWarehouses([]);
      } finally {
        if (alive) setWarehousesLoaded(true);
      }
    })();
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
      const request = await customerService.submitStockRequest({
        name: item.name.trim(),
        quantity: qty,
        notes: notes.trim() || undefined,
        linkedStockEntryId: item.entryId ?? undefined,
        preferredWarehouseId: preferredWarehouseId || undefined,
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
      title="Submit stock"
      subtitle="Sent to your account team to review. Approval doesn't ship stock on its own."
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" form="stock-request-form" disabled={busy} className={primaryBtn}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Submit stock
          </button>
        </>
      }
    >
      <form id="stock-request-form" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Hidden entirely when there is nothing to choose from — an empty dropdown reads as a
              broken field, and the preference is optional, so there is nothing to explain. */}
          {shouldShowPreferredWarehouse(warehousesLoaded, warehouses) && (
            <div className="sm:col-span-2">
              <label className={labelCls}>Preferred warehouse</label>
              <Select
                value={preferredWarehouseId}
                onChange={setPreferredWarehouseId}
                // Includes the app's standard clearable "" entry — without it a customer who
                // picks a warehouse has no way back to expressing no preference.
                options={preferredWarehouseOptions(warehouses)}
                placeholder="No preference"
              />
              <p className={hintCls}>Your preferred warehouse. Our team confirms the final destination.</p>
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
              onQueryChange={setItemQuery}
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
