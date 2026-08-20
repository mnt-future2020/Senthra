"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Eye, Loader2, Plus, Trash2 } from "lucide-react";

import * as prfService from "@/services/purchase-request.service";
import { listSuppliers } from "@/services/supplier.service";
import { listWarehouses } from "@/services/warehouse.service";
import { listIrmItems } from "@/services/irm.service";
import { listRentalItems } from "@/services/rental.service";
import { packHint } from "./packHint";
import { useDashboard } from "@/hooks/useDashboard";
import { useReferenceData } from "@/hooks/useReferenceData";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";
import { Select } from "@/components/ui/Select";
import { PaymentTermsField } from "@/components/ui/PaymentTermsField";
import { INCOTERM_OPTIONS } from "@/lib/incoterms";
import { resolveSupplierPaymentTerms } from "@/lib/paymentTerms";
import { earliestHireStart, hireDeliveryWarning, lateHireDeliveryDays } from "@/lib/hireDelivery";
import { viewFileInNewTab } from "@/lib/download";
import { shrinkImage } from "@/lib/image";
import { uploadDirect } from "@/lib/upload";
import { FieldError, FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { Notice } from "@/components/ui/Notice";
import { formatMoney } from "./prfStatus";
import type { PurchaseRequest } from "@/types/purchase-request";
import type { Supplier } from "@/types/supplier";
import type { Warehouse } from "@/types/warehouse";
import type { IrmItem } from "@/types/irm";
import type { RentalItem } from "@/types/rental";
import {
  blankRentalLine,
  capNotifyLead,
  duplicateRentalRowKeys,
  DUPLICATE_ROW_MESSAGE,
  hireDateNotice,
  agreedUnitPrice,
  applyBasisChange,
  billablePeriods,
  calculatedUnitPrice,
  hireRangeError,
  RATE_PERIOD_OPTIONS,
  RATE_PERIODS,
  notifyLeadMax,
  reminderDate,
  returnModeOptions,
  RETURN_MODES,
  rowHireDays,
  toRentalPayload,
  validateRentalLines,
  type RentalLineRow,
  type RatePeriod,
  type ReturnMode,
} from "./rentalLineRows";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";

const PRF_LIST = "/dashboard/purchase-requests";

// `_key` is a stable, frontend-only React key (never sent to the backend) so rows
// keep their identity across add/remove and controlled inputs don't desync. Unit price is
// the supplier's QUOTED price (£ in the form, pence on the wire).
type LineRow = { _key: string; irmItemId: string; quantity: string; unitPrice: string; vatRate: string; notes: string };

// A quote file selected on the CREATE form and held client-side (as a data URI) until the PRF
// exists — the attachment API needs the new PRF's id, so we upload right AFTER create. On edit,
// files go straight to the detail page's Attachments tab instead (the PRF already exists).
// A quote file picked before the PRF exists. Holds the FILE, not a base64 copy of it: the upload
// posts the file straight to Cloudinary, and the preview opens it as a blob — neither needs a string.
type PendingFile = { _key: string; fileType: string; file: File };
const ATTACH_EXT: Record<string, string> = { pdf: "pdf", docx: "docx", png: "png", jpg: "jpg", jpeg: "jpg" };
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

const dateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
const today = () => new Date().toISOString().slice(0, 10);

// "Today" for the RENDER path (the hire-period notice), as opposed to `today()` above which is only
// ever called from validate(). Read through useSyncExternalStore with a null server snapshot — the
// same treatment UserForm gives its date bounds, and for the same two reasons: nothing impure is
// read during render, and SSR (UTC) and the browser (local) can disagree either side of midnight,
// so the server emits no notice and the client fills it in. Hydration always matches.
const subscribeNever = () => () => {};
const serverToday = () => null;
const blankLine = (): LineRow => ({ _key: crypto.randomUUID(), irmItemId: "", quantity: "1", unitPrice: "", vatRate: "20", notes: "" });

export function PurchaseRequestForm({ mode, request }: { mode: "create" | "edit"; request?: PurchaseRequest | null }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();

  const r = request;
  const [supplierId, setSupplierId] = React.useState(r?.supplierId ?? "");
  const [warehouseId, setWarehouseId] = React.useState(r?.warehouseId ?? "");
  // The Job picker was removed from the form; the value is still carried so an EDIT does not
  // silently unset a job link created elsewhere.
  const jobId = r?.jobId ?? "";
  const [projectRef, setProjectRef] = React.useState(r?.projectRef ?? "");
  const [quoteReference, setQuoteReference] = React.useState(r?.quoteReference ?? "");
  const [quoteDate, setQuoteDate] = React.useState(dateInput(r?.quoteDate));
  const [quoteValidUntil, setQuoteValidUntil] = React.useState(dateInput(r?.quoteValidUntil));
  const [requiredByDate, setRequiredByDate] = React.useState(dateInput(r?.requiredByDate));
  const [justification, setJustification] = React.useState(r?.justification ?? "");
  const [notes, setNotes] = React.useState(r?.notes ?? "");
  const [deliveryTerms, setDeliveryTerms] = React.useState(r?.deliveryTerms ?? "");
  // Payment terms for THIS request — pre-fills from the selected supplier's default when the
  // field is still empty (see the Supplier onChange) but is editable and never clobbers a value
  // the user has typed.
  const [paymentTerms, setPaymentTerms] = React.useState(r?.paymentTerms ?? "");
  const [lineRows, setLineRows] = React.useState<LineRow[]>(() => {
    if (r && r.items.length) {
      return r.items.map((i) => ({ _key: crypto.randomUUID(), irmItemId: i.irmItemId, quantity: String(i.quantity), unitPrice: i.unitPrice.toFixed(2), vatRate: String(i.vatRate), notes: i.notes ?? "" }));
    }
    // A saved RENTAL-ONLY draft: its author already decided there are no IRM items, so don't hand
    // the empty card back on every edit. A brand-new request still gets one row ready to type.
    if (r?.rentalItems?.length) return [];
    return [blankLine()];
  });

  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = React.useState<Warehouse[]>([]);
  const [items, setItems] = React.useState<IrmItem[]>([]);
  const todayForNotice = React.useSyncExternalStore(subscribeNever, today, serverToday);
  const [rentalItems, setRentalItems] = React.useState<RentalItem[]>([]);
  const [rentalRows, setRentalRows] = React.useState<RentalLineRow[]>(() =>
    request?.rentalItems?.length
      ? request.rentalItems.map((r) => ({
          _key: crypto.randomUUID(),
          rentalItemId: r.rentalItemId,
          quantity: String(r.quantity),
          hireStartDate: r.hireStartDate.slice(0, 10),
          hireEndDate: r.hireEndDate.slice(0, 10),
          notifyDaysBefore: String(r.notifyDaysBefore),
          deliveryAddress: r.deliveryAddress ?? "",
          returnMode: (RETURN_MODES as readonly string[]).includes(r.returnMode)
            ? (r.returnMode as ReturnMode)
            : "delivery",
          returnAddress: r.returnAddress ?? "",
          ratePeriod: (RATE_PERIODS as readonly string[]).includes(r.ratePeriod)
            ? (r.ratePeriod as RatePeriod)
            : "total",
          rate: r.ratePence == null ? "" : (r.ratePence / 100).toFixed(2),
          priceOverridden: Boolean(r.priceOverridden),
          unitPrice: r.unitPrice.toFixed(2),
          vatRate: String(r.vatRate),
          notes: r.notes ?? "",
        }))
      : [],
  );
  // Quote files picked on the create form, held until the PRF exists (create only — on edit the
  // detail page owns attachments).
  const [pendingFiles, setPendingFiles] = React.useState<PendingFile[]>([]);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // Live "uploading N of M" label while quote files upload after the PRF is created, so a slow
  // Cloudinary upload reads as visible progress rather than a hung button.
  const [uploadProgress, setUploadProgress] = React.useState<{ done: number; total: number } | null>(null);
  // Count of files still being read into memory by FileReader — gates the submit so a file can't
  // be dropped by a "pick then immediately Create" race.
  const [readingCount, setReadingCount] = React.useState(0);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const touch = () => setDirty(true);

  const { isLoading: refLoading } = useReferenceData([
    { label: "suppliers", load: () => listSuppliers({ status: "active", pageSize: 100 }), onData: (s) => setSuppliers(s.suppliers) },
    { label: "delivery warehouses", load: () => listWarehouses({ status: "active", pageSize: 100 }), onData: (w) => setWarehouses(w.warehouses) },
    { label: "the item catalogue", load: () => listIrmItems({ status: "active", pageSize: 100 }), onData: (i) => setItems(i.items) },
    { label: "the rental catalogue", load: () => listRentalItems({ status: "active", pageSize: 100 }), onData: (r) => setRentalItems(r.items) },
  ]);

  useReportDirty("prf-form", dirty && !saved);

  const supplierPanel = suppliers.find((s) => s.id === supplierId) ?? r?.supplier ?? null;

  // Picking a supplier pre-fills the (still-empty) payment-terms field from that supplier's
  // default. Done in the event handler rather than an effect so a user's own edit is never
  // clobbered and we avoid a cascading render.
  const onPickSupplier = (id: string) => {
    setSupplierId(id);
    if (!paymentTerms.trim()) {
      const picked = suppliers.find((s) => s.id === id) ?? (id === r?.supplierId ? r?.supplier : null);
      const resolved = resolveSupplierPaymentTerms(picked);
      if (resolved) setPaymentTerms(resolved);
    }
    touch();
    clearError("supplierId");
  };

  // Selected warehouse + its composed address, shown read-only so the requester can see
  // where the goods would be delivered once the request becomes an order.
  const selectedWarehouse = warehouses.find((w) => w.id === warehouseId) ?? null;
  const warehouseAddressLines = selectedWarehouse
    ? [
        selectedWarehouse.addressLine1,
        selectedWarehouse.addressLine2,
        selectedWarehouse.city,
        selectedWarehouse.county,
        selectedWarehouse.postcode,
        selectedWarehouse.country,
      ]
        .map((l) => l?.trim())
        .filter((l): l is string => Boolean(l))
    : [];

  const itemOptions = React.useMemo(() => {
    // keep any already-selected (possibly now-inactive) line items visible on edit
    const map = new Map(items.map((i) => [i.id, i]));
    return { map, list: items };
  }, [items]);

  const goBack = () =>
    guard.attemptLeave(() => {
      if (window.history.length > 1) router.back();
      else router.push(PRF_LIST);
    });
  const clearError = (f: string) => setErrors((p) => { if (!p[f]) return p; const n = { ...p }; delete n[f]; return n; });

  const updateLine = (idx: number, patch: Partial<LineRow>) => {
    setLineRows((rows) => rows.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
    touch();
    clearError("items");
  };
  const onPickItem = (idx: number, irmItemId: string) => {
    const item = itemOptions.map.get(irmItemId);
    updateLine(idx, {
      irmItemId,
      unitPrice: item?.standardCost != null ? item.standardCost.toFixed(2) : "",
      vatRate: item?.vatRatePercent != null ? String(item.vatRatePercent) : "20",
    });
  };
  const addLine = () => { setLineRows((rows) => [...rows, blankLine()]); touch(); };
  const removeLine = (idx: number) => { setLineRows((rows) => rows.filter((_, i) => i !== idx)); touch(); };

  // Quote-file picker (create form). Validates type + size like the detail-page uploader, then
  // holds the file as a data URI until the PRF is created. Same allowed types (pdf/docx/png/jpg)
  // and 10 MB cap enforced by the backend attachment schema.
  const onPickFile = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    for (const rawFile of Array.from(fileList)) {
      const ext = rawFile.name.split(".").pop()?.toLowerCase() ?? "";
      if (!ATTACH_EXT[ext]) {
        pushToast(`"${rawFile.name}" isn't a supported type. Use PDF, DOCX, PNG or JPG.`, "alert");
        continue;
      }
      // Counted BEFORE the first await, and that ordering is the point: the submit button watches
      // this to stay disabled until every picked file has finished. Incrementing it inside the async
      // body would leave a window where "pick then Create" submits with the file not yet staged.
      setReadingCount((n) => n + 1);
      void (async () => {
        try {
          // Downscale first, then measure — a photographed quote is regularly over the cap in its
          // original form and well under it once stored. PDFs and DOCX pass through unchanged.
          const file = await shrinkImage(rawFile);
          // Re-derived, because a PNG re-encoded as JPEG arrives renamed.
          const fileType = ATTACH_EXT[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? "jpg";
          if (file.size > MAX_ATTACH_BYTES) {
            pushToast(`"${file.name}" is over 10 MB.`, "alert");
            return;
          }
          setPendingFiles((prev) => [...prev, { _key: crypto.randomUUID(), fileType, file }]);
          touch();
        } catch {
          pushToast(`Couldn't read "${rawFile.name}".`, "alert");
        } finally {
          setReadingCount((n) => n - 1);
        }
      })();
    }
  };
  const removePendingFile = (key: string) => { setPendingFiles((prev) => prev.filter((f) => f._key !== key)); touch(); };
  const viewPendingFile = (f: PendingFile) => {
    if (!viewFileInNewTab(f.file)) pushToast(`Couldn't preview "${f.file.name}".`, "alert");
  };

  // Live financial preview (pounds).
  const totals = React.useMemo(() => {
    let subtotal = 0;
    let vat = 0;
    // BOTH grids, matching the server's roll-up — an estimate that ignored the rental lines would
    // contradict the total the request comes back with.
    //
    // A rental row's price is `agreedUnitPrice`, NOT its price box: on a rate basis the box holds
    // the calculated figure for display while the row's own `unitPrice` is still empty, so reading
    // the box showed £0.00 beside a line that was about to save at £600.
    const priced = [
      ...lineRows.map((row) => ({ qty: Number(row.quantity) || 0, price: Number(row.unitPrice) || 0, vatRate: row.vatRate })),
      ...rentalRows
        .filter((r) => r.rentalItemId)
        .map((row) => ({ qty: Number(row.quantity) || 0, price: agreedUnitPrice(row), vatRate: row.vatRate })),
    ];
    for (const row of priced) {
      const lineEx = row.qty * row.price;
      subtotal += lineEx;
      vat += (lineEx * (Number(row.vatRate) || 0)) / 100;
    }
    return { subtotal, vat, grand: subtotal + vat };
  }, [lineRows, rentalRows]);

  // Which hire rows repeat one above them. Resolved for the whole section at once because a row
  // cannot see its neighbours: computed per row it would be the same scan of the same list N times,
  // and the answer has to agree with the submit-time check to the letter.
  const duplicateKeys = React.useMemo(() => duplicateRentalRowKeys(rentalRows), [rentalRows]);

  // "Required by" IS the day the kit has to be on site, and for a hire that is the day the hire
  // starts — so the requester was being asked to type the same date twice, and the second one drifted.
  // Prefilled ONCE per form: after that the field is theirs, and clearing it must stay cleared
  // (the required-field rule catches an empty one) rather than springing back.
  const earliestHire = React.useMemo(() => earliestHireStart(rentalRows), [rentalRows]);
  const prefilledRequiredBy = React.useRef(false);
  React.useEffect(() => {
    if (prefilledRequiredBy.current || !earliestHire || requiredByDate) return;
    prefilledRequiredBy.current = true;
    setRequiredByDate(earliestHire);
  }, [earliestHire, requiredByDate]);

  // Advisory only — never blocks the save. See lib/hireDelivery.ts for why.
  const hireDaysLate = lateHireDeliveryDays(requiredByDate, rentalRows);

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!supplierId) errs.supplierId = "Select a supplier.";
    if (!warehouseId) errs.warehouseId = "Select a delivery warehouse.";
    if (quoteDate && quoteValidUntil && quoteValidUntil < quoteDate) errs.quoteValidUntil = "Can't end before the quote date.";
    // Required: it becomes the PO's expected delivery date, and nothing else derives one.
    if (!requiredByDate) errs.requiredByDate = "Required-by date is required.";
    // A needed-by date in the past can't be met by an order that hasn't been placed yet. Only
    // checked on CREATE — an old draft being edited may legitimately have slipped past its date.
    else if (mode === "create" && requiredByDate < today()) errs.requiredByDate = "Can't be in the past.";

    const effective = lineRows.filter((row) => row.irmItemId);
    const effectiveRentals = rentalRows.filter((row) => row.rentalItemId);
    // A rental-only request is legitimate, so "at least one line" spans BOTH grids — the same rule
    // the server moved onto its request body when rental lines arrived.
    if (effective.length === 0 && effectiveRentals.length === 0) errs.items = "Add at least one item or rental line.";
    else if (effective.length === 0) { /* rental-only: the IRM checks below have nothing to say */ }
    else if (new Set(effective.map((row) => row.irmItemId)).size !== effective.length) errs.items = "Each item can only be added once.";
    else if (effective.some((row) => !(Number(row.quantity) >= 1))) errs.items = "Every line needs a quantity of at least 1.";
    else if (effective.some((row) => Number(row.unitPrice) < 0 || Number.isNaN(Number(row.unitPrice)))) errs.items = "Enter a valid quoted price for every line.";
    const rentalError = validateRentalLines(rentalRows);
    if (rentalError) errs.rentalItems = rentalError;
    return errs;
  };

  const buildPayload = (): prfService.PurchaseRequestPayload => ({
    supplierId,
    warehouseId,
    // Send explicit `null` when cleared so an EDIT actually unsets the field (an omitted key means
    // "leave unchanged"). On create, null is equivalent to unset.
    jobId: jobId || null,
    projectRef: projectRef.trim(),
    quoteReference: quoteReference.trim(),
    quoteDate: quoteDate || null,
    quoteValidUntil: quoteValidUntil || null,
    // NOT `|| null` like its neighbours: this one can never be cleared (it becomes the PO's
    // delivery date), so the schema rejects null. Omit it instead — "leave unchanged".
    requiredByDate: requiredByDate || undefined,
    justification: justification.trim(),
    notes: notes.trim(),
    deliveryTerms: deliveryTerms || null,
    paymentTerms: paymentTerms.trim() || null,
    items: lineRows
      .filter((row) => row.irmItemId)
      .map((row) => ({
        irmItemId: row.irmItemId,
        quantity: Number(row.quantity),
        unitPricePence: Math.round((Number(row.unitPrice) || 0) * 100),
        vatRate: Number(row.vatRate) || 0,
        notes: row.notes.trim() || undefined,
      })),
    rentalItems: toRentalPayload(rentalRows),
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const fieldErrors = validate();
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      pushToast("Please fix the highlighted fields.", "alert");
      focusFirstInvalid();
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (mode === "create") {
        const created = await prfService.createPurchaseRequest(buildPayload());
        setSaved(true);
        // Upload any quote files the user attached BEFORE saving, now that the PRF exists. The PRF
        // itself is already safely created — if a file fails to upload (e.g. Cloudinary hiccup) we
        // KEEP the PRF and just warn which file(s) to retry from the Attachments tab; the typed data
        // is never discarded over a transient file glitch. Uploaded sequentially so a mid-batch
        // failure still leaves the earlier files attached.
        const failed: string[] = [];
        for (let i = 0; i < pendingFiles.length; i++) {
          const f = pendingFiles[i];
          setUploadProgress({ done: i, total: pendingFiles.length });
          try {
            // The SAME call the detail page makes. Straight to Cloudinary, then finalize attaches it
            // through the request's own service — one attach path for the module instead of two, and
            // the bytes no longer make a detour through our API as a base64 string 1.33× their size.
            await uploadDirect({ purpose: "prf_attachment", file: f.file, targetId: created.id });
          } catch {
            failed.push(f.file.name);
          }
        }
        setUploadProgress(null);
        if (failed.length) {
          pushToast(
            `Purchase request ${created.code} created, but ${failed.length === 1 ? `"${failed[0]}" didn't upload` : `${failed.length} files didn't upload`} — retry from the Attachments tab.`,
            "alert",
          );
        } else {
          pushToast(`Purchase request ${created.code} created.`, "success");
        }
        router.replace(`/dashboard/purchase-requests/${created.code}`);
      } else if (r) {
        await prfService.updatePurchaseRequest(r.id, buildPayload());
        setSaved(true);
        pushToast("Purchase request updated.", "success");
        router.replace(`/dashboard/purchase-requests/${r.code}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save the purchase request.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title={mode === "create" ? "New purchase request" : `Edit ${r?.code ?? "request"}`}
        subtitle={mode === "edit" && r ? r.code : "Capture a supplier quotation for finance approval"}
        onBack={goBack}
        actions={
          <>
            <button type="button" onClick={goBack} disabled={saving} className={ghostBtn}>Cancel</button>
            <button type="submit" disabled={saving || readingCount > 0} className={primaryBtn}>
              {(saving || readingCount > 0) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {uploadProgress
                ? `Uploading ${uploadProgress.done + 1} of ${uploadProgress.total}…`
                : readingCount > 0 ? "Reading file…"
                : mode === "create" ? "Create draft" : "Save changes"}
            </button>
          </>
        }
      />

      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Request information" description="Who quoted, where the goods would be delivered, and any project link.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Supplier<RequiredMark /></label>
                <Select value={supplierId} onChange={onPickSupplier} options={suppliers.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }))} placeholder={refLoading && !supplierId ? "Loading suppliers…" : "— Select a supplier —"} disabled={refLoading && !supplierId} ariaLabel="Supplier" invalid={Boolean(errors.supplierId)} />
                <FieldError id="err-supplierId" message={errors.supplierId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">The supplier this quotation came from.</p>
              </div>
              <div>
                <label className={labelCls}>Delivery warehouse<RequiredMark /></label>
                <Select value={warehouseId} onChange={(v) => { setWarehouseId(v); touch(); clearError("warehouseId"); }} options={warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})${w.isDefault ? " — default" : ""}` }))} placeholder={refLoading && !warehouseId ? "Loading warehouses…" : "— Select a warehouse —"} disabled={refLoading && !warehouseId} ariaLabel="Delivery warehouse" invalid={Boolean(errors.warehouseId)} />
                <FieldError id="err-warehouseId" message={errors.warehouseId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Where the goods would be delivered once ordered.</p>
              </div>
              <div>
                <label className={labelCls}>Project reference</label>
                <input className={inputCls} value={projectRef} onChange={(e) => { setProjectRef(e.target.value); touch(); }} maxLength={120} placeholder="e.g. PROJ-001" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Optional free-text project reference.</p>
              </div>
              <div>
                <label className={labelCls}>Required by<RequiredMark /></label>
                <input type="date" className={inputCls} value={requiredByDate} onChange={(e) => { setRequiredByDate(e.target.value); touch(); clearError("requiredByDate"); }} aria-invalid={Boolean(errors.requiredByDate)} placeholder="dd-mm-yyyy" />
                <FieldError id="err-requiredByDate" message={errors.requiredByDate} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                  When the goods are needed on site. Becomes the purchase order&apos;s expected delivery date.
                </p>
                {hireDaysLate !== null && earliestHire ? (
                  <div className="mt-1.5">
                    <Notice msg={{ type: "warn", text: hireDeliveryWarning(hireDaysLate, earliestHire) }} size="xs" />
                  </div>
                ) : null}
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Justification</label>
                <textarea className={inputCls} rows={2} value={justification} onChange={(e) => { setJustification(e.target.value); touch(); }} maxLength={2000} placeholder="Why this purchase is needed (helps finance approve it faster)." />
              </div>
            </div>
          </FormSection>

          <FormSection
            title="Quotation"
            description={
              mode === "create"
                ? "Details of the supplier's quote this request is based on. Attach the quote document below — it uploads when you create the draft."
                : "Details of the supplier's quote this request is based on. The quote document is managed from the Attachments tab."
            }
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className={labelCls}>Quote reference</label>
                <input className={inputCls} value={quoteReference} onChange={(e) => { setQuoteReference(e.target.value); touch(); }} maxLength={120} placeholder="e.g. Q-2026-0142" />
              </div>
              <div>
                <label className={labelCls}>Quote date</label>
                <input type="date" className={inputCls} value={quoteDate} onChange={(e) => { setQuoteDate(e.target.value); touch(); }} placeholder="dd-mm-yyyy" />
              </div>
              <div>
                <label className={labelCls}>Quote valid until</label>
                <input type="date" className={inputCls} value={quoteValidUntil} min={quoteDate || undefined} onChange={(e) => { setQuoteValidUntil(e.target.value); touch(); clearError("quoteValidUntil"); }} aria-invalid={Boolean(errors.quoteValidUntil)} placeholder="dd-mm-yyyy" />
                <FieldError id="err-quoteValidUntil" message={errors.quoteValidUntil} />
              </div>
            </div>
            {/* Quote-document attach — CREATE only. On edit the detail page's Attachments tab owns files. */}
            {mode === "create" && (
              <div className="mt-4">
                <label className={labelCls}>Quote document(s)</label>
                <div className="flex flex-wrap items-center gap-2">
                  <label className={`${ghostBtn} cursor-pointer`}>
                    <input type="file" accept=".pdf,.docx,.png,.jpg,.jpeg" multiple className="hidden" onChange={(e) => { onPickFile(e.target.files); e.target.value = ""; }} />
                    Choose file(s)
                  </label>
                  <span className="text-[11px] text-[var(--faint)]">PDF, DOCX, PNG or JPG · max 10 MB each</span>
                </div>
                {pendingFiles.length > 0 && (
                  <ul className="mt-3 space-y-2">
                    {pendingFiles.map((f) => (
                      <li key={f._key} className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2">
                        <span className="min-w-0 truncate text-sm text-[var(--ink)]">
                          {f.file.name} <span className="text-[11px] text-[var(--faint)]">· {f.fileType.toUpperCase()} · {(f.file.size / 1024).toFixed(0)} KB</span>
                        </span>
                        <span className="ml-3 flex shrink-0 items-center gap-3">
                          {/* Preview the picked file before it's saved — opens in a new tab via a blob: URL. */}
                          <button type="button" onClick={() => viewPendingFile(f)} className="inline-flex items-center gap-1 text-xs font-bold text-[var(--accent)] hover:underline" aria-label={`View ${f.file.name}`}>
                            <Eye className="h-3.5 w-3.5" /> View
                          </button>
                          <button type="button" onClick={() => removePendingFile(f._key)} className="text-[var(--muted)] hover:text-[var(--neg)]" aria-label={`Remove ${f.file.name}`}>
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </FormSection>

          <FormSection title="Terms" description="Commercial terms for this request. These carry onto the generated purchase order.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Delivery terms</label>
                <Select value={deliveryTerms} onChange={(v) => { setDeliveryTerms(v); touch(); }} options={INCOTERM_OPTIONS} placeholder="— Select delivery terms —" ariaLabel="Delivery terms" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Optional — the agreed Incoterm for this order.</p>
              </div>
              <div>
                <label className={labelCls}>Payment terms</label>
                <PaymentTermsField value={paymentTerms} onChange={(v) => { setPaymentTerms(v); touch(); }} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Pre-filled from the supplier default — overrides it for this request only.</p>
              </div>
            </div>
          </FormSection>

          {supplierPanel && (
            <FormSection title="Supplier information" description="Read-only — pulled from the supplier record.">
              <div className="grid gap-3 sm:grid-cols-2 text-sm">
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Contact</p><p className="text-[var(--ink)]">{supplierPanel.contactPerson || "—"}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Payment terms</p><p className="text-[var(--ink)]">{supplierPanel.paymentTerms || "—"}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Email</p><p className="text-[var(--ink)]">{supplierPanel.contactEmail || "—"}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Phone</p><p className="text-[var(--ink)]">{supplierPanel.contactPhone || "—"}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Lead time</p><p className="text-[var(--ink)]">{supplierPanel.leadTimeDays != null ? `${supplierPanel.leadTimeDays} days` : "—"}</p></div>
              </div>
            </FormSection>
          )}

          <FormSection title="Items" description="Add one or more IRM items with the supplier's QUOTED prices. Prices and VAT pre-fill from each item's settings — adjust them to match the quote. UK standard VAT is 20%.">
            <div className="space-y-3">
              {lineRows.map((row, idx) => {
                const qty = Number(row.quantity) || 0;
                const price = Number(row.unitPrice) || 0;
                // Surface the selected supplier's own code for this item (read-only). Lookup is
                // local — the item list already carries each item's supplier links + codes.
                const pickedItem = row.irmItemId ? itemOptions.map.get(row.irmItemId) : undefined;
                const supplierLink = pickedItem && supplierId ? pickedItem.suppliers.find((s) => s.supplierId === supplierId) : undefined;
                const hint = packHint(pickedItem?.packSize ?? null, row.quantity);
                return (
                  <div key={row._key} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
                    <div className="space-y-3">
                      <div className="min-w-0">
                        <label className={labelCls}>Item</label>
                        <Select value={row.irmItemId} onChange={(v) => onPickItem(idx, v)} options={itemOptions.list.map((i) => ({ value: i.id, label: `${i.name} (${i.code})` }))} placeholder={refLoading && !row.irmItemId ? "Loading items…" : "— Select an item —"} disabled={refLoading && !row.irmItemId} ariaLabel="Item" />
                        {pickedItem && supplierId && supplierLink?.supplierSku && (
                          <p className="mt-1.5 text-[11px] text-[var(--muted)]">Supplier item code: <span className="font-mono text-[var(--ink)]">{supplierLink.supplierSku}</span></p>
                        )}
                      </div>
                      {/* Numerics — narrow, kept on their own row so the Quantity stepper never gets
                          squeezed. Three-up from the smallest tablet width; stacks 1-up on phones. */}
                      <div className="grid grid-cols-3 gap-3">
                        <div className="min-w-0">
                          <label className={labelCls}>Quantity</label>
                          <NumberInput className={inputCls} min={1} value={row.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} placeholder="e.g. 100" />
                          {/* ADVISORY, never a block. A reorder-generated request already arrives in
                              whole packs (the reorder engine rounds up); a hand-typed one doesn't, and
                              nothing on this form said the item even came in packs — so "380 metres"
                              of a 305m-box cable reached the supplier before anyone noticed. It is
                              deliberately not enforced: buying a part-pack is a real decision, it just
                              shouldn't be an accidental one. */}
                          {hint && <p className="mt-1.5 text-[11px] text-[var(--muted)]">{hint}</p>}
                        </div>
                        <div className="min-w-0">
                          <label className={labelCls}>Quoted price (£)</label>
                          <NumberInput className={inputCls} min={0} step="0.01" value={row.unitPrice} onChange={(e) => updateLine(idx, { unitPrice: e.target.value })} placeholder="e.g. 12.50" />
                        </div>
                        <div className="min-w-0">
                          <label className={labelCls}>VAT %</label>
                          <NumberInput className={inputCls} min={0} max={100} step="0.01" value={row.vatRate} onChange={(e) => updateLine(idx, { vatRate: e.target.value })} placeholder="20" />
                        </div>
                      </div>
                    </div>
                    <div className="mt-2.5 flex items-center justify-between border-t border-[var(--border)] pt-2.5">
                      <div className="text-xs">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Line total </span>
                        <span className="font-semibold text-[var(--ink)]">{formatMoney(qty * price)}</span>
                      </div>
                      <button type="button" onClick={() => removeLine(idx)} className="rounded-lg p-2 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)] disabled:opacity-40" title="Remove line" aria-label="Remove line">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
              <button type="button" onClick={addLine} className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--accent)] transition-colors hover:bg-[var(--surface-2)]">
                <Plus className="h-3.5 w-3.5" /> Add item
              </button>
              <FieldError id="err-items" message={errors.items} />
            </div>
          </FormSection>

          <FormSection
            title="Rental lines"
            description="Equipment hired for a fixed period. Each line sets its own hire dates, and its own delivery address when it should not go to the selected warehouse."
          >
            <div className="space-y-3">
              {rentalRows.map((row, idx) => {
                const picked = rentalItems.find((r) => r.id === row.rentalItemId);
                const days = rowHireDays(row);
                const duplicate = duplicateKeys.has(row._key);
                // ONE message per row, and the blocking one wins: while the range itself is
                // impossible, "this hire has already ended" is a true statement about the wrong
                // problem.
                const rangeError = hireRangeError(row);
                const reminderOn = reminderDate(row);
                const calculated = calculatedUnitPrice(row);
                const periods = billablePeriods(row);
                // What the line will actually be saved with — the calculation, or the typed figure
                // once someone has overridden it. The server applies the identical rule.
                const agreed = agreedUnitPrice(row);
                // Switching basis is a COMMERCIAL change, not a formatting one: £55/day and £55/week
                // are different money. The rate is kept (retyping it is worse) and the recalculated
                // figure is shown, so the review is unavoidable rather than implied. The rule itself
                // lives in rentalLineRows so it can be tested — including the part that stops a
                // switch to "total" blanking a price the box was displaying a moment earlier.
                const changeBasis = (next: RatePeriod) => setRow(applyBasisChange(row, next));
                const notice = rangeError || duplicate || !todayForNotice ? undefined : hireDateNotice(row, todayForNotice);
                const setRow = (patchRow: Partial<RentalLineRow>) => {
                  setRentalRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patchRow } : r)));
                  touch();
                };
                return (
                  <div key={row._key} className="@container rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-3">
                    <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @xl:grid-cols-4 @3xl:grid-cols-12">
                      <div className="min-w-0 @sm:col-span-2 @xl:col-span-4 @3xl:col-span-4">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Rental item</label>
                        <Select
                          value={row.rentalItemId}
                          // No price is prefilled: the catalogue holds none. What a hire costs is
                          // agreed for THIS request, so it is typed in below alongside the period.
                          onChange={(v) => setRow({ rentalItemId: v })}
                          options={rentalItems.map((r) => ({ value: r.id, label: `${r.name} (${r.code})` }))}
                          placeholder="— Select a rental item —"
                          ariaLabel="Rental item"
                          // The item is the field most likely to be the mistake — the same kit picked
                          // twice — and marking it points at the row to delete rather than at the row
                          // it collides with.
                          invalid={duplicate}
                        />
                      </div>
                      <div className="min-w-0 @xl:col-span-2 @3xl:col-span-2">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Qty</label>
                        <NumberInput className={inputCls} min="1" step="1" value={row.quantity} onChange={(e) => setRow({ quantity: e.target.value })} />
                      </div>
                      <div className="min-w-0 @xl:col-span-2 @3xl:col-span-3">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Hire start</label>
                        <input type="date" className={inputCls} value={row.hireStartDate} onChange={(e) => setRow({ hireStartDate: e.target.value })} />
                      </div>
                      <div className="min-w-0 @xl:col-span-2 @3xl:col-span-3">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Hire end</label>
                        {/* `min` so the native calendar cannot even scroll to a day the form would
                            reject — the treatment UserForm's date bounds and the PO's confirmed
                            delivery date already get. It is the FIRST of three layers, not the only
                            one: a typed date walks straight past `min`, so the row still says so
                            below, and validate() still refuses the submit. */}
                        <input
                          type="date"
                          className={inputCls}
                          value={row.hireEndDate}
                          min={row.hireStartDate || undefined}
                          aria-invalid={Boolean(rangeError)}
                          onChange={(e) => setRow({ hireEndDate: e.target.value })}
                        />
                      </div>
                      <div className="min-w-0 @xl:col-span-2 @3xl:col-span-3">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Pricing basis</label>
                        <Select
                          value={row.ratePeriod}
                          onChange={(v) => changeBasis(v as RatePeriod)}
                          options={RATE_PERIOD_OPTIONS}
                          ariaLabel="Pricing basis"
                        />
                      </div>
                      {row.ratePeriod !== "total" && (
                        <div className="min-w-0 @xl:col-span-2 @3xl:col-span-2">
                          <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Rate (£)</label>
                          <NumberInput
                            className={inputCls}
                            min="0"
                            step="0.01"
                            value={row.rate}
                            title={`The quoted rate per ${row.ratePeriod}.`}
                            onChange={(e) => setRow({ rate: e.target.value })}
                          />
                        </div>
                      )}
                      <div className={`min-w-0 @xl:col-span-2 ${row.ratePeriod === "total" ? "@3xl:col-span-4" : "@3xl:col-span-3"}`}>
                        {/* ONE label on every basis. It is the same field and the same stored
                            column whichever basis is picked; naming it "Price per unit" on `total`
                            and "Agreed / unit" on a rate suggested two different things, and the
                            one thing a reader must never have to hunt for is which number is the
                            money. */}
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Agreed price / unit</label>
                        {/* The stored value is `unitPricePence` and the line total is quantity ×
                            this — never × days. On a rate basis it is filled by the calculation;
                            typing over it marks the line overridden, and nothing recalculates it
                            afterwards. */}
                        <NumberInput
                          className={inputCls}
                          min="0"
                          step="0.01"
                          value={row.ratePeriod !== "total" && !row.priceOverridden ? (calculated ?? 0).toFixed(2) : row.unitPrice}
                          title="The agreed price for ONE unit for the whole hire period — not a daily rate."
                          onChange={(e) =>
                            setRow(
                              row.ratePeriod === "total"
                                ? { unitPrice: e.target.value }
                                : { unitPrice: e.target.value, priceOverridden: true },
                            )
                          }
                        />
                      </div>
                      <div className="min-w-0 @xl:col-span-2 @3xl:col-span-2">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">VAT %</label>
                        <NumberInput className={inputCls} min="0" max="100" step="0.1" value={row.vatRate} onChange={(e) => setRow({ vatRate: e.target.value })} />
                      </div>
                      <div className="min-w-0 @xl:col-span-2 @3xl:col-span-2">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Reminder (days)</label>
                        {/* The ceiling follows the HIRE, like Hire end's `min` follows the start date:
                            a 3-day notice on a 2-day hire is a lead the server can only clamp to the
                            first day, so the box that offered it would sit beside a reminder date
                            three days off and look broken. Capping it means the contradiction cannot
                            appear, and the row needs no sentence explaining one away.

                            `max` is advisory on its own — typing walks past it, and a lead typed
                            against a longer hire outlives the shortening of that hire — so the value
                            is capped on the way out too. Read time, not written back: the typed lead
                            survives in state and returns if the hire is stretched out again. */}
                        <NumberInput
                          className={inputCls}
                          min="0"
                          max={String(notifyLeadMax(days))}
                          step="1"
                          value={capNotifyLead(row.notifyDaysBefore, days)}
                          title="How many days before the hire end date the reminder is sent."
                          onChange={(e) => setRow({ notifyDaysBefore: e.target.value })}
                        />
                      </div>
                      <div className="min-w-0 @sm:col-span-2 @xl:col-span-4 @3xl:col-span-4">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Delivery address (optional)</label>
                        <textarea
                          className={inputCls}
                          rows={1}
                          maxLength={300}
                          placeholder="Leave blank for the selected warehouse"
                          value={row.deliveryAddress}
                          onChange={(e) => setRow({ deliveryAddress: e.target.value })}
                        />
                      </div>

                      {/* WHERE IT GOES BACK. A hire is a round trip, and this leg used to be stated
                          nowhere: the order told the supplier where to deliver and said nothing
                          about collection, so it got settled by phone.

                          A mode rather than an optional address box, because an optional box is
                          blank on nearly every line and a blank answers nothing. Every mode
                          resolves to a real place, so the order prints a definite collection point
                          on every line.

                          The two top modes land on the SAME place while the address above is blank,
                          and differ later — one follows the delivery address, the other is fixed on
                          the depot — so the difference is stated on hover, the treatment Rate,
                          Agreed price and Reminder already get. Not a helper line under the select:
                          this section is the tallest thing on a 1024px screen, and a line per row
                          would say it once per hire. */}
                      <div
                        className="min-w-0 @sm:col-span-2 @xl:col-span-4 @3xl:col-span-4"
                        title="Same as delivery — the supplier collects from wherever this line is delivered, which is the selected warehouse while the address above is blank. Collect from warehouse — always the selected warehouse, even when the line is delivered somewhere else. Other address — a collection point you type in."
                      >
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                          Return at end of hire
                        </label>
                        <Select
                          value={row.returnMode}
                          onChange={(v) => setRow({ returnMode: v as ReturnMode })}
                          options={returnModeOptions(selectedWarehouse?.name ?? null)}
                          ariaLabel="Return at end of hire"
                        />
                      </div>
                      {row.returnMode === "other" && (
                        <div className="min-w-0 @sm:col-span-2 @xl:col-span-4 @3xl:col-span-4">
                          <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                            Collection address
                          </label>
                          <textarea
                            className={inputCls}
                            rows={1}
                            maxLength={300}
                            placeholder="Where the supplier collects this hire from."
                            value={row.returnAddress}
                            onChange={(e) => setRow({ returnAddress: e.target.value })}
                          />
                        </div>
                      )}

                      {/* The line's own notes. The row model and the payload have always carried
                          this field — nothing on the form ever set it, so every rental line reached
                          the approver with an empty one while IRM lines had theirs. Shares this row
                          rather than opening another: the section is already the tallest thing on a
                          1024px screen. */}
                      <div className={`min-w-0 @sm:col-span-2 @xl:col-span-4 ${row.returnMode === "other" ? "@3xl:col-span-12" : "@3xl:col-span-4"}`}>
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Notes (optional)</label>
                        <textarea
                          className={inputCls}
                          rows={1}
                          maxLength={2000}
                          placeholder="Anything the approver or supplier should know about this hire."
                          value={row.notes}
                          onChange={(e) => setRow({ notes: e.target.value })}
                        />
                      </div>
                    </div>
                    {/* Footer strip — the hire summary on the left, Remove on the right, matching the
                        IRM line's "Line total / remove" strip above. The button used to be a grid cell,
                        which claimed an entire row to itself once the grid collapsed to one column. */}
                    <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-[var(--border)] pt-2.5">
                      {days !== null && days > 0 ? (
                      <p className="min-w-0 text-[11px] text-[var(--muted)]">
                        <strong className="text-[var(--ink)]">
                          {days} day{days === 1 ? "" : "s"}
                        </strong>{" "}
                        hire
                        {row.ratePeriod === "total"
                          ? ` · the price is for the whole period${picked?.baseUnit ? `, per ${picked.baseUnit.toLowerCase()}` : ""}.`
                          : periods != null
                            ? ` · ${periods} ${row.ratePeriod}${periods === 1 ? "" : "s"} charged${
                                row.ratePeriod === "week"
                                  ? " (part weeks are charged as full weeks)"
                                  : row.ratePeriod === "month"
                                    ? " (part months are charged as full months)"
                                    : " (the return date is not charged)"
                              }.`
                            : "."}
                        {reminderOn ? ` Reminder on ${reminderOn.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })}.` : ""}
                      </p>
                      ) : (
                        // Keeps the strip's justify-between honest so the button stays hard right
                        // before any dates are entered.
                        <span />
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setRentalRows((rows) => rows.filter((_, i) => i !== idx));
                          touch();
                        }}
                        className="shrink-0 rounded-lg p-2 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)]"
                        title="Remove rental line"
                        aria-label="Remove rental line"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    {/* A WARNING, not a rule: back-dating is legitimate (the kit went out last week
                        and the paperwork is catching up), so the line still saves. It is said out
                        loud because the alternative is a purchase order that is overdue the moment
                        it exists — straight onto the red badge, with its reminder already due. */}
                    {rangeError && (
                      <p className="mt-1 flex items-start gap-1.5 text-[11px] font-semibold text-[var(--neg)]" data-invalid="true">
                        <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                        {rangeError}
                      </p>
                    )}
                    {/* The duplicate rule, said on the row that breaks it. The submit banner sits
                        under the whole section, so with four hire lines on screen it announces that
                        something is duplicated and leaves the reader to find which two — the exact
                        problem the range error above was moved onto the row to solve.

                        Only ever on the SECOND and later of a set: the first is the line to keep, and
                        marking both makes the row to delete ambiguous. One sentence, matching its
                        siblings above — the full rule, including what it ignores, is in the submit
                        banner where there is room for it. */}
                    {duplicate && !rangeError && (
                      <p className="mt-1 flex items-start gap-1.5 text-[11px] font-semibold text-[var(--neg)]" data-invalid="true">
                        <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                        {DUPLICATE_ROW_MESSAGE}
                      </p>
                    )}
                    {row.ratePeriod !== "total" && row.priceOverridden && calculated != null && (
                      <p className="mt-1 flex items-start gap-1.5 text-[11px] font-semibold text-[var(--warn,#d97706)]">
                        <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                        Manually adjusted — the rate calculates {formatMoney(calculated)} per unit, this line is
                        agreed at {formatMoney(agreed)}.{" "}
                        <button
                          type="button"
                          onClick={() => setRow({ priceOverridden: false, unitPrice: calculated.toFixed(2) })}
                          className="font-bold underline underline-offset-2"
                        >
                          Use the calculated price
                        </button>
                      </p>
                    )}
                    {notice && (
                      <p className="mt-1 flex items-start gap-1.5 text-[11px] font-semibold text-[var(--warn,#d97706)]">
                        <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                        {notice}
                      </p>
                    )}
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => {
                  setRentalRows((rows) => [...rows, blankRentalLine()]);
                  touch();
                }}
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--accent)] transition-colors hover:bg-[var(--surface-2)]"
              >
                <Plus className="h-3.5 w-3.5" /> Add rental line
              </button>
              <FieldError id="err-rentalItems" message={errors.rentalItems} />
            </div>
          </FormSection>

          <FormSection title="Notes" description="Internal notes carried onto the request for approvers and procurement.">
            <textarea className={inputCls} rows={3} value={notes} onChange={(e) => { setNotes(e.target.value); touch(); }} maxLength={2000} placeholder="Anything else the approver should know (optional)." />
          </FormSection>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Financial summary">
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between"><span className="text-[var(--muted)]">Subtotal</span><span className="font-semibold text-[var(--ink)]">{formatMoney(totals.subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">VAT</span><span className="font-semibold text-[var(--ink)]">{formatMoney(totals.vat)}</span></div>
              <div className="flex justify-between border-t border-[var(--border-2)] pt-2.5"><span className="font-bold text-[var(--ink)]">Grand total</span><span className="font-extrabold text-[var(--ink)]">{formatMoney(totals.grand)}</span></div>
              <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">Totals are calculated automatically from the quoted lines. The PRF number is assigned when the draft is saved.</p>
              {selectedWarehouse && (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Delivering to</p>
                  <p className="mt-1 text-xs font-semibold text-[var(--ink)]">{selectedWarehouse.name} ({selectedWarehouse.code})</p>
                  {warehouseAddressLines.length > 0 && (
                    <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">{warehouseAddressLines.join(", ")}</p>
                  )}
                </div>
              )}
            </div>
          </FormAsideCard>
        </aside>
      </div>
    </form>
  );
}
