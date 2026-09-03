"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, Loader2, Plus, Trash2 } from "lucide-react";

import * as prfService from "@/services/purchase-request.service";
import { getSupplier, listSupplierOptions, type SupplierOption } from "@/services/supplier.service";
import { withHistoricalOption } from "@/lib/historicalOption";
import { supplierDetailNotice } from "@/lib/supplierPanel";
import { listWarehouses } from "@/services/warehouse.service";
import { listIrmItems } from "@/services/irm.service";
import { listRentalItems } from "@/services/rental.service";
import { mergeById, missingIds } from "@/lib/cataloguePicker";
import { useRentalItemsByIds } from "@/hooks/useRentalItemsByIds";
import { packHint } from "./packHint";
import { DOCUMENT_GROUPS, filesInGroup, removeDocument, type PrfDocumentGroup } from "./documentGroups";
import { IrmItemPicker } from "@/components/dashboard/irm/IrmItemPicker";
import { mergeIrmItems } from "@/components/dashboard/irm/irmItemPickerModel";
import { useAuth } from "@/hooks/useAuth";
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
import { allowedFrom, BUSINESS_DOC_ACCEPT, BUSINESS_DOC_LABEL, resolveFileType } from "@/lib/uploadPolicy";
import { dropRing, useFileDrop } from "@/hooks/useFileDrop";
import { FieldError, FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { Notice } from "@/components/ui/Notice";
import { formatMoney } from "./prfStatus";
import type { PrfDocumentType, PurchaseRequest } from "@/types/purchase-request";
import type { Supplier } from "@/types/supplier";
import type { Warehouse } from "@/types/warehouse";
import type { IrmItem } from "@/types/irm";
import type { RentalItem } from "@/types/rental";
import { rentalEstimate, savedRentalLineRow, toRentalPayload, validateRentalLines, type RentalLineRow } from "./rentalLineRows";
import { RentalLinesEditor } from "./RentalLinesEditor";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";

const PRF_LIST = "/dashboard/purchase-requests";

// `_key` is a stable, frontend-only React key (never sent to the backend) so rows
// keep their identity across add/remove and controlled inputs don't desync. Unit price is
// the supplier's QUOTED price (£ in the form, pence on the wire).
type LineRow = { _key: string; irmItemId: string; quantity: string; unitPrice: string; vatRate: string; notes: string };

// A document selected on the CREATE form and held client-side until the PRF exists — the attachment
// API needs the new PRF's id, so we upload right AFTER create. On edit, files go straight to the
// detail page's Attachments tab instead (the PRF already exists).
//
// Holds the FILE, not a base64 copy of it: the upload posts the file straight to Cloudinary, and
// the preview opens it as a blob — neither needs a string.
//
// `documentType` rides on the row rather than being inferred from which list it ended up in. It is
// what the finalize call sends, so the group survives the trip in one piece: the two pickers are a
// UI arrangement, and this is the fact.
type PendingFile = { _key: string; documentType: PrfDocumentType; fileType: string; file: File };

// The spreadsheet-capable policy, shared with the detail page's Attachments tab so a file accepted
// when creating a draft is not refused when added to the same request an hour later.
const ATTACH_ACCEPT = BUSINESS_DOC_ACCEPT;
const ATTACH_ALLOWED = allowedFrom(ATTACH_ACCEPT);
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
  const { can } = useAuth();

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

  // The COMPLETE active set, lean. The one supplier the aside panel describes in full is fetched
  // by id below — a paged list here hid every supplier past page 1 and, worse, rendered an
  // already-saved one as "none selected".
  const [suppliers, setSuppliers] = React.useState<SupplierOption[]>([]);
  // The full record for the CHOSEN supplier only (contacts, payment terms). The request itself
  // carries just a lean {id, code, name} reference, so on EDIT this is loaded once alongside the
  // other reference data — one request, not a page of suppliers the form will never show.
  const [supplierDetail, setSupplierDetail] = React.useState<Supplier | null>(null);
  const [warehouses, setWarehouses] = React.useState<Warehouse[]>([]);
  const [items, setItems] = React.useState<IrmItem[]>([]);
  const todayForNotice = React.useSyncExternalStore(subscribeNever, today, serverToday);
  const [rentalItems, setRentalItems] = React.useState<RentalItem[]>([]);
  // Through the SAME mapping the purchase order form reopens its hires with — identity is the item
  // id, never its name, so a renamed or since-retired item still lands on the same line.
  const [rentalRows, setRentalRows] = React.useState<RentalLineRow[]>(() => (request?.rentalItems ?? []).map(savedRentalLineRow));
  // Documents picked on the create form, held until the PRF exists (create only — on edit the
  // detail page owns attachments). ONE list, with each row carrying its own group: the sections
  // read their own slice, and every add/remove is keyed, so touching one group cannot disturb the
  // other — nor can it disturb the supplier, the lines, the quotation fields or anything else on
  // the form, none of which this state is wired to.
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
    { label: "suppliers", load: listSupplierOptions, onData: (o: SupplierOption[]) => setSuppliers(o) },
    // EDIT only: the panel and the payment-terms prefill describe the supplier already chosen.
    ...(r?.supplierId
      ? [{ label: "the supplier", load: () => getSupplier(r.supplierId), onData: (full: Supplier) => setSupplierDetail(full), onError: (err: unknown) => setSupplierNotice(supplierDetailNotice(err)) }]
      : []),
    { label: "delivery warehouses", load: () => listWarehouses({ status: "active", pageSize: 100 }), onData: (w) => setWarehouses(w.warehouses) },
    { label: "the item catalogue", load: () => listIrmItems({ status: "active", pageSize: 100 }), onData: (i) => setItems(i.items) },
    { label: "the rental catalogue", load: () => listRentalItems({ status: "active", pageSize: 100 }), onData: (r) => setRentalItems(r.items) },
  ]);

  useReportDirty("prf-form", dirty && !saved);

  // The panel describes the SELECTED supplier in full; the dropdown only needs id/code/name.
  const supplierPanel = supplierDetail && supplierDetail.id === supplierId ? supplierDetail : null;
  // Non-null when the SELECTED supplier's record could not be read — see supplierDetailNotice.
  const [supplierNotice, setSupplierNotice] = React.useState<string | null>(null);
  // Ticket for the supplier-detail fetch, so a slow answer for a supplier the user has moved on from
  // cannot write that supplier's payment terms onto the one now chosen.
  const supplierSeq = React.useRef(0);

  /**
   * A saved rental line can name an item outside the page loaded at mount, and unlike a PRF ITEM
   * line the saved rental line carries no code — only `itemName` — so there is nothing to build a
   * proper label from locally. Resolve them by id instead, all of them in ONE request: a request
   * with several rental lines must not become several lookups. Until they land the picker is told
   * it is loading, so a line that IS set never reads as empty.
   */
  const resolvingRentalItems = useRentalItemsByIds(
    missingIds(rentalRows.map((row) => row.rentalItemId), rentalItems),
    (found) => setRentalItems((prev) => mergeById(prev, found)),
  );

  // Picking a supplier pre-fills the (still-empty) payment-terms field from that supplier's
  // default. Done in the event handler rather than an effect so a user's own edit is never
  // clobbered and we avoid a cascading render.
  const onPickSupplier = (id: string) => {
    setSupplierId(id);
    touch();
    clearError("supplierId");
    if (!id) {
      // Bumped here too, so an in-flight answer cannot repopulate a panel the user has just cleared.
      supplierSeq.current++;
      setSupplierDetail(null);
      setSupplierNotice(null);
      return;
    }
    // ONE fetch for the supplier actually chosen — not a page of records the form will never show.
    // The payment-terms prefill waits for it, and still never clobbers a value the user has typed.
    //
    // Every pick takes a ticket, and a stale answer is dropped. Two picks in quick succession are
    // two requests in flight: the panel happens to be safe because it re-checks the id it holds, but
    // the payment-terms prefill has no such check, so supplier A answering after B was chosen wrote
    // A'S TERMS onto an order for B — a real commercial fact, silently wrong, on a field the user
    // had every reason to trust.
    const seq = ++supplierSeq.current;
    void getSupplier(id).then(
      (full) => {
        if (seq !== supplierSeq.current) return;
        setSupplierDetail(full);
        setSupplierNotice(null);
        setPaymentTerms((cur) => (cur.trim() ? cur : (resolveSupplierPaymentTerms(full) ?? cur)));
      },
      (err) => {
        if (seq !== supplierSeq.current) return;
        setSupplierDetail(null);
        setSupplierNotice(supplierDetailNotice(err));
      },
    );
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
  // The picker hands back the WHOLE item rather than its id, and it is merged into `items` before
  // the line is set. A search result — or an item just created from inside the picker — is not in
  // the page loaded at mount, and the price prefill, the pack hint and the supplier's own item code
  // all read from that list. Without the merge the row would select an item the form can't describe.
  const onPickItem = (idx: number, item: IrmItem) => {
    setItems((prev) => mergeIrmItems(prev, [item]));
    updateLine(idx, {
      irmItemId: item.id,
      unitPrice: item.standardCost != null ? item.standardCost.toFixed(2) : "",
      vatRate: item.vatRatePercent != null ? String(item.vatRatePercent) : "20",
    });
  };
  const addLine = () => { setLineRows((rows) => [...rows, blankLine()]); touch(); };
  const removeLine = (idx: number) => { setLineRows((rows) => rows.filter((_, i) => i !== idx)); touch(); };

  // Document picker (create form). Validates type + size like the detail-page uploader, then holds
  // the file until the PRF is created. The accepted types are not named here on purpose: they come
  // from BUSINESS_DOC_ACCEPT in lib/uploadPolicy, which is also what the input advertises and what
  // the help text reads back, so this comment cannot go stale the way its predecessor did (it still
  // said "pdf/docx/png/jpg" after spreadsheets were added). The 10 MB cap mirrors the backend's.
  // BOTH groups run through this one function, so neither can drift to a laxer rule than the other.
  // Takes a plain array as well as a FileList, so a DROP and a click reach the same function rather
  // than two that have to be kept in step. Everything below — the type gate, the shrink, the size
  // cap, the `readingCount` that holds the submit button — is therefore shared by construction.
  const onPickFile = (documentType: PrfDocumentType, fileList: FileList | File[] | null) => {
    if (!fileList || fileList.length === 0) return;
    for (const rawFile of Array.from(fileList)) {
      if (resolveFileType(rawFile.name, ATTACH_ALLOWED) == null) {
        pushToast(`"${rawFile.name}" isn't a supported type. Use ${BUSINESS_DOC_LABEL}.`, "alert");
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
          const fileType = resolveFileType(file.name, ATTACH_ALLOWED) ?? "jpg";
          if (file.size > MAX_ATTACH_BYTES) {
            pushToast(`"${file.name}" is over 10 MB.`, "alert");
            return;
          }
          setPendingFiles((prev) => [...prev, { _key: crypto.randomUUID(), documentType, fileType, file }]);
          touch();
        } catch {
          pushToast(`Couldn't read "${rawFile.name}".`, "alert");
        } finally {
          setReadingCount((n) => n - 1);
        }
      })();
    }
  };
  // Removal is BY KEY, never by index into a rendered slice — that is what makes "remove one quote
  // file" leave every other document, in either group, exactly where it was.
  const removePendingFile = (key: string) => { setPendingFiles((prev) => removeDocument(prev, key)); touch(); };
  const viewPendingFile = (f: PendingFile) => {
    if (!viewFileInNewTab(f.file)) pushToast(`Couldn't preview "${f.file.name}".`, "alert");
  };

  // Live financial preview (pounds).
  const totals = React.useMemo(() => {
    let subtotal = 0;
    let vat = 0;
    for (const row of lineRows) {
      const lineEx = (Number(row.quantity) || 0) * (Number(row.unitPrice) || 0);
      subtotal += lineEx;
      vat += (lineEx * (Number(row.vatRate) || 0)) / 100;
    }
    // BOTH grids, matching the server's roll-up — an estimate that ignored the rental lines would
    // contradict the total the request comes back with. Through the SHARED helper, which is what the
    // order form's estimate uses too (a hire is priced the same way on either document).
    const hire = rentalEstimate(rentalRows);
    subtotal += hire.subtotal;
    vat += hire.vat;
    return { subtotal, vat, grand: subtotal + vat };
  }, [lineRows, rentalRows]);


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
        // Upload any documents the user attached BEFORE saving, now that the PRF exists. The PRF
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
            await uploadDirect({
              purpose: "prf_attachment",
              file: f.file,
              targetId: created.id,
              // The group the user picked it under, carried to the server rather than re-guessed
              // there. The server re-validates it against its own enum — this is a claim, not a
              // decision.
              documentType: f.documentType,
            });
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
                <Select value={supplierId} onChange={onPickSupplier} options={withHistoricalOption(suppliers.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` })), supplierId, r?.supplier?.name)} placeholder={refLoading && !supplierId ? "Loading suppliers…" : "— Select a supplier —"} disabled={refLoading && !supplierId} ariaLabel="Supplier" invalid={Boolean(errors.supplierId)} />
                <FieldError id="err-supplierId" message={errors.supplierId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">The supplier this quotation came from.</p>
              </div>
              <div>
                <label className={labelCls}>Delivery warehouse<RequiredMark /></label>
                <Select value={warehouseId} onChange={(v) => { setWarehouseId(v); touch(); clearError("warehouseId"); }} options={withHistoricalOption(warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})${w.isDefault ? " — default" : ""}` })), warehouseId, r?.warehouse?.name)} placeholder={refLoading && !warehouseId ? "Loading warehouses…" : "— Select a warehouse —"} disabled={refLoading && !warehouseId} ariaLabel="Delivery warehouse" invalid={Boolean(errors.warehouseId)} />
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
                ? "Details of the supplier's quote this request is based on."
                : "Details of the supplier's quote this request is based on. Documents are managed from the Attachments tab."
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
          </FormSection>

          {/* Both groups in ONE section, side by side — and the pairing is the point twice over.
              Visually: two pickers stacked in full-width rows spent 295px of height on controls that
              need about a third of the row's width, on a form that is already long. Side by side
              they cost one section instead of two and leave the quotation card as just the quote
              figures.

              Editorially: a reviewer has to tell the supplier's PRICE from the EVIDENCE behind the
              ask, and putting the two side by side states that they are peers — two kinds of
              paperwork on one request — where stacking them under the quotation implied the second
              was a footnote to the first. Neither is hidden behind a toggle: both areas, and
              whatever is already in them, stay on screen at once.

              The description says only what the two group labels cannot: the file rule (identical for
              both, so stating it per-column was the same sentence twice), and when the files actually
              leave the browser. That the groups are kept apart is shown by the layout — writing it
              out as well is a caption on a picture of itself.

              CREATE only. On edit the detail page's Attachments tab owns every file. */}
          {mode === "create" && (
            <FormSection
              title="Documents"
              description={`Drag files onto an area or choose them. ${BUSINESS_DOC_LABEL} · max 10 MB each. Both upload when you create the draft.`}
            >
              {/* `xl`, not `md`, and the difference is not taste. This form sits beside the financial
                  summary aside, so the column these two share is far narrower than the viewport: at a
                  1024px window it is ~450px, which splits into two 190px columns — narrow enough that
                  a real filename wraps to eight lines and the "compact" two-column layout ends up
                  TALLER than simply stacking. Splitting at `xl` gives each group ~460px, which is
                  where the pairing actually pays. Below that they stack full-width, which is also
                  what every phone and tablet gets.

                  `items-start` so a group with three files picked does not stretch the empty one. */}
              <div className="grid items-start gap-x-6 gap-y-6 xl:grid-cols-2">
                {DOCUMENT_GROUPS.map((g) => (
                  <DocumentGroupPicker
                    key={g.type}
                    group={g}
                    files={filesInGroup(pendingFiles, g.type)}
                    onPick={onPickFile}
                    onRemove={removePendingFile}
                    onView={viewPendingFile}
                  />
                ))}
              </div>
            </FormSection>
          )}

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

          {/* The panel could not be loaded — say so, rather than rendering exactly like "no supplier
              chosen". `/suppliers/options` is wider than `suppliers.view`, so a purchaser can pick a
              supplier and then be refused this follow-up read; silence left them believing the
              supplier simply had no details or terms on file. */}
          {!supplierPanel && supplierNotice && supplierId && (
            <FormSection title="Supplier information" description="Read-only — pulled from the supplier record.">
              <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-xs text-[var(--muted)]">
                {supplierNotice}
              </p>
            </FormSection>
          )}

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
                // On EDIT, a saved line's item may sit outside the page loaded at mount, leaving
                // `pickedItem` undefined — which used to render as an empty picker on a line that
                // is in fact set, inviting someone to "fix" it by re-picking. The request carries
                // its own name + code for exactly this, so fall back to that for the label.
                const savedItemRef = !pickedItem && row.irmItemId
                  ? (r?.items.find((i) => i.irmItemId === row.irmItemId)?.irmItem ?? null)
                  : null;
                const supplierLink = pickedItem && supplierId ? pickedItem.suppliers.find((s) => s.supplierId === supplierId) : undefined;
                const hint = packHint(pickedItem?.packSize ?? null, row.quantity);
                return (
                  <div key={row._key} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
                    <div className="space-y-3">
                      <div className="min-w-0">
                        <label className={labelCls}>Item</label>
                        <IrmItemPicker
                          value={row.irmItemId}
                          selectedItem={pickedItem ?? savedItemRef}
                          seed={itemOptions.list}
                          onSelect={(item) => onPickItem(idx, item)}
                          canCreate={can("irm.create")}
                          // This request is built on one supplier's quote, so a new item created
                          // from here is almost certainly bought from them — pre-select it.
                          defaultSupplierId={supplierId}
                          disabled={refLoading && !row.irmItemId}
                          loading={refLoading}
                        />
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

          {/* The rental grid is SHARED with the purchase order form (RentalLinesEditor): a hire is
              the same line on both documents, validated by one server schema, and two grids would
              drift the first time one gained a field. This form owns the rows and the catalogue;
              the editor owns the layout. */}
          <RentalLinesEditor
            rows={rentalRows}
            setRows={setRentalRows}
            catalogue={rentalItems}
            onCatalogue={(found) => setRentalItems((prev) => mergeById(prev, found))}
            canCreate={can("rentals.create")}
            loading={refLoading || resolvingRentalItems}
            today={todayForNotice}
            warehouseNameFor={() => selectedWarehouse?.name ?? null}
            onTouch={touch}
            error={errors.rentalItems}
            description="Equipment hired for a fixed period. Each line sets its own hire dates, and its own delivery address when it should not go to the selected warehouse."
          />

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


/**
 * One document group's picker and its selected files.
 *
 * Both groups render through this, which is the point: the accepted types, the size hint, the
 * remove control and the keyboard/screen-reader wiring are written once, so "other documents"
 * cannot end up a second-class copy of the quote picker.
 *
 * Accessibility: the visible group label is tied to the file input by `id`/`htmlFor` (the input is
 * visually hidden, not `display:none`, so it stays focusable and the label is announced with it),
 * the helper text is referenced with `aria-describedby`, and the selected list is a labelled region
 * — so the two groups are told apart by name, never by position or colour alone.
 */
function DocumentGroupPicker({
  group,
  files,
  onPick,
  onRemove,
  onView,
}: {
  group: PrfDocumentGroup;
  files: PendingFile[];
  onPick: (documentType: PrfDocumentType, fileList: FileList | File[] | null) => void;
  onRemove: (key: string) => void;
  onView: (f: PendingFile) => void;
}) {
  const inputId = `prf-docs-${group.type}`;
  const helpId = `${inputId}-help`;
  // Each GROUP is its own drop target, and the target is the WHOLE group block — its heading, its
  // button, its help line and the files already in it. A quote dropped on the "Other documents"
  // block is filed as `other`, because the block is the user's statement of which group they meant.
  // Nothing here reads the file's TYPE to choose a group, which is what would make a CSV land
  // somewhere the user did not put it.
  //
  // It used to wrap only the button row: 547x38 inside a 547x83 block, so more than half of the
  // area a user aims at was a miss — and a miss on a page with no guard navigated the tab to the
  // file and took the unsaved request with it. The block costs no extra height, because the heading
  // and help text were already sitting there being useless to the drag.
  //
  // `-m-2 p-2` rather than a bare `p-2`: the padding gives the outline room to sit clear of the
  // label, and the equal negative margin puts the content back exactly where it was. Padding alone
  // indented these two group headings 8px past every other label on the form (measured: 321px
  // against 313px everywhere else), which is the kind of drift nothing fails on and everyone sees.
  const { dragging, armed, dropProps } = useFileDrop((files) => onPick(group.type, files));
  return (
    <div {...dropProps} className={`-m-2 rounded-xl p-2 ${dropRing(dragging, armed)}`}>
      <label className={labelCls} htmlFor={inputId}>{group.formLabel}</label>
      <div className="flex flex-wrap items-center gap-2">
        {/* `sr-only` rather than `hidden`: a hidden input is unreachable by keyboard, which would
            leave the only way to add a document a mouse click on its label. */}
        <input
          id={inputId}
          type="file"
          accept={ATTACH_ACCEPT}
          multiple
          aria-describedby={helpId}
          className="sr-only"
          onChange={(e) => { onPick(group.type, e.target.files); e.target.value = ""; }}
        />
        {/* A real <label> for a real focusable input: Tab reaches the input, Enter/Space opens the
            dialog, and the browser's own focus ring shows on the label. Drag/drop adds a way in
            without taking one away. */}
        <label htmlFor={inputId} className={`${ghostBtn} cursor-pointer`}>Choose file(s)</label>
        <span className="text-[11px] text-[var(--faint)]">or drag them here</span>
      </div>
      <p id={helpId} className="mt-1.5 text-[11px] text-[var(--faint)]">{group.help}</p>
      {files.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label={`${group.formLabel} selected`}>
          {files.map((f) => (
            <li key={f._key} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2">
              {/* `min-w-0` + `break-words` on the name: a long filename must wrap inside the row
                  rather than widen it, which on a 360px screen would scroll the whole page — but it
                  wraps at the breaks the name already offers (its hyphens) instead of mid-word.
                  `break-all` did the latter, turning one readable name into "supplier-qu /
                  otation-revi / sion-3-final", which is a filename nobody can check at a glance. */}
              <span className="min-w-0 flex-1 break-words text-sm text-[var(--ink)]">
                {f.file.name} <span className="text-[11px] text-[var(--faint)]">· {f.fileType.toUpperCase()} · {(f.file.size / 1024).toFixed(0)} KB</span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {/* Preview the picked file before it's saved — opens in a new tab via a blob: URL. */}
                <button type="button" onClick={() => onView(f)} className="inline-flex items-center gap-1 text-xs font-bold text-[var(--accent)] hover:underline" aria-label={`View ${f.file.name}`}>
                  <Eye className="h-3.5 w-3.5" /> View
                </button>
                <button type="button" onClick={() => onRemove(f._key)} className="text-[var(--muted)] hover:text-[var(--neg)]" aria-label={`Remove ${f.file.name} from ${group.formLabel}`}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
