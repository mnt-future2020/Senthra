"use client";

import * as React from "react";
import { AlertTriangle, Loader2, MinusCircle } from "lucide-react";

import * as inventoryService from "@/services/inventory.service";
import type { AdjustStockReason, StockAdjustment } from "@/services/inventory.service";
import { listIrmItems } from "@/services/irm.service";
import { listWarehouses } from "@/services/warehouse.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useAuth } from "@/hooks/useAuth";
import { inputCls, ghostBtn, labelCls, primaryBtn } from "@/components/ui/styles";
import { FormAsideCard, FormSection } from "@/components/ui/FormScaffold";
import { NumberInput } from "@/components/ui/NumberInput";
import { clampQuantityInput } from "@/lib/quantity";
import { Select } from "@/components/ui/Select";
import { Notice } from "@/components/ui/Notice";
import type { Availability } from "@/types/inventory";

const today = () => new Date().toISOString().slice(0, 10);

// "Damage correction" was REMOVED (and was the default, which made it the path of least resistance).
// It only removed the units from stock — no damaged-pool row, no photo, no reason text — so damage
// recorded this way never reached the Damaged tab and left no evidence for a claim or dispute.
// Damage now has its own action ("Report damage" on an inventory row → ReportDamageModal), which
// moves the units into the damaged pool with a mandatory reason and photo. Historical adjustments
// keep their stored reason; this list only governs new ones.
const REASONS: { value: AdjustStockReason; label: string }[] = [
  { value: "shrinkage", label: "Shrinkage" },
  { value: "miscount", label: "Miscount" },
  { value: "other", label: "Other" },
];

type ItemOption = { id: string; code: string; name: string; sku: string | null; baseUnit: string | null };
type WarehouseOption = { id: string; name: string; code: string };

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">{message}</p>;
}

interface AdjustStockFormProps {
  /** Called after a successful adjustment or when the user cancels */
  onDone: () => void;
}

