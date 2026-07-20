"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";

import * as grnService from "@/services/goods-in.service";
import { listPurchaseOrders } from "@/services/purchase-order.service";
import { listIrmItems, generateBarcode, getIrmItem } from "@/services/irm.service";
import { printLabels, MAX_LABEL_COPIES } from "@/lib/printBarcode";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { inputCls, ghostBtn, labelCls, primaryBtn } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";
import { Select } from "@/components/ui/Select";
import { FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { BarcodePanel } from "@/components/dashboard/irm/BarcodePanel";
import { PO_STATUS_LABELS } from "@/components/dashboard/purchase-orders/poStatus";
import { AttachmentGrid, DocPicker, attachmentToDoc, type DocItem, type PickedDoc } from "./DeliveryDocuments";
import type { GoodsReceipt, GrnAttachment } from "@/types/goods-in";
import type { PurchaseOrder } from "@/types/purchase-order";

const GRN_LIST = "/dashboard/goods-in";
const QUALITY = ["passed", "partial", "failed"] as const;
const QUALITY_LABELS: Record<string, string> = { passed: "Passed", partial: "Partial", failed: "Failed" };

// `_key` is a stable, frontend-only React key (never sent to the backend) so batch rows keep their
// identity across add/remove and controlled inputs don't desync when a middle row is deleted.
type BatchRow = { _key: string; batchNumber: string; expiryDate: string; quantity: string };
type LineState = {
  purchaseOrderItemId: string;
  irmItemId: string;
  itemCode: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  ordered: number;
  previouslyReceived: number;
  trackSerials: boolean;
  trackBatches: boolean;
  receive: string;
  accepted: string;
  notes: string;
  serialsText: string;
  batches: BatchRow[];
  // Label printing — never sent to the backend. `barcodeDataUri` is lazy-loaded per item (the IRM
  // list endpoint omits the image to stay light); `copies` blank means "use the accepted qty".
  barcodeDataUri: string | null;
  copies: string;
};

const today = () => new Date().toISOString().slice(0, 10);
const dateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
const num = (s: string) => Number(s) || 0;
const blank = (s: string) => s.trim() === "";
// Staff type Received + Accepted (what passed QC); damaged/rejected is DERIVED. Accepted is
// deliberately left blank on a new line and is required to submit — defaulting it to 0 would
// read as "all damaged", and defaulting it to the received qty would rubber-stamp a QC decision
// nobody made. Until it's filled, the Damaged cell shows "—" rather than a misleading number.
const acceptedOf = (l: LineState) => Math.max(0, num(l.accepted));
const damagedOf = (l: LineState) => Math.max(0, num(l.receive) - num(l.accepted));
const parseSerials = (text: string) => text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

// One sticker per accepted unit by default — staff put away N boxes and label each one. A blank
// box tracks the accepted qty live; typing a number pins it (e.g. reprinting 3 that smudged).
const defaultCopies = (accepted: number) => Math.max(1, accepted);
const effectiveCopies = (l: LineState, accepted: number) =>
  l.copies.trim() === "" ? defaultCopies(accepted) : num(l.copies);
// Only barcode-able lines get a label panel: serial/batch-tracked items would print an identical
// sticker on every unit AND are rejected by scan lookup, so a label there is a dead sticker.
const canLabel = (l: LineState) => !l.trackSerials && !l.trackBatches && Boolean(l.itemCode);

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">{message}</p>;
}

type ItemFlags = { serials: boolean; batches: boolean; code: string };

// Build the received-item lines for a picked PO (only lines with remaining > 0). Pure —
// shared by the user's manual pick and the ?po= deep-link preselect, so both paths
// produce identical rows (incl. serial/batch tracking flags).
function buildLines(po: PurchaseOrder, flags: Map<string, ItemFlags>): LineState[] {
  return po.items
    .filter((i) => i.quantity - i.receivedQuantity > 0)
    .map((i) => {
      const f = flags.get(i.irmItemId);
      return {
        purchaseOrderItemId: i.id,
        irmItemId: i.irmItemId,
        itemCode: f?.code ?? "",
        itemName: i.itemName,
        sku: i.sku,
        baseUnit: i.baseUnit,
        ordered: i.quantity,
        previouslyReceived: i.receivedQuantity,
        trackSerials: f?.serials ?? false,
        trackBatches: f?.batches ?? false,
        receive: "",
        accepted: "",
        notes: "",
        serialsText: "",
        batches: [],
        barcodeDataUri: null,
        copies: "",
      };
    });
}

