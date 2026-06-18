"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Paperclip, Pencil, ScrollText, Send, Trash2, Upload, XCircle } from "lucide-react";

import * as poService from "@/services/purchase-order.service";
import * as auditService from "@/services/audit.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionLabel, actionTone, relativeTime, TONE_CLASSES } from "@/components/dashboard/audit/auditDisplay";
import { PO_PRIORITY_LABELS, PoStatusBadge, formatDate, formatMoney } from "./poStatus";
import type { AuditEntry } from "@/types/audit";
import type { PurchaseOrder } from "@/types/purchase-order";

const EXT_TYPE: Record<string, string> = { pdf: "pdf", docx: "docx", png: "png", jpg: "jpg", jpeg: "jpg" };

type Tab = "overview" | "attachments" | "audit";

export function PurchaseOrderDetail({ initial }: { initial: PurchaseOrder }) {
  const router = useRouter();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [po, setPo] = React.useState<PurchaseOrder>(initial);
  const [tab, setTab] = React.useState<Tab>("overview");
  const [busy, setBusy] = React.useState(false);
  const [reasonFor, setReasonFor] = React.useState<"reject" | "cancel" | null>(null);
  const [reason, setReason] = React.useState("");

  const run = async (fn: () => Promise<PurchaseOrder>, ok: string) => {
    setBusy(true);
    try {
      setPo(await fn());
      pushToast(ok, "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Action failed.", "alert");
    } finally {
      setBusy(false);
    }
  };

  const confirmReason = async () => {
    if (reasonFor === "reject" && !reason.trim()) {
      pushToast("A reason is required to reject.", "alert");
      return;
    }
    const which = reasonFor;
    setReasonFor(null);
    const r = reason.trim();
    setReason("");
    if (which === "reject") await run(() => poService.rejectPurchaseOrder(po.id, r), "Sent back to draft.");
    else if (which === "cancel") await run(() => poService.cancelPurchaseOrder(po.id, r || undefined), "Purchase order cancelled.");
  };

  // Workflow buttons available for the current status × permissions.
  const s = po.status;
  const actions: React.ReactNode[] = [];
  if (s === "draft" && can("purchase_orders.edit"))
    actions.push(<ActionBtn key="edit" icon={Pencil} onClick={() => router.push(`/dashboard/purchase-orders/${po.code}/edit`)} disabled={busy}>Edit</ActionBtn>);
  if (s === "draft" && can("purchase_orders.submit"))
    actions.push(<ActionBtn key="submit" icon={Send} primary onClick={() => run(() => poService.submitPurchaseOrder(po.id), "Submitted for approval.")} disabled={busy}>Submit</ActionBtn>);
  if (s === "pending_approval" && can("purchase_orders.approve")) {
    actions.push(<ActionBtn key="approve" icon={CheckCircle2} primary onClick={() => run(() => poService.approvePurchaseOrder(po.id), "Approved.")} disabled={busy}>Approve</ActionBtn>);
    actions.push(<ActionBtn key="reject" icon={XCircle} onClick={() => { setReason(""); setReasonFor("reject"); }} disabled={busy}>Reject</ActionBtn>);
  }
  if (s === "approved" && can("purchase_orders.send"))
    actions.push(<ActionBtn key="send" icon={Send} primary onClick={() => run(() => poService.sendPurchaseOrder(po.id), "Issued to the supplier.")} disabled={busy}>Send to supplier</ActionBtn>);
  if ((s === "partially_received" || s === "fully_received") && can("purchase_orders.close"))
    actions.push(<ActionBtn key="close" icon={CheckCircle2} primary onClick={() => run(() => poService.closePurchaseOrder(po.id), "Purchase order closed.")} disabled={busy}>Close</ActionBtn>);
  if (["draft", "pending_approval", "approved", "sent"].includes(s) && can("purchase_orders.cancel"))
    actions.push(<ActionBtn key="cancel" icon={XCircle} onClick={() => { setReason(""); setReasonFor("cancel"); }} disabled={busy}>Cancel</ActionBtn>);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:flex-row sm:items-start sm:justify-between" style={{ borderRadius: "var(--radius)" }}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">{po.code}</h1>
            <PoStatusBadge status={po.status} />
            {busy && <Loader2 className="h-4 w-4 animate-spin text-[var(--muted)]" />}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span>{po.supplierName ?? po.supplier?.name ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>{po.warehouse?.name ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>{PO_PRIORITY_LABELS[po.priority]} priority</span>
          </p>
        </div>
        {actions.length > 0 && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {(["overview", "attachments", "audit"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`shrink-0 border-b-2 px-3.5 py-2.5 text-xs font-bold capitalize transition-colors ${tab === t ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)] hover:text-[var(--ink)]"}`}>
            {t === "audit" ? "Audit trail" : t}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview po={po} />}
      {tab === "attachments" && <Attachments po={po} setPo={setPo} canEdit={can("purchase_orders.edit")} />}
      {tab === "audit" && <AuditTrail poId={po.id} />}

      {reasonFor && (
        <ReasonDialog
          title={reasonFor === "reject" ? "Reject purchase order" : "Cancel purchase order"}
          required={reasonFor === "reject"}
          value={reason}
          onChange={setReason}
          onConfirm={confirmReason}
          onClose={() => { setReasonFor(null); setReason(""); }}
        />
      )}
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

function Overview({ po }: { po: PurchaseOrder }) {
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">Unit Price</th>
                <th className="px-4 py-3">VAT</th>
                <th className="px-4 py-3">Line Total</th>
              </tr>
            </thead>
            <tbody>
              {po.items.map((i) => (
                <tr key={i.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-[var(--ink)]">{i.itemName}</div>
                    {i.sku && <div className="text-[11px] text-[var(--faint)]">{i.sku}</div>}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">{i.quantity}{i.baseUnit ? ` ${i.baseUnit}` : ""}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{formatMoney(i.unitPrice, po.currency)}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{i.vatRate}%</td>
                  <td className="px-4 py-3 font-semibold text-[var(--ink)]">{formatMoney(i.lineTotal, po.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end border-t border-[var(--border)] p-4">
          <div className="w-56 space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-[var(--muted)]">Subtotal</span><span className="font-semibold text-[var(--ink)]">{formatMoney(po.subtotal, po.currency)}</span></div>
            <div className="flex justify-between"><span className="text-[var(--muted)]">VAT</span><span className="font-semibold text-[var(--ink)]">{formatMoney(po.vatTotal, po.currency)}</span></div>
            <div className="flex justify-between border-t border-[var(--border-2)] pt-1.5"><span className="font-bold text-[var(--ink)]">Grand total</span><span className="font-extrabold text-[var(--ink)]">{formatMoney(po.grandTotal, po.currency)}</span></div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Supplier">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Supplier">{po.supplier?.name ?? po.supplierName}</Field>
            <Field label="Payment terms">{po.supplier?.paymentTerms}</Field>
            <Field label="Contact">{po.supplier?.contactPerson}</Field>
            <Field label="Lead time">{po.supplier?.leadTimeDays != null ? `${po.supplier.leadTimeDays} days` : ""}</Field>
            <Field label="Email">{po.supplier?.contactEmail}</Field>
            <Field label="Phone">{po.supplier?.contactPhone}</Field>
          </div>
        </Card>
        <Card title="Order">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Order date">{formatDate(po.orderDate)}</Field>
            <Field label="Expected delivery">{formatDate(po.expectedDeliveryDate)}</Field>
            <Field label="Reference">{po.referenceNumber}</Field>
            <Field label="Priority">{PO_PRIORITY_LABELS[po.priority]}</Field>
            {po.description && <div className="col-span-2"><Field label="Description">{po.description}</Field></div>}
          </div>
        </Card>
        <Card title="Delivery">
          <div className="space-y-3">
            <Field label="Warehouse">{po.warehouse?.name}</Field>
            <Field label="Address">{po.deliveryAddress || po.warehouse?.address}</Field>
            <Field label="Instructions">{po.deliveryInstructions}</Field>
          </div>
        </Card>
        <Card title="Approval">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Created by">{po.createdBy}</Field>
            <Field label="Submitted by">{po.submittedBy}</Field>
            <Field label="Approved by">{po.approvedBy}</Field>
            <Field label="Approved">{formatDate(po.approvedAt)}</Field>
            <Field label="Sent">{formatDate(po.sentAt)}</Field>
            <Field label="Closed / cancelled">{formatDate(po.closedAt ?? po.cancelledAt)}</Field>
            {po.rejectionReason && <div className="col-span-2"><Field label="Last rejection">{po.rejectionReason}</Field></div>}
            {po.cancelReason && <div className="col-span-2"><Field label="Cancel reason">{po.cancelReason}</Field></div>}
          </div>
        </Card>
        {(po.internalNotes || po.supplierNotes) && (
          <Card title="Notes">
            <div className="space-y-3">
              {po.internalNotes && <Field label="Internal notes">{po.internalNotes}</Field>}
              {po.supplierNotes && <Field label="Supplier notes">{po.supplierNotes}</Field>}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function Attachments({ po, setPo, canEdit }: { po: PurchaseOrder; setPo: (p: PurchaseOrder) => void; canEdit: boolean }) {
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
        const updated = await poService.addAttachment(po.id, { fileName: file.name, fileType, fileSizeBytes: file.size, data: reader.result as string });
        setPo(updated);
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
      setPo(await poService.removeAttachment(po.id, confirm.id));
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
          <p className="mt-1.5 text-[11px] text-[var(--faint)]">Supplier quote, invoice or supporting document — PDF, DOCX, PNG or JPG (max 10 MB).</p>
        </div>
      )}
      {po.attachments.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <Paperclip className="h-7 w-7 text-[var(--faint)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">No attachments yet</p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border-2)]">
          {po.attachments.map((a) => (
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
      <ConfirmDialog open={confirm.open} danger busy={deleting} title="Remove attachment" message="Remove this attachment from the order?" confirmLabel="Remove" onConfirm={onDelete} onClose={() => { if (!deleting) setConfirm({ open: false, id: null }); }} />
    </div>
  );
}

function ReasonDialog({ title, required, value, onChange, onConfirm, onClose }: { title: string; required: boolean; value: string; onChange: (v: string) => void; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold text-[var(--ink)]">{title}</h3>
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

function AuditTrail({ poId }: { poId: string }) {
  const [entries, setEntries] = React.useState<AuditEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let active = true;
    auditService
      .listAuditLogs({ targetType: "purchase_order", targetId: poId, pageSize: 100 })
      .then((res) => active && setEntries(res.entries))
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load the audit trail."));
    return () => { active = false; };
  }, [poId]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (entries === null) return <div className="flex items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-16"><Loader2 className="h-6 w-6 animate-spin text-[var(--muted)]" /></div>;
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
        {entries.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className={`inline-block shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${TONE_CLASSES[actionTone(e.action)]}`}>{actionLabel(e.action)}</span>
              <span className="text-xs text-[var(--muted)]">{e.actorEmail ?? "system"}</span>
            </div>
            <span className="shrink-0 text-[11px] text-[var(--faint)]" title={new Date(e.createdAt).toLocaleString("en-GB")}>{relativeTime(e.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