export function AdjustStockForm({ onDone }: AdjustStockFormProps) {
  const { pushToast } = useDashboard();
  const { user, admin, principal } = useAuth();

  const currentUserName = user
    ? `${user.firstName} ${user.lastName}`.trim() || user.email
    : admin
      ? admin.name || admin.email
      : principal?.email ?? "—";

  const [items, setItems] = React.useState<ItemOption[]>([]);
  const [warehouses, setWarehouses] = React.useState<WarehouseOption[]>([]);

  const [irmItemId, setIrmItemId] = React.useState("");
  const [warehouseId, setWarehouseId] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [movementDate, setMovementDate] = React.useState(today());
  // Was "damage_correction" — retired above, so the select would have opened on a value with no
  // matching option and the backend would have rejected it on submit.
  const [reason, setReason] = React.useState<AdjustStockReason>("miscount");
  const [referenceNumber, setReferenceNumber] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const [availability, setAvailability] = React.useState<Availability | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [savedAdjustment, setSavedAdjustment] = React.useState<StockAdjustment | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const clearError = (f: string) =>
    setErrors((p) => {
      if (!p[f]) return p;
      const n = { ...p };
      delete n[f];
      return n;
    });

  // Load adjustable items (non-serial, non-batch, inventory-tracked) and active warehouses.
  React.useEffect(() => {
    let active = true;
    listIrmItems({ status: "active", pageSize: 200 }).then(
      (r) =>
        active &&
        setItems(
          r.items
            .filter((i) => i.trackInventory && !i.trackSerialNumbers && !i.trackBatchNumbers)
            .map((i) => ({ id: i.id, code: i.code, name: i.name, sku: i.sku, baseUnit: i.baseUnit })),
        ),
      () => {},
    );
    listWarehouses({ status: "active", pageSize: 100 }).then(
      (r) => active && setWarehouses(r.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))),
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);

  // WHERE THIS ITEM ACTUALLY IS. Loaded as soon as an item is picked, so the warehouse dropdown can
  // offer only the warehouses that hold it — with the quantity right in the label — instead of
  // listing all eight and making the user discover "0 available" one at a time. Mirrors the job kit
  // picker (JobKitRequestsReview), which already narrows its warehouse list this way.
  //
  // The result is STAMPED WITH THE ITEM IT BELONGS TO. That one field does three jobs: it tells us
  // whether the answer on hand is for the item currently selected, it makes "still loading" a derived
  // value (no extra state, so no synchronous setState in an effect body for the React-Compiler lint to
  // reject), and it stops a late response for a previous item being read as the current one.
  //
  // `options: null` = the lookup FAILED for that item (fall back to the full warehouse list rather
  // than block the form). `options: []` = loaded, and the item is held nowhere — a different state,
  // and the one that gets its own message below.
  const [loadedItemStock, setLoadedItemStock] = React.useState<
    { itemId: string; options: { value: string; label: string }[] | null } | null
  >(null);
  React.useEffect(() => {
    // No item picked → nothing to load. Nothing is cleared here either; the read-time guards below
    // key off the stamp instead, so a stale result simply stops matching.
    if (!irmItemId) return;
    let active = true;
    inventoryService.listItemWarehouseStock(irmItemId).then(
      (rows) => {
        if (!active) return;
        setLoadedItemStock({
          itemId: irmItemId,
          options: rows
            .filter((r) => r.available > 0)
            .sort((a, b) => b.available - a.available) // most stock first — the likeliest target
            .map((r) => ({
              value: r.warehouseId,
              label: `${r.warehouseName}${r.warehouseCode ? ` (${r.warehouseCode})` : ""} · ${r.available} available`,
            })),
        });
      },
      // Lookup failed (e.g. no inventory-read permission) — fall back to the unfiltered list rather
      // than blocking the form. Same fallback the kit picker uses.
      () => active && setLoadedItemStock({ itemId: irmItemId, options: null }),
    );
    return () => {
      active = false;
    };
  }, [irmItemId]);

  // Live on-hand at the chosen item × warehouse — used to show new balance and guard qty ≤ available.
  React.useEffect(() => {
    let active = true;
    (async () => {
      if (!irmItemId || !warehouseId) {
        setAvailability(null);
        return;
      }
      try {
        const a = await inventoryService.getAvailability(irmItemId, warehouseId);
        if (active) setAvailability(a);
      } catch {
        if (active) setAvailability(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [irmItemId, warehouseId]);

  // Changing the item invalidates the warehouse: the one already picked may not hold the new item,
  // and the dropdown is about to be re-filtered under it. Clear both so the user re-picks from the
  // narrowed list rather than sitting on a stale pair that reads "0 available".
  // Adjusted DURING RENDER — React's documented "reset state when a prop changes" pattern (the same
  // one InventoryView uses); an effect would fire a second commit and trip the React-Compiler lint.
  const [prevIrmItemId, setPrevIrmItemId] = React.useState(irmItemId);
  if (irmItemId !== prevIrmItemId) {
    setPrevIrmItemId(irmItemId);
    setWarehouseId("");
    setQuantity("");
  }

  const selectedItem = items.find((i) => i.id === irmItemId) ?? null;
  const targetWh = warehouses.find((w) => w.id === warehouseId) ?? null;
  // Read-time guards. `resolvedStock` is the loaded answer ONLY when its stamp matches the item on
  // screen — otherwise we are either between items or still waiting, and must not read it.
  const resolvedStock = loadedItemStock?.itemId === irmItemId ? loadedItemStock : null;
  // In flight: an item is selected but no answer for THAT item has arrived. The warehouse dropdown is
  // disabled for this window — while it was open, the list still showed all warehouses (the fallback),
  // so a fast click could land on one holding no stock, then have the list narrow out from under it,
  // leaving a selection the dropdown could no longer display (Select falls back to its placeholder)
  // while the summary panel still named that warehouse.
  const itemStockLoading = Boolean(irmItemId) && resolvedStock === null;
  const itemStock = resolvedStock?.options ?? null;
  // Only warehouses that actually hold this item, once we know. `itemStock === null` means we don't
  // have an answer (not loaded, or the lookup 403'd) → show everything rather than block the form.
  const warehouseOptions =
    itemStock && itemStock.length > 0
      ? itemStock
      : warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` }));
  // Loaded, and the item is in no warehouse at all — there is nothing to adjust anywhere.
  const itemHasNoStock = itemStock !== null && itemStock.length === 0;
  const qtyNum = Number(quantity);
  const available = availability?.available ?? null;
  const overAvailable =
    available !== null && Number.isInteger(qtyNum) && qtyNum > available;
  // Projected balance, FLOORED AT ZERO. It used to render the raw `available - qty`, so asking to
  // remove 4 from 0 showed "New balance −4" in red — a confident projection of a state the system
  // will never allow (the submit is blocked, and the backend floors at zero regardless). Showing an
  // impossible outcome as if it were about to happen is worse than showing nothing, so an
  // over-removal now yields null here and the panel says why instead.
  const newBalance =
    available !== null && Number.isInteger(qtyNum) && qtyNum > 0 && !overAvailable
      ? available - qtyNum
      : null;

  const locked = saving || Boolean(savedAdjustment);
  const quantityValid =
    quantity.trim() !== "" &&
    Number.isInteger(qtyNum) &&
    qtyNum >= 1 &&
    (available === null || qtyNum <= available);
  const dateValid = Boolean(movementDate) && movementDate <= today();
  const isFormValid =
    Boolean(irmItemId) && Boolean(warehouseId) && quantityValid && Boolean(reason) && dateValid;

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!irmItemId) errs.irmItemId = "Select an item.";
    if (!warehouseId) errs.warehouseId = "Select a warehouse.";
    if (!quantity.trim() || !Number.isInteger(qtyNum) || qtyNum < 1)
      errs.quantity = "Enter a whole quantity of at least 1.";
    else if (available !== null && qtyNum > available)
      errs.quantity = `Cannot remove more than the available quantity (${available}).`;
    if (!movementDate) errs.movementDate = "Movement date is required.";
    else if (movementDate > today()) errs.movementDate = "Movement date cannot be in the future.";
    return errs;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setError(null);
    const fieldErrors = validate();
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      pushToast("Please fix the highlighted fields.", "alert");
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const adjustment = await inventoryService.adjustStock({
        irmItemId,
        warehouseId,
        quantity: qtyNum,
        movementDate,
        reason,
        referenceNumber: referenceNumber.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      setSavedAdjustment(adjustment);
      setSaving(false);
      pushToast(
        `Adjusted — removed ${adjustment.quantity} from ${adjustment.warehouseName} (${adjustment.code}).`,
        "success",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not adjust the stock.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}
      {savedAdjustment && (
        <Notice
          msg={{
            type: "success",
            text: `Adjustment ${savedAdjustment.code} recorded. New on hand at ${savedAdjustment.warehouseName}: ${savedAdjustment.balanceAfter}.`,
          }}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <FormSection
            title="Adjustment details"
            description="Remove units from the warehouse balance. Serial- and batch-tracked items are not listed."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>Item</label>
                <Select
                  value={irmItemId}
                  onChange={(v) => {
                    setIrmItemId(v);
                    clearError("irmItemId");
                  }}
                  options={items.map((i) => ({
                    value: i.id,
                    label: `${i.code} — ${i.name}${i.sku ? ` (${i.sku})` : ""}`,
                  }))}
                  placeholder="— Select an item —"
                  ariaLabel="Item"
                  invalid={Boolean(errors.irmItemId)}
                  disabled={locked}
                />
                <FieldError message={errors.irmItemId} />
              </div>
              <div>
                <label className={labelCls}>Warehouse</label>
                <Select
                  value={warehouseId}
                  onChange={(v) => {
                    setWarehouseId(v);
                    clearError("warehouseId");
                  }}
                  options={warehouseOptions}
                  placeholder={
                    itemStockLoading
                      ? "— Checking stock… —"
                      : itemHasNoStock
                        ? "— No warehouse holds this item —"
                        : "— Select warehouse —"
                  }
                  ariaLabel="Warehouse"
                  invalid={Boolean(errors.warehouseId)}
                  // Held shut until we know where the item actually is, so a pick can't be made
                  // against the unfiltered fallback list and then narrowed away underneath it.
                  disabled={locked || itemHasNoStock || itemStockLoading}
                />
                <FieldError message={errors.warehouseId} />
                {/* An item with stock nowhere is a dead end, so say it once, plainly, instead of
                    leaving the user to try each warehouse and find 0 in every one. */}
                {itemHasNoStock ? (
                  <p className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">
                    {selectedItem?.name ?? "This item"} has no stock in any warehouse — there is
                    nothing to adjust.
                  </p>
                ) : (
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                  {!irmItemId
                    ? "Pick an item to see where it's held."
                    : itemStockLoading
                      ? "Checking where this item is held…"
                      : !warehouseId
                      ? "Only warehouses holding this item are listed."
                      : available !== null
                      ? `${available} available${selectedItem?.baseUnit ? ` ${selectedItem.baseUnit}` : ""}.`
                      : "No stock of this item here."}
                </p>
                )}
              </div>
              <div>
                <label className={labelCls}>Quantity to remove</label>
                <NumberInput
                  className={inputCls}
                  min={1}
                  max={available ?? undefined}
                  step={1}
                  value={quantity}
                  // Clamp to what's actually on the shelf as the user types — the same helper the
                  // damage modal uses. Before this, typing 4 against 0 available left "4" sitting in
                  // the box with the submit greyed out and no way to find out why (see below).
                  // `available` is null until both item and warehouse are picked; until then there is
                  // no ceiling to clamp to, so the raw value passes through.
                  onChange={(e) => {
                    const raw = e.target.value;
                    const next = available === null ? raw : clampQuantityInput(raw, available);
                    if (next === null) return; // junk keystroke — leave what's already typed alone
                    setQuantity(next);
                    clearError("quantity");
                  }}
                  aria-invalid={Boolean(errors.quantity) || overAvailable}
                  placeholder="e.g. 3"
                  disabled={locked}
                />
                <FieldError message={errors.quantity} />
                {/* LIVE explanation. The submit button is disabled whenever qty > available, which
                    means validate() — and therefore its "Cannot remove more than the available
                    quantity" message — could never run: the only thing that could show the error was
                    the very action the error prevented. This says it inline instead, the moment it
                    becomes true. Reachable at all only when available is 0 (nothing to clamp to). */}
                {overAvailable && !errors.quantity && (
                  <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">
                    Only {available} available{targetWh ? ` at ${targetWh.name}` : ""} — nothing to remove.
                  </p>
                )}
              </div>
              <div>
                <label className={labelCls}>Reason</label>
                <Select
                  value={reason}
                  onChange={(v) => setReason(v as AdjustStockReason)}
                  options={REASONS}
                  ariaLabel="Reason"
                  disabled={locked}
                />
              </div>
              <div>
                <label className={labelCls}>Movement date</label>
                <input
                  className={inputCls}
                  type="date"
                  max={today()}
                  value={movementDate}
                  onChange={(e) => {
                    setMovementDate(e.target.value);
                    clearError("movementDate");
                  }}
                  aria-invalid={Boolean(errors.movementDate)}
                  disabled={locked}
                />
                <FieldError message={errors.movementDate} />
              </div>
            </div>
          </FormSection>

          <FormSection title="References" description="Optional references recorded against this adjustment.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Reference number</label>
                <input
                  className={inputCls}
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  maxLength={60}
                  placeholder="e.g. STOCKTAKE-2026-01"
                  disabled={locked}
                />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Notes</label>
                <textarea
                  className={inputCls}
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={2000}
                  placeholder="Internal notes visible only to staff."
                  disabled={locked}
                />
              </div>
            </div>
          </FormSection>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Summary">
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Item</span>
                <span className="text-right font-semibold text-[var(--ink)]">
                  {selectedItem ? selectedItem.name : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Warehouse</span>
                <span className="text-right font-semibold text-[var(--ink)]">
                  {targetWh ? `${targetWh.name} (${targetWh.code})` : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Available now</span>
                <span className="font-semibold text-[var(--ink)]">{available ?? "—"}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Qty to remove</span>
                <span className="font-extrabold text-rose-600">
                  {Number.isInteger(qtyNum) && qtyNum > 0 ? `−${qtyNum}` : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">New balance</span>
                {/* Never renders a negative. An over-removal shows "Not possible" rather than the
                    arithmetic result — the adjustment is blocked here and floored by the backend, so
                    printing "−4" would be stating an outcome that cannot occur. */}
                <span className={`font-extrabold ${overAvailable ? "text-[var(--neg)]" : "text-[var(--ink)]"}`}>
                  {overAvailable ? "Not possible" : (newBalance ?? "—")}
                </span>
              </div>
              <div className="mt-1 space-y-2.5 border-t border-[var(--border)] pt-3">
                <div className="flex justify-between gap-3">
                  <span className="text-[var(--muted)]">Adjustment No</span>
                  <span
                    className={`text-right font-mono font-bold ${savedAdjustment ? "text-[var(--ink)]" : "text-[var(--faint)]"}`}
                  >
                    {savedAdjustment ? savedAdjustment.code : "Auto-generated after save"}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-[var(--muted)]">Created by</span>
                  <span className="text-right font-semibold text-[var(--ink)]">{currentUserName}</span>
                </div>
              </div>
            </div>
          </FormAsideCard>

          <div className="mt-4 flex gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3.5 py-3 text-[11px] leading-relaxed text-[var(--muted)]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--faint)]" />
            <div className="space-y-1.5">
              <p className="font-bold text-[var(--ink)]">This action cannot be edited later.</p>
              <p>
                Use <span className="font-semibold text-[var(--muted)]">Adjust</span> for shrinkage
                or miscount corrections only. It creates an immutable downward ledger entry.
              </p>
              {/* Damage was removed from this form's reasons — it left no damaged-pool row, no photo
                  and no evidence. Point people at the action that does, or they will reach for
                  "Other" here and recreate the exact bypass that change closed. */}
              <p>
                Damaged stock is <span className="font-semibold text-[var(--muted)]">not</span>{" "}
                adjusted here — use <span className="font-semibold text-[var(--muted)]">Report damage</span>{" "}
                on the item&apos;s row, which records the reason and a photo and moves the units into
                the damaged pool.
              </p>
            </div>
          </div>
        </aside>
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] pt-4">
        {savedAdjustment ? (
          <button type="button" onClick={onDone} className={primaryBtn}>
            Done
          </button>
        ) : (
          <>
            <button type="button" onClick={onDone} disabled={saving} className={ghostBtn}>
              Cancel
            </button>
            <button type="submit" disabled={!isFormValid || saving} className={primaryBtn}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MinusCircle className="h-3.5 w-3.5" />
              )}
              {saving ? "Adjusting…" : "Adjust Stock"}
            </button>
          </>
        )}
      </div>
    </form>
  );
}