export function GoodsReceiptForm({ mode, order }: { mode: "create" | "edit"; order?: GoodsReceipt | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();
  const { can } = useAuth();
  const canManageBarcode = can("irm.barcode.manage");

  // Deep-link from the PO detail "Receive" action: ?po=<id> preselects that PO on create.
  const presetPoId = mode === "create" ? searchParams.get("po") : null;
  // Deep-link from a warehouse's Incoming-stock tab: ?warehouse=<id> scopes the PO list to it.
  const presetWarehouseId = mode === "create" ? searchParams.get("warehouse") : null;
  // ?returnTo=<path> — where Back/Cancel goes when opened from a warehouse's Incoming-stock tab, so a
  // warehouse user returns to their warehouse instead of the global GRN list. Only accept a safe
  // SAME-ORIGIN relative path ("/x", not "//host" or "https://…") to prevent an open-redirect.
  const rawReturnTo = mode === "create" ? searchParams.get("returnTo") : null;
  // Accept ONLY a same-origin relative path. Reject protocol-relative ("//host") AND the backslash
  // variant ("/\\host" / "\\") that browsers normalise to "//" — both are open-redirect vectors.
  const returnTo =
    rawReturnTo && rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//") && !rawReturnTo.includes("\\")
      ? rawReturnTo
      : null;
  const preselectDone = React.useRef(false);

  const o = order;
  const [poId, setPoId] = React.useState(o?.purchaseOrderId ?? "");
  const [receivedDate, setReceivedDate] = React.useState(o ? dateInput(o.receivedDate) : today());
  const [referenceNumber, setReferenceNumber] = React.useState(o?.referenceNumber ?? "");
  const [carrier, setCarrier] = React.useState(o?.carrier ?? "");
  const [deliveryNoteNumber, setDeliveryNoteNumber] = React.useState(o?.deliveryNoteNumber ?? "");
  const [vehicleRegistration, setVehicleRegistration] = React.useState(o?.vehicleRegistration ?? "");
  const [description, setDescription] = React.useState(o?.description ?? "");
  const [qualityStatus, setQualityStatus] = React.useState(o?.qualityStatus ?? "passed");
  const [qualityNotes, setQualityNotes] = React.useState(o?.qualityNotes ?? "");
  const [internalNotes, setInternalNotes] = React.useState(o?.internalNotes ?? "");
  // Delivery documents — edit: live (uploaded immediately to the existing draft); create: staged
  // in memory and uploaded right after the draft is created. Limits/validation live in DocPicker.
  const [attachments, setAttachments] = React.useState<GrnAttachment[]>(o?.attachments ?? []);
  const [staged, setStaged] = React.useState<{ key: string; fileName: string; fileType: string; fileSizeBytes: number; dataUrl: string }[]>([]);

  const [lines, setLines] = React.useState<LineState[]>(() =>
    o
      ? o.items.map((i) => ({
          purchaseOrderItemId: i.purchaseOrderItemId,
          irmItemId: i.irmItemId,
          itemCode: i.irmItem?.code ?? "",
          itemName: i.itemName,
          sku: i.sku,
          baseUnit: i.baseUnit,
          ordered: i.orderedQuantity,
          previouslyReceived: i.previouslyReceived,
          trackSerials: i.irmItem?.trackSerialNumbers ?? false,
          trackBatches: i.irmItem?.trackBatchNumbers ?? false,
          receive: String(i.receivedQuantity),
          accepted: String(i.acceptedQuantity),
          notes: i.notes ?? "",
          serialsText: i.serials.map((s) => s.serialNumber).join("\n"),
          batches: i.batches.map((b) => ({ _key: crypto.randomUUID(), batchNumber: b.batchNumber, expiryDate: dateInput(b.expiryDate), quantity: String(b.quantity) })),
          barcodeDataUri: null,
          copies: "",
        }))
      : [],
  );

  const [receivablePos, setReceivablePos] = React.useState<PurchaseOrder[]>([]);
  // True once the receivable-PO fetch settles — lets us tell "still loading" (don't nag) from
  // "genuinely none" (show a clear empty-state instead of a bare placeholder).
  const [posLoaded, setPosLoaded] = React.useState(false);
  const [flags, setFlags] = React.useState<Map<string, ItemFlags>>(new Map());
  // Barcode label state. `barcodeBusyId` is the IRM item currently generating (one at a time);
  // `loadedBarcodeIds` remembers which items' images we've already fetched so a re-render or a
  // PO reselect never refetches. Failures aren't cached, so they retry.
  const [barcodeBusyId, setBarcodeBusyId] = React.useState<string | null>(null);
  const loadedBarcodeIds = React.useRef<Set<string>>(new Set());
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  // Remember the draft created on the first submit so a retry (after a document upload failed) reuses
  // it instead of creating a duplicate GRN.
  const [createdRef, setCreatedRef] = React.useState<{ id: string; code: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const touch = () => setDirty(true);

  // Read-only supplier/warehouse panels — from the selected PO (create) or the order (edit).
  const selectedPo = receivablePos.find((p) => p.id === poId) ?? null;
  const supplierPanel = o?.supplier ?? selectedPo?.supplier ?? null;
  const warehousePanel = o?.warehouse ?? selectedPo?.warehouse ?? null;
  const supplierName = o?.supplierName ?? selectedPo?.supplierName ?? null;
  // When the list is scoped to a warehouse, name it (all loaded POs share that warehouse).
  const scopedWarehouseName = presetWarehouseId ? receivablePos[0]?.warehouse?.name ?? null : null;

  React.useEffect(() => {
    if (mode !== "create") return;
    let active = true;
    // Load in one pass so the ?po= preselect can run with BOTH the receivable POs and the
    // IRM tracking flags resolved (otherwise a preselected line could miss serial/batch
    // capture). allSettled keeps the two independent — one failing never blocks the other.
    Promise.allSettled([
      // receivable = sent + supplier_accepted + partially_received. `warehouse` scopes the list
      // when opened from a warehouse's Incoming-stock tab (undefined on the global GRN page →
      // all warehouses).
      listPurchaseOrders({ statuses: ["sent", "supplier_accepted", "partially_received"], warehouse: presetWarehouseId ?? undefined, pageSize: 100 }),
      listIrmItems({ status: "active", pageSize: 200 }), // which lines capture serials / batches
    ]).then(([receivable, irm]) => {
      if (!active) return;
      const pos = receivable.status === "fulfilled" ? receivable.value.purchaseOrders : [];
      const flagMap = new Map(
        (irm.status === "fulfilled" ? irm.value.items : []).map(
          (i) => [i.id, { serials: i.trackSerialNumbers, batches: i.trackBatchNumbers, code: i.code }] as const,
        ),
      );
      setReceivablePos(pos);
      setFlags(flagMap);
      setPosLoaded(true);

      // Preselect a deep-linked PO once. This is NOT a user edit, so it must not set the
      // dirty flag (a freshly opened form shouldn't trip the unsaved-changes guard).
      if (!preselectDone.current && presetPoId) {
        preselectDone.current = true;
        const po = pos.find((p) => p.id === presetPoId);
        if (po) {
          setPoId(po.id);
          setLines(buildLines(po, flagMap));
        } else {
          pushToast("That purchase order isn't available to receive.", "info");
        }
      }
    });
    return () => { active = false; };
  }, [mode, presetPoId, presetWarehouseId, pushToast]);

  useReportDirty("grn-form", dirty && !saved);

  // Lazy-load the barcode image for each labelable line (the IRM list endpoint omits barcodeDataUri
  // to stay light even with 100+ barcoded items). A GRN has a handful of lines, so they're fetched
  // in parallel; allSettled keeps one failure from blanking the rest. Also backfills itemCode when
  // the flags fetch failed. This is NOT a user edit — it must never set the dirty flag.
  const labelableIds = lines.filter((l) => !l.trackSerials && !l.trackBatches).map((l) => l.irmItemId).join(",");
  React.useEffect(() => {
    const ids = labelableIds.split(",").filter((id) => id && !loadedBarcodeIds.current.has(id));
    if (ids.length === 0) return;
    let active = true;
    Promise.allSettled(ids.map((id) => getIrmItem(id))).then((results) => {
      if (!active) return;
      const loaded = new Map<string, { barcodeDataUri: string | null; code: string }>();
      results.forEach((r, i) => {
        if (r.status !== "fulfilled") return;
        loadedBarcodeIds.current.add(ids[i]);
        loaded.set(ids[i], { barcodeDataUri: r.value.barcodeDataUri, code: r.value.code });
      });
      if (loaded.size === 0) return;
      setLines((rows) =>
        rows.map((r) => {
          const hit = loaded.get(r.irmItemId);
          return hit ? { ...r, barcodeDataUri: hit.barcodeDataUri, itemCode: r.itemCode || hit.code } : r;
        }),
      );
    });
    return () => { active = false; };
  }, [labelableIds]);

  // Generate the line item's Code128 barcode (one-time — it encodes the item's permanent code, so
  // this can never mint a new value). Syncs every line sharing that item so the panel flips to
  // "Reprint Label" without a reload. Independent of the GRN save.
  const generateLineBarcode = async (irmItemId: string) => {
    if (barcodeBusyId) return;
    setBarcodeBusyId(irmItemId);
    try {
      const updated = await generateBarcode(irmItemId);
      loadedBarcodeIds.current.add(updated.id); // generate returns the image — no need to lazy-fetch
      setLines((rows) => rows.map((r) => (r.irmItemId === updated.id ? { ...r, barcodeDataUri: updated.barcodeDataUri, itemCode: r.itemCode || updated.code } : r)));
      pushToast("Barcode generated.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not generate the barcode.", "alert");
    } finally {
      setBarcodeBusyId(null);
    }
  };

  // Copies is a print-only control (never part of the payload), so unlike updateLine it must NOT
  // mark the form dirty — picking a label count shouldn't trip the unsaved-changes guard.
  const setLineCopies = (idx: number, value: string) =>
    setLines((rows) => rows.map((r, i) => (i === idx ? { ...r, copies: value } : r)));

  const printLineLabels = (l: LineState, accepted: number) => {
    if (!l.barcodeDataUri) return;
    printLabels({ dataUri: l.barcodeDataUri, code: l.itemCode, copies: effectiveCopies(l, accepted) });
  };

  // Copies is print-only — it never blocks the GRN save, so it's validated here rather than in
  // validate(). Blank is valid (falls back to the accepted qty).
  const copiesError = (l: LineState): string | undefined => {
    if (l.copies.trim() === "") return undefined;
    const n = Number(l.copies);
    if (!Number.isInteger(n) || n < 1) return "Enter a whole number of at least 1.";
    if (n > MAX_LABEL_COPIES) return `Up to ${MAX_LABEL_COPIES} labels per print run.`;
    return undefined;
  };

  // On create: when the user picks a PO, build the received-item lines (only lines with
  // remaining > 0). This IS a user edit, so it marks the form dirty.
  const onPickPo = (id: string) => {
    setPoId(id);
    touch();
    clearError("purchaseOrderId");
    clearError("items");
    const po = receivablePos.find((p) => p.id === id);
    setLines(po ? buildLines(po, flags) : []);
  };

  const clearError = (f: string) => setErrors((p) => { if (!p[f]) return p; const n = { ...p }; delete n[f]; return n; });
  const goBack = () =>
    guard.attemptLeave(() => {
      if (returnTo) { router.push(returnTo); return; }
      if (window.history.length > 1) router.back();
      else router.push(GRN_LIST);
    });
  const updateLine = (idx: number, patch: Partial<LineState>) => {
    setLines((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    touch();
    clearError("items");
  };
  const addBatch = (idx: number) => updateLine(idx, { batches: [...lines[idx].batches, { _key: crypto.randomUUID(), batchNumber: "", expiryDate: "", quantity: "" }] });
  const updateBatch = (idx: number, bi: number, patch: Partial<BatchRow>) =>
    updateLine(idx, { batches: lines[idx].batches.map((b, i) => (i === bi ? { ...b, ...patch } : b)) });
  const removeBatch = (idx: number, bi: number) => updateLine(idx, { batches: lines[idx].batches.filter((_, i) => i !== bi) });

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (mode === "create" && !poId) errs.purchaseOrderId = "Select a purchase order.";
    if (!receivedDate) errs.receivedDate = "Received date is required.";

    const active = lines.filter((l) => num(l.receive) > 0);
    if (active.length === 0) {
      errs.items = "Receive a quantity for at least one item.";
      return errs;
    }
    for (const l of active) {
      const remaining = l.ordered - l.previouslyReceived;
      const receive = num(l.receive);
      const accepted = num(l.accepted);
      // Quantities are whole units. NumberInput blocks "e"/"+"/"-" but NOT ".", so a decimal is
      // typeable — catch it here rather than letting the server reject it as a generic 400.
      if (!Number.isInteger(receive)) { errs.items = `${l.itemName}: received quantity must be a whole number.`; break; }
      if (receive > remaining) { errs.items = `${l.itemName}: can't receive more than the ${remaining} remaining.`; break; }
      // Blank is NOT zero — every receiving line needs an explicit QC call before it can be saved.
      if (blank(l.accepted)) { errs.items = `${l.itemName}: enter the accepted quantity (0 if the whole line was rejected).`; break; }
      if (!Number.isInteger(accepted)) { errs.items = `${l.itemName}: accepted quantity must be a whole number.`; break; }
      if (accepted > receive) { errs.items = `${l.itemName}: accepted can't exceed received.`; break; }
      if (l.trackSerials && parseSerials(l.serialsText).length !== accepted) { errs.items = `${l.itemName}: enter exactly ${accepted} serial number(s).`; break; }
      if (l.trackBatches) {
        const sum = l.batches.reduce((a, b) => a + num(b.quantity), 0);
        if (sum !== accepted) { errs.items = `${l.itemName}: batch quantities must total ${accepted}.`; break; }
      }
    }
    return errs;
  };

  const buildPayload = (): grnService.GoodsReceiptPayload => ({
    ...(mode === "create" ? { purchaseOrderId: poId } : {}),
    receivedDate,
    referenceNumber: referenceNumber.trim(),
    carrier: carrier.trim(),
    deliveryNoteNumber: deliveryNoteNumber.trim(),
    vehicleRegistration: vehicleRegistration.trim(),
    description: description.trim(),
    qualityStatus,
    qualityNotes: qualityNotes.trim(),
    internalNotes: internalNotes.trim(),
    items: lines
      .filter((l) => num(l.receive) > 0)
      .map((l) => ({
        purchaseOrderItemId: l.purchaseOrderItemId,
        receivedQuantity: num(l.receive),
        acceptedQuantity: num(l.accepted),
        notes: l.notes.trim() || undefined,
        serials: l.trackSerials ? parseSerials(l.serialsText) : undefined,
        batches: l.trackBatches
          ? l.batches.map((b) => ({ batchNumber: b.batchNumber.trim(), expiryDate: b.expiryDate || undefined, quantity: num(b.quantity) }))
          : undefined,
      })),
  });

  // Unify saved (edit) + staged (create) docs for the grid; counts feed the picker's caps.
  const docItems: DocItem[] = mode === "edit"
    ? attachments.map(attachmentToDoc)
    : staged.map((s) => ({ id: s.key, fileName: s.fileName, fileType: s.fileType, fileSizeBytes: s.fileSizeBytes, src: s.dataUrl }));
  const docTotalBytes = (mode === "edit" ? attachments : staged).reduce((sum, a) => sum + a.fileSizeBytes, 0);
  const canEditDocs = mode === "create" || o?.status === "draft";

  const onPickDoc = async (doc: PickedDoc) => {
    if (mode === "edit" && o) {
      try {
        const updated = await grnService.addAttachment(o.id, { fileName: doc.fileName, fileType: doc.fileType, fileSizeBytes: doc.fileSizeBytes, data: doc.dataUrl });
        setAttachments(updated.attachments);
        pushToast("Document added.", "success");
      } catch (e) {
        pushToast(e instanceof Error ? e.message : "Upload failed.", "alert");
      }
      return;
    }
    setStaged((prev) => [...prev, { key: crypto.randomUUID(), ...doc }]);
    touch();
  };

  const onRemoveDoc = async (id: string) => {
    if (mode === "edit" && o) {
      try {
        setAttachments((await grnService.removeAttachment(o.id, id)).attachments);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
      }
      return;
    }
    setStaged((prev) => prev.filter((s) => s.key !== id));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
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
      if (mode === "create") {
        // Create the draft once; on a retry (a previous document upload failed) reuse it so we never
        // spawn a duplicate GRN.
        const created = createdRef ?? (await grnService.createGoodsReceipt(buildPayload()));
        if (!createdRef) setCreatedRef({ id: created.id, code: created.code });
        // Upload staged delivery documents against the draft. Any that fail STAY staged and the user
        // stays on the form so they can retry or remove them — the files are never silently dropped by
        // navigating away.
        const failed: typeof staged = [];
        for (const doc of staged) {
          try {
            await grnService.addAttachment(created.id, { fileName: doc.fileName, fileType: doc.fileType, fileSizeBytes: doc.fileSizeBytes, data: doc.dataUrl });
          } catch {
            failed.push(doc);
          }
        }
        setStaged(failed);
        if (failed.length > 0) {
          const msg = `Goods receipt ${created.code} created, but ${failed.length} document${failed.length > 1 ? "s" : ""} didn't upload. Press the button again to retry, or remove ${failed.length > 1 ? "them" : "it"}.`;
          setError(msg);
          pushToast(msg, "alert");
          setSaving(false);
          return;
        }
        setSaved(true);
        pushToast(`Goods receipt ${created.code} created.`, "success");
        router.replace(`/dashboard/goods-in/${created.code}`);
      } else if (o) {
        await grnService.updateGoodsReceipt(o.id, buildPayload());
        setSaved(true);
        pushToast("Goods receipt updated.", "success");
        router.replace(`/dashboard/goods-in/${o.code}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save the goods receipt.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title={mode === "create" ? "New GRN" : `Edit ${o?.code ?? "GRN"}`}
        subtitle={mode === "edit" && o ? o.code : "Receive a delivery against a purchase order"}
        onBack={goBack}
        actions={
          <>
            <button type="button" onClick={goBack} disabled={saving} className={ghostBtn}>Cancel</button>
            <button type="submit" disabled={saving} className={primaryBtn}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {mode === "create" ? "Create draft" : "Save changes"}
            </button>
          </>
        }
      />

      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="GRN Information" description="Which delivery this is and against which order.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>Purchase order<RequiredMark /></label>
                {mode === "create" ? (
                  <>
                    <Select value={poId} onChange={(v) => onPickPo(v)} options={receivablePos.map((p) => ({ value: p.id, label: `${p.code} — ${p.supplierName ?? p.supplier?.name ?? ""} (${PO_STATUS_LABELS[p.status] ?? p.status})` }))} placeholder="— Select a purchase order —" ariaLabel="Purchase order" invalid={Boolean(errors.purchaseOrderId)} />
                    <FieldError message={errors.purchaseOrderId} />
                    {posLoaded && receivablePos.length === 0 ? (
                      <p className="mt-1.5 text-[11px] font-semibold text-[var(--muted)]">
                        {presetWarehouseId
                          ? "No open purchase orders for this warehouse yet — a purchase order must be Sent (delivering here) before you can receive against it."
                          : "No open purchase orders to receive against — a purchase order must be Sent before goods can be received."}
                      </p>
                    ) : (
                      <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                        {presetWarehouseId
                          ? scopedWarehouseName
                            ? `Showing open purchase orders for ${scopedWarehouseName}.`
                            : "Showing this warehouse's open purchase orders only."
                          : "Choose a Sent or Partially Received purchase order to receive this delivery."}
                      </p>
                    )}
                  </>
                ) : (
                  <input className={inputCls} value={`${o?.poCode ?? ""}`} disabled />
                )}
              </div>
              <div>
                <label className={labelCls}>Received date<RequiredMark /></label>
                <input type="date" className={inputCls} value={receivedDate} onChange={(e) => { setReceivedDate(e.target.value); touch(); clearError("receivedDate"); }} aria-invalid={Boolean(errors.receivedDate)} placeholder="dd-mm-yyyy" />
                <FieldError message={errors.receivedDate} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">The date this delivery physically arrived at the warehouse.</p>
              </div>
              <div>
                <label className={labelCls}>Delivery warehouse</label>
                <input className={inputCls} value={warehousePanel ? `${warehousePanel.name} (${warehousePanel.code})` : "—"} disabled />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Inherited from the purchase order and locked for this receipt.</p>
              </div>
              <div>
                <label className={labelCls}>Delivery note number</label>
                <input className={inputCls} value={deliveryNoteNumber} onChange={(e) => { setDeliveryNoteNumber(e.target.value); touch(); }} maxLength={80} placeholder="e.g. DN-2026-001" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">The supplier&apos;s delivery / dispatch note number — <span className="font-semibold text-[var(--muted)]">required before you can complete this receipt</span>.</p>
              </div>
              <div>
                <label className={labelCls}>Carrier</label>
                <input className={inputCls} value={carrier} onChange={(e) => { setCarrier(e.target.value); touch(); }} maxLength={120} placeholder="e.g. DPD, DHL, FedEx or Own Transport" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Who delivered the goods to the warehouse.</p>
              </div>
              <div>
                <label className={labelCls}>Vehicle registration</label>
                <input className={inputCls} value={vehicleRegistration} onChange={(e) => { setVehicleRegistration(e.target.value); touch(); }} maxLength={20} placeholder="e.g. AB12 CDE" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Optional. Enter the delivery vehicle registration if recorded.</p>
              </div>
              <div>
                <label className={labelCls}>Reference number</label>
                <input className={inputCls} value={referenceNumber} onChange={(e) => { setReferenceNumber(e.target.value); touch(); }} maxLength={60} placeholder="e.g. REF-2026-01" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Optional internal reference for this receipt.</p>
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Description</label>
                <textarea className={inputCls} rows={2} value={description} onChange={(e) => { setDescription(e.target.value); touch(); }} maxLength={2000} placeholder="e.g. Pallets arrived in two separate deliveries." />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Optional operational notes about this delivery.</p>
              </div>
            </div>
          </FormSection>

          {supplierPanel && (
            <FormSection title="Supplier information" description="Read-only — from the purchase order.">
              <div className="grid gap-3 sm:grid-cols-2 text-sm">
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Supplier</p><p className="text-[var(--ink)]">{supplierName ?? supplierPanel.name}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Contact</p><p className="text-[var(--ink)]">{supplierPanel.contactPerson || "—"}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Email</p><p className="text-[var(--ink)]">{supplierPanel.contactEmail || "—"}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Phone</p><p className="text-[var(--ink)]">{supplierPanel.contactPhone || "—"}</p></div>
              </div>
            </FormSection>
          )}

          <FormSection title="Received items" description="Enter the quantity physically received and how much passed inspection. Damaged / rejected (Received − Accepted) is calculated for you; only the accepted quantity is added to inventory when the receipt is completed.">
            {lines.length === 0 ? (
              <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--muted)]">
                {mode === "create" ? "Select a purchase order to load its outstanding items." : "This receipt has no lines."}
              </p>
            ) : (
              <div className="space-y-3">
                {lines.map((l, idx) => {
                  const remaining = l.ordered - l.previouslyReceived;
                  const accepted = acceptedOf(l);
                  const batchSum = l.batches.reduce((a, b) => a + num(b.quantity), 0);
                  const serialCount = parseSerials(l.serialsText).length;
                  // Live, per-field validation (mirrors the submit-time checks) so an
                  // over-receive / over-damage is flagged the moment it's typed.
                  const receiveNum = num(l.receive);
                  const over = receiveNum > remaining;
                  const acceptedOver = accepted > receiveNum;
                  // A line being received needs an explicit accepted qty; until then the derived
                  // damaged cell shows "—" instead of claiming the whole delivery was rejected.
                  const acceptedMissing = receiveNum > 0 && blank(l.accepted);
                  return (
                    <div key={l.purchaseOrderItemId} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
                      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-bold text-[var(--ink)]">{l.itemName}{l.sku ? <span className="ml-1.5 text-[11px] font-normal text-[var(--faint)]">{l.sku}</span> : null}</span>
                        <span className="text-[11px] text-[var(--muted)]">Ordered {l.ordered} · Already received {l.previouslyReceived} · <strong className={over ? "text-[var(--neg)]" : "text-[var(--ink)]"}>Remaining {remaining}</strong></span>
                      </div>
                      <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
                        <div>
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <label className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">Receive qty</label>
                            {remaining > 0 && receiveNum !== remaining && (
                              <button type="button" onClick={() => updateLine(idx, { receive: String(remaining) })} className="text-[11px] font-bold text-[var(--accent)] hover:underline">
                                Receive all ({remaining})
                              </button>
                            )}
                          </div>
                          <NumberInput className={inputCls} min={0} max={remaining} value={l.receive} onChange={(e) => updateLine(idx, { receive: e.target.value })} placeholder="e.g. 100" aria-invalid={over} />
                          {over && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">Only {remaining} left to receive on this line.</p>}
                        </div>
                        <div>
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <label className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">Accepted</label>
                            {receiveNum > 0 && num(l.accepted) !== receiveNum && (
                              <button type="button" onClick={() => updateLine(idx, { accepted: String(receiveNum) })} className="text-[11px] font-bold text-[var(--accent)] hover:underline">
                                All good ({receiveNum})
                              </button>
                            )}
                          </div>
                          <NumberInput className={inputCls} min={0} max={receiveNum || undefined} value={l.accepted} onChange={(e) => updateLine(idx, { accepted: e.target.value })} placeholder="e.g. 100" aria-invalid={acceptedOver || acceptedMissing} />
                          {acceptedOver && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">Accepted can&apos;t exceed received ({receiveNum}).</p>}
                          {acceptedMissing && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">Enter how many passed inspection (0 if all rejected).</p>}
                        </div>
                        <div>
                          <label className={labelCls}>Damaged</label>
                          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm font-semibold text-[var(--ink)]">
                            {acceptedMissing || acceptedOver ? "—" : `${damagedOf(l)}${l.baseUnit ? ` ${l.baseUnit}` : ""}`}
                          </div>
                        </div>
                        <div>
                          <label className={labelCls}>Line notes</label>
                          <input className={inputCls} value={l.notes} onChange={(e) => updateLine(idx, { notes: e.target.value })} maxLength={2000} placeholder="e.g. Outer box damaged" />
                        </div>
                      </div>

                      {/* Item barcode — staff generate (one-time) and print one label per accepted
                          unit to stick on the stock as it's put away. Same shared BarcodePanel as the
                          IRM Catalogue and Add Stock. Independent of the save: printable on a draft,
                          and the label stays valid forever (it encodes the item's permanent code). */}
                      {canLabel(l) && (
                        <div className="mt-3 border-t border-[var(--border)] pt-3">
                          <label className={labelCls}>Item barcode</label>
                          <BarcodePanel
                            code={l.itemCode}
                            barcodeDataUri={l.barcodeDataUri}
                            canManage={canManageBarcode}
                            busy={barcodeBusyId === l.irmItemId}
                            onGenerate={() => generateLineBarcode(l.irmItemId)}
                            onPrint={() => printLineLabels(l, accepted)}
                            copies={l.copies}
                            onCopiesChange={(v) => setLineCopies(idx, v)}
                            copiesPlaceholder={String(defaultCopies(accepted))}
                            copiesError={copiesError(l)}
                          />
                          {l.barcodeDataUri && !copiesError(l) && (
                            <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                              Prints {effectiveCopies(l, accepted)} label{effectiveCopies(l, accepted) === 1 ? "" : "s"}
                              {l.copies.trim() === "" ? " — one per accepted unit." : "."}
                            </p>
                          )}
                        </div>
                      )}

                      {l.trackSerials && (
                        <div className="mt-3">
                          <label className={labelCls}>Serial numbers (one per line)</label>
                          <textarea className={inputCls} rows={Math.min(6, Math.max(2, accepted))} value={l.serialsText} onChange={(e) => updateLine(idx, { serialsText: e.target.value })} placeholder="One serial per accepted unit" />
                          <p className={`mt-1 text-[11px] ${serialCount === accepted ? "text-[var(--faint)]" : "text-[var(--neg)]"}`}>{serialCount} of {accepted} serial number(s) entered.</p>
                        </div>
                      )}

                      {l.trackBatches && (
                        <div className="mt-3">
                          <label className={labelCls}>Batches</label>
                          <div className="space-y-2">
                            {l.batches.map((b, bi) => (
                              <div key={b._key} className="grid grid-cols-2 gap-2 lg:grid-cols-12">
                                <input className={`${inputCls} col-span-2 lg:col-span-5`} value={b.batchNumber} onChange={(e) => updateBatch(idx, bi, { batchNumber: e.target.value })} maxLength={120} placeholder="Batch / lot number" />
                                <input className={`${inputCls} lg:col-span-4`} type="date" value={b.expiryDate} onChange={(e) => updateBatch(idx, bi, { expiryDate: e.target.value })} />
                                <NumberInput className={`${inputCls} lg:col-span-2`} min={1} value={b.quantity} onChange={(e) => updateBatch(idx, bi, { quantity: e.target.value })} placeholder="Qty" />
                                <button type="button" onClick={() => removeBatch(idx, bi)} className="col-span-2 flex items-center justify-center rounded-lg p-2 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--neg)] lg:col-span-1" aria-label="Remove batch"><Trash2 className="h-4 w-4" /></button>
                              </div>
                            ))}
                            <button type="button" onClick={() => addBatch(idx)} className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-1.5 text-xs font-bold text-[var(--accent)] hover:bg-[var(--surface-2)]"><Plus className="h-3.5 w-3.5" /> Add batch</button>
                            <p className={`text-[11px] ${batchSum === accepted ? "text-[var(--faint)]" : "text-[var(--neg)]"}`}>Batch total {batchSum} of {accepted} accepted.</p>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <FieldError message={errors.items} />
          </FormSection>

          <FormSection title="Quality check" description="A summary flag for this delivery.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Quality status</label>
                <Select value={qualityStatus} onChange={(v) => { setQualityStatus(v as typeof qualityStatus); touch(); }} options={QUALITY.map((q) => ({ value: q, label: QUALITY_LABELS[q] }))} ariaLabel="Quality status" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Overall quality outcome for this delivery.</p>
              </div>
              <div>
                <label className={labelCls}>Quality notes</label>
                <input className={inputCls} value={qualityNotes} onChange={(e) => { setQualityNotes(e.target.value); touch(); }} maxLength={2000} placeholder="e.g. 2 connectors damaged during transport" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Record issues found during inspection.</p>
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Internal notes</label>
                <textarea className={inputCls} rows={2} value={internalNotes} onChange={(e) => { setInternalNotes(e.target.value); touch(); }} maxLength={2000} placeholder="e.g. Stored in Rack A3 after inspection" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Internal notes visible only to staff.</p>
              </div>
            </div>
          </FormSection>

          <FormSection title="Delivery documents" description="Attach the supplier's delivery / dispatch note (plus any packing slip or photo). Retained against this receipt for audit.">
            {canEditDocs && (
              <div className="mb-4">
                <DocPicker count={docItems.length} totalBytes={docTotalBytes} onPick={onPickDoc} />
                {mode === "create" && <p className="mt-1.5 text-[11px] text-[var(--faint)]">Files upload automatically when you create the draft.</p>}
              </div>
            )}
            <AttachmentGrid items={docItems} onRemove={canEditDocs ? onRemoveDoc : undefined} />
          </FormSection>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Receipt summary">
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between"><span className="text-[var(--muted)]">Lines receiving</span><span className="font-semibold text-[var(--ink)]">{lines.filter((l) => num(l.receive) > 0).length}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Total received</span><span className="font-semibold text-[var(--ink)]">{lines.reduce((a, l) => a + num(l.receive), 0)}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Total accepted</span><span className="font-extrabold text-[var(--ink)]">{lines.reduce((a, l) => a + acceptedOf(l), 0)}</span></div>
              <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">Inventory is updated only when the receipt is completed. The GRN number is assigned when the draft is saved.</p>
            </div>
          </FormAsideCard>
        </aside>
      </div>
    </form>
  );
}
