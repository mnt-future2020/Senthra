"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, CheckCircle2, Copy, ExternalLink, Loader2, Paperclip, Pencil, RotateCcw, ScrollText, Send, Trash2, Upload, XCircle } from "lucide-react";

import * as prfService from "@/services/purchase-request.service";
import * as auditService from "@/services/audit.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { actionLabel, actionTone, changeLabels, relativeTime, TONE_CLASSES } from "@/components/dashboard/audit/auditDisplay";
import { AuditTrailSkeleton } from "@/components/dashboard/audit/AuditTrailSkeleton";
import { PrfStatusBadge, formatDate, formatMoney } from "./prfStatus";
import type { AuditEntry } from "@/types/audit";
import type { PurchaseRequest } from "@/types/purchase-request";

const EXT_TYPE: Record<string, string> = { pdf: "pdf", docx: "docx", png: "png", jpg: "jpg", jpeg: "jpg" };

type Tab = "overview" | "attachments" | "audit";

export function PurchaseRequestDetail({ initial }: { initial: PurchaseRequest }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [prf, setPrf] = React.useState<PurchaseRequest>(initial);
  // The Audit trail tab hits GET /audit (needs audit.view) — only show it to users who hold that
  // permission, so a role without it (e.g. a plain project manager) never sees a tab that 403s.
  const TABS: Tab[] = ["overview", "attachments", ...(can("audit.view") ? (["audit"] as Tab[]) : [])];
  const requestedTab = searchParams.get("tab");
  const tab: Tab = TABS.includes(requestedTab as Tab) ? (requestedTab as Tab) : "overview";
  const setTab = (t: Tab) => router.replace(`/dashboard/purchase-requests/${prf.code}?tab=${t}`, { scroll: false });
  const [busy, setBusy] = React.useState(false);
  const [reasonFor, setReasonFor] = React.useState<"reject" | "reopen" | "cancel" | null>(null);
  const [reason, setReason] = React.useState("");
  const [confirmConvert, setConfirmConvert] = React.useState(false);
  const [confirmDuplicate, setConfirmDuplicate] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const run = async (fn: () => Promise<PurchaseRequest>, ok: string) => {
    setBusy(true);
    try {
      setPrf(await fn());
      pushToast(ok, "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Action failed.", "alert");
    } finally {
      setBusy(false);
    }
  };

  // Power-user shortcut for a user who can BOTH submit and approve: submit then immediately approve
  // in one click. The record still passes through both states server-side (draft → submitted →
  // approved), so the audit trail keeps both stamps (submitted-by + approved-by). Partial failure is
  // handled explicitly: if the submit lands but the approve is rejected, the PRF is left in the
  // `submitted` state (its numbers now frozen for review) and the user is told to approve it manually
  // — never silently swallowed.
  const submitAndApprove = async () => {
    setBusy(true);
    try {
      const submitted = await prfService.submitPurchaseRequest(prf.id);
      setPrf(submitted); // reflect `submitted` even if the approve step then fails
      try {
        setPrf(await prfService.approvePurchaseRequest(prf.id));
        pushToast("Submitted and approved.", "success");
      } catch (approveErr) {
        pushToast(
          `Submitted, but approval failed: ${approveErr instanceof Error ? approveErr.message : "please approve it manually."}`,
          "alert",
        );
      }
    } catch (submitErr) {
      pushToast(submitErr instanceof Error ? submitErr.message : "Could not submit the request.", "alert");
    } finally {
      setBusy(false);
    }
  };

  const confirmReason = async () => {
    if ((reasonFor === "reject" || reasonFor === "reopen") && !reason.trim()) {
      pushToast(`A reason is required to ${reasonFor}.`, "alert");
      return;
    }
    const which = reasonFor;
    setReasonFor(null);
    const r = reason.trim();
    setReason("");
    if (which === "reject") await run(() => prfService.rejectPurchaseRequest(prf.id, r), "Sent back to draft for rework.");
    else if (which === "reopen") await run(() => prfService.reopenPurchaseRequest(prf.id, r), "Reopened as a draft revision.");
    else if (which === "cancel") await run(() => prfService.cancelPurchaseRequest(prf.id, r || undefined), "Purchase request cancelled.");
  };

  const onConvert = async () => {
    setConfirmConvert(false);
    setBusy(true);
    try {
      const result = await prfService.convertPurchaseRequest(prf.id);
      pushToast(`Purchase order ${result.purchaseOrderCode} generated.`, "success");
      router.push(`/dashboard/purchase-orders/${result.purchaseOrderCode}`);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not generate the purchase order.", "alert");
      setBusy(false);
    }
  };

  const onDuplicate = async () => {
    setConfirmDuplicate(false);
    setBusy(true);
    try {
      const copy = await prfService.duplicatePurchaseRequest(prf.id);
      pushToast(`Revision draft ${copy.code} created.`, "success");
      router.push(`/dashboard/purchase-requests/${copy.code}`);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not duplicate the request.", "alert");
      setBusy(false);
    }
  };

  const onDelete = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await prfService.deletePurchaseRequest(prf.id);
      pushToast("Draft purchase request removed.", "success");
      router.push("/dashboard/purchase-requests");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
      setBusy(false);
    }
  };

  // Workflow buttons available for the current status × permissions. `converted` is
  // READ-ONLY forever — the only actions are viewing the linked PO and Duplicate-as-revision.
  const s = prf.status;
  const actions: React.ReactNode[] = [];
  if (s === "draft" && can("purchase_requests.edit"))
    actions.push(<ActionBtn key="edit" icon={Pencil} onClick={() => router.push(`/dashboard/purchase-requests/${prf.code}/edit`)} disabled={busy}>Edit</ActionBtn>);
  if (s === "draft" && can("purchase_requests.submit")) {
    // A user who can BOTH submit and approve gets the single one-click "Submit & Approve" (it passes
    // through both states server-side, so the audit trail keeps both stamps). A submit-only user gets
    // plain "Submit" for the normal two-person flow (they submit; finance approves).
    if (can("purchase_requests.approve"))
      actions.push(<ActionBtn key="submit-approve" icon={CheckCircle2} primary onClick={submitAndApprove} disabled={busy}>Submit &amp; Approve</ActionBtn>);
    else
      actions.push(<ActionBtn key="submit" icon={Send} primary onClick={() => run(() => prfService.submitPurchaseRequest(prf.id), "Submitted for finance approval.")} disabled={busy}>Submit</ActionBtn>);
  }
  if (s === "draft" && can("purchase_requests.delete"))
    actions.push(<ActionBtn key="delete" icon={Trash2} onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</ActionBtn>);
  if (s === "submitted" && can("purchase_requests.approve")) {
    actions.push(<ActionBtn key="approve" icon={CheckCircle2} primary onClick={() => run(() => prfService.approvePurchaseRequest(prf.id), "Finance approved.")} disabled={busy}>Approve</ActionBtn>);
    actions.push(<ActionBtn key="reject" icon={XCircle} onClick={() => { setReason(""); setReasonFor("reject"); }} disabled={busy}>Reject</ActionBtn>);
  }
  if (s === "approved" && can("purchase_requests.convert"))
    actions.push(<ActionBtn key="convert" icon={ArrowUpRight} primary onClick={() => setConfirmConvert(true)} disabled={busy}>Generate PO</ActionBtn>);
  if (s === "approved" && can("purchase_requests.approve"))
    actions.push(<ActionBtn key="reopen" icon={RotateCcw} onClick={() => { setReason(""); setReasonFor("reopen"); }} disabled={busy}>Reopen for revision</ActionBtn>);
  if (s === "converted" && prf.purchaseOrder)
    actions.push(<ActionBtn key="view-po" icon={ExternalLink} primary onClick={() => router.push(`/dashboard/purchase-orders/${prf.purchaseOrder!.code}`)} disabled={busy}>View {prf.purchaseOrder.code}</ActionBtn>);
  if (s === "converted" && can("purchase_requests.create"))
    actions.push(<ActionBtn key="duplicate" icon={Copy} onClick={() => setConfirmDuplicate(true)} disabled={busy}>Duplicate as revision</ActionBtn>);
  if (["draft", "submitted", "approved"].includes(s) && can("purchase_requests.cancel"))
    actions.push(<ActionBtn key="cancel" icon={XCircle} onClick={() => { setReason(""); setReasonFor("cancel"); }} disabled={busy}>Cancel</ActionBtn>);

  return (
    <div className="flex h-full flex-col gap-5">
      <DetailHeader
        storageKey="purchase-request-detail"
        title={prf.code}
        badges={
          <>
            <PrfStatusBadge status={prf.status} />
            {busy && <Loader2 className="h-4 w-4 animate-spin text-[var(--muted)]" />}
          </>
        }
        meta={
          <>
            <span>{prf.supplierName ?? prf.supplier?.name ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>{prf.warehouse?.name ?? "—"}</span>
            {prf.quoteReference && (
              <>
                <span aria-hidden>·</span>
                <span>Quote {prf.quoteReference}</span>
              </>
            )}
          </>
        }
        actions={actions.length > 0 ? actions : undefined}
      />

      <div className="shrink-0 flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`shrink-0 border-b-2 px-3.5 py-2.5 text-xs font-bold capitalize transition-colors ${tab === t ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)] hover:text-[var(--ink)]"}`}>
            {t === "audit" ? "Audit trail" : t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "overview" && <Overview prf={prf} />}
        {tab === "attachments" && <Attachments prf={prf} setPrf={setPrf} canEdit={can("purchase_requests.edit") && prf.status === "draft"} />}
        {tab === "audit" && <AuditTrail prfId={prf.id} />}
      </div>

      {reasonFor && (
        <ReasonDialog
          title={reasonFor === "reject" ? "Reject purchase request" : reasonFor === "reopen" ? "Reopen for revision" : "Cancel purchase request"}
          hint={reasonFor === "reopen" ? "This puts the approved request back into draft so prices can be revised. The reason is audited." : undefined}
          required={reasonFor !== "cancel"}
          value={reason}
          onChange={setReason}
          onConfirm={confirmReason}
          onClose={() => { setReasonFor(null); setReason(""); }}
        />
      )}

      <ConfirmDialog
        open={confirmConvert}
        title="Generate purchase order"
        message={<>This converts <strong className="text-[var(--ink)]">{prf.code}</strong> into a draft purchase order carrying the quoted lines. The request becomes read-only afterwards.</>}
        confirmLabel="Generate PO"
        busy={busy}
        onConfirm={onConvert}
        onClose={() => setConfirmConvert(false)}
      />

      <ConfirmDialog
        open={confirmDuplicate}
        title="Duplicate as revision"
        message={<>This creates a fresh draft request prefilled from <strong className="text-[var(--ink)]">{prf.code}</strong> so revised quotes can be captured. The original stays unchanged.</>}
        confirmLabel="Duplicate"
        busy={busy}
        onConfirm={onDuplicate}
        onClose={() => setConfirmDuplicate(false)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Remove draft request?"
        message={<>This deletes draft <strong className="text-[var(--ink)]">{prf.code}</strong>. Only drafts can be deleted.</>}
        confirmLabel="Remove"
        danger
        busy={busy}
        onConfirm={onDelete}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function ActionBtn({ icon: Icon, primary, disabled, onClick, children }: { icon: React.ElementType; primary?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition-all disabled:opacity-60 ${primary ? "bg-[var(--accent)] text-white hover:opacity-90" : "border border-[var(--border)] text-[var(--ink)] hover:bg-[var(--surface-2)]"}`}>
      <Icon className="h-3.5 w-3.5" /> {children}
    </button>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="mb-4 text-sm font-extrabold text-[var(--ink)]">{title}</h2>
      {children}
    </section>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</p>
      <div className="mt-0.5 text-sm text-[var(--ink)]">{children || "—"}</div>
    </div>
  );
}

function Overview({ prf }: { prf: PurchaseRequest }) {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">Quoted Price</th>
                <th className="px-4 py-3">VAT</th>
                <th className="px-4 py-3">Line Total</th>
              </tr>
            </thead>
            <tbody>
              {prf.items.map((i) => (
                <tr key={i.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-[var(--ink)]">{i.itemName}</div>
                    {i.sku && <div className="text-[11px] text-[var(--faint)]">{i.sku}</div>}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">{i.quantity}{i.baseUnit ? ` ${i.baseUnit}` : ""}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{formatMoney(i.unitPrice, prf.currency)}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{i.vatRate}%</td>
                  <td className="px-4 py-3 font-semibold text-[var(--ink)]">{formatMoney(i.lineTotal, prf.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end border-t border-[var(--border)] p-4">
          <div className="w-56 space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-[var(--muted)]">Subtotal</span><span className="font-semibold text-[var(--ink)]">{formatMoney(prf.subtotal, prf.currency)}</span></div>
            <div className="flex justify-between"><span className="text-[var(--muted)]">VAT</span><span className="font-semibold text-[var(--ink)]">{formatMoney(prf.vatTotal, prf.currency)}</span></div>
            <div className="flex justify-between border-t border-[var(--border-2)] pt-1.5"><span className="font-bold text-[var(--ink)]">Grand total</span><span className="font-extrabold text-[var(--ink)]">{formatMoney(prf.grandTotal, prf.currency)}</span></div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Supplier">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Supplier">{prf.supplier?.name ?? prf.supplierName}</Field>
            <Field label="Payment terms">{prf.supplier?.paymentTerms}</Field>
            <Field label="Contact">{prf.supplier?.contactPerson}</Field>
            <Field label="Lead time">{prf.supplier?.leadTimeDays != null ? `${prf.supplier.leadTimeDays} days` : ""}</Field>
            <Field label="Email">{prf.supplier?.contactEmail}</Field>
            <Field label="Phone">{prf.supplier?.contactPhone}</Field>
          </div>
        </Card>
        <Card title="Quotation">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quote reference">{prf.quoteReference}</Field>
            <Field label="Quote date">{formatDate(prf.quoteDate)}</Field>
            <Field label="Valid until">{formatDate(prf.quoteValidUntil)}</Field>
            <Field label="Currency">{prf.currency}</Field>
            <Field label="Delivery terms">{prf.deliveryTermsLabel}</Field>
            <Field label="Payment terms">{prf.paymentTerms}</Field>
            {prf.attachments.length > 0 && (
              <div className="col-span-2">
                <Field label="Attached documents">
                  <ul className="space-y-1">
                    {prf.attachments.map((a) => (
                      <li key={a.id}>
                        <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-bold text-[var(--accent)] hover:underline">
                          <Paperclip className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{a.label || a.fileName}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </Field>
              </div>
            )}
          </div>
        </Card>
        <Card title="Request">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Job">
              {prf.job ? (
                <button type="button" onClick={() => router.push(`/dashboard/jobs/${prf.job!.jobNumber}`)} className="text-left font-semibold text-[var(--accent)] hover:underline">
                  {prf.job.jobNumber} — {prf.job.name}
                </button>
              ) : (
                ""
              )}
            </Field>
            <Field label="Project reference">{prf.projectRef}</Field>
            {prf.justification && <div className="col-span-2"><Field label="Justification">{prf.justification}</Field></div>}
            {prf.notes && <div className="col-span-2"><Field label="Notes">{prf.notes}</Field></div>}
          </div>
        </Card>
        <Card title="Delivery">
          <div className="space-y-3">
            <Field label="Warehouse">{prf.warehouse?.name}</Field>
            <Field label="Address">{prf.warehouse?.address}</Field>
          </div>
        </Card>
        <Card title="Approval">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Created by">{prf.createdBy}</Field>
            <Field label="Submitted by">{prf.submittedBy}</Field>
            <Field label="Approved by">{prf.approvedBy}</Field>
            <Field label="Approved">{formatDate(prf.approvedAt)}</Field>
            <Field label="Converted">{formatDate(prf.convertedAt)}</Field>
            <Field label="Cancelled">{formatDate(prf.cancelledAt)}</Field>
            {prf.purchaseOrder && (
              <div className="col-span-2">
                <Field label="Purchase order">
                  <button type="button" onClick={() => router.push(`/dashboard/purchase-orders/${prf.purchaseOrder!.code}`)} className="font-mono text-sm font-bold text-[var(--accent)] hover:underline">
                    {prf.purchaseOrder.code}
                  </button>
                </Field>
              </div>
            )}
            {prf.rejectionReason && <div className="col-span-2"><Field label="Last rejection">{prf.rejectionReason}</Field></div>}
            {prf.reopenReason && <div className="col-span-2"><Field label="Reopen reason">{prf.reopenReason}</Field></div>}
            {prf.cancelReason && <div className="col-span-2"><Field label="Cancel reason">{prf.cancelReason}</Field></div>}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Attachments({ prf, setPrf, canEdit }: { prf: PurchaseRequest; setPrf: (p: PurchaseRequest) => void; canEdit: boolean }) {
  const { pushToast } = useDashboard();
  const [uploading, setUploading] = React.useState(false);
  const [confirm, setConfirm] = React.useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const [deleting, setDeleting] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const onFile = (file: File) => {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const fileType = EXT_TYPE[ext];
    if (!fileType) {
      pushToast("Unsupported file. Use PDF, DOCX, PNG or JPG.", "alert");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      pushToast("File must be 10 MB or smaller.", "alert");
      return;
    }
    setUploading(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const updated = await prfService.addAttachment(prf.id, { fileName: file.name, fileType, fileSizeBytes: file.size, data: reader.result as string });
        setPrf(updated);
        pushToast("Attachment added.", "success");
      } catch (e) {
        pushToast(e instanceof Error ? e.message : "Upload failed.", "alert");
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    };
    reader.onerror = () => { setUploading(false); pushToast("Could not read the file.", "alert"); };
    reader.readAsDataURL(file);
  };

  const onDelete = async () => {
    if (!confirm.id || deleting) return;
    setDeleting(true);
    try {
      setPrf(await prfService.removeAttachment(prf.id, confirm.id));
      pushToast("Attachment removed.", "success");
      setConfirm({ open: false, id: null });
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      {canEdit && (
        <div className="mb-4">
          <input ref={inputRef} type="file" accept=".pdf,.docx,.png,.jpg,.jpeg" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading} className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload file
          </button>
          <p className="mt-1.5 text-[11px] text-[var(--faint)]">The supplier quotation or supporting document — PDF, DOCX, PNG or JPG (max 10 MB). Attachments are locked once the request leaves draft.</p>
        </div>
      )}
      {prf.attachments.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <Paperclip className="h-7 w-7 text-[var(--faint)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">No attachments yet</p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border-2)]">
          {prf.attachments.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-3">
              <a href={a.url} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-2.5">
                <Paperclip className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold text-[var(--accent)] hover:underline">{a.fileName}</span>
                  <span className="text-[11px] text-[var(--faint)]">{a.fileType.toUpperCase()} · {(a.fileSizeBytes / 1024).toFixed(0)} KB</span>
                </span>
              </a>
              {canEdit && (
                <button type="button" onClick={() => setConfirm({ open: true, id: a.id })} className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)]" title="Remove" aria-label="Remove attachment">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={confirm.open} danger busy={deleting} title="Remove attachment" message="Remove this attachment from the request?" confirmLabel="Remove" onConfirm={onDelete} onClose={() => { if (!deleting) setConfirm({ open: false, id: null }); }} />
    </div>
  );
}

function ReasonDialog({ title, hint, required, value, onChange, onConfirm, onClose }: { title: string; hint?: string; required: boolean; value: string; onChange: (v: string) => void; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold text-[var(--ink)]">{title}</h3>
        {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
        <textarea
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder={required ? "Reason (required)" : "Reason (optional)"}
          className="mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)]">Cancel</button>
          <button type="button" onClick={onConfirm} className="rounded-xl bg-[var(--accent)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90">Confirm</button>
        </div>
      </div>
    </div>
  );
}

function AuditTrail({ prfId }: { prfId: string }) {
  const [entries, setEntries] = React.useState<AuditEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let active = true;
    auditService
      .listAuditLogs({ targetType: "purchase_request", targetId: prfId, pageSize: 100 })
      .then((res) => active && setEntries(res.entries))
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load the audit trail."));
    return () => { active = false; };
  }, [prfId]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (entries === null) return <AuditTrailSkeleton />;
  if (entries.length === 0)
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <ScrollText className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">No activity yet</p>
      </div>
    );
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <ul className="divide-y divide-[var(--border)]">
        {entries.map((e) => {
          const changes = changeLabels(e.metadata);
          return (
            <li key={e.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className={`inline-block shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${TONE_CLASSES[actionTone(e.action)]}`}>{actionLabel(e.action)}</span>
                  <span className="text-xs text-[var(--muted)]">{e.actorEmail ?? "system"}</span>
                </div>
                <span className="shrink-0 text-[11px] text-[var(--faint)]" title={new Date(e.createdAt).toLocaleString("en-GB")}>{relativeTime(e.createdAt)}</span>
              </div>
              {changes.length > 0 && (
                <ul className="mt-2 space-y-1 border-l-2 border-[var(--border)] pl-3">
                  {changes.map((c, i) => (
                    <li key={i} className="text-xs text-[var(--muted)]">{c}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
