"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, Paperclip, Pencil, ScrollText, Trash2, Upload, XCircle } from "lucide-react";

import * as grnService from "@/services/goods-in.service";
import * as auditService from "@/services/audit.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionLabel, actionTone, relativeTime, TONE_CLASSES } from "@/components/dashboard/audit/auditDisplay";
import { GRN_QUALITY_LABELS, GrnStatusBadge, formatDate } from "./grnStatus";
import type { AuditEntry } from "@/types/audit";
import type { GoodsReceipt } from "@/types/goods-in";

const EXT_TYPE: Record<string, string> = { pdf: "pdf", docx: "docx", png: "png", jpg: "jpg", jpeg: "jpg" };
type Tab = "overview" | "attachments" | "audit";

export function GoodsReceiptDetail({ initial }: { initial: GoodsReceipt }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [grn, setGrn] = React.useState<GoodsReceipt>(initial);
  const TABS: Tab[] = ["overview", "attachments", "audit"];
  const requestedTab = searchParams.get("tab");
  const tab: Tab = TABS.includes(requestedTab as Tab) ? (requestedTab as Tab) : "overview";
  const setTab = (t: Tab) => router.replace(`/dashboard/goods-in/${grn.code}?tab=${t}`, { scroll: false });
  const [busy, setBusy] = React.useState(false);
  const [confirmComplete, setConfirmComplete] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");

  const run = async (fn: () => Promise<GoodsReceipt>, ok: string) => {
    setBusy(true);
    try {
      setGrn(await fn());
      pushToast(ok, "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Action failed.", "alert");
    } finally {
      setBusy(false);
    }
  };

  const s = grn.status;
  const actions: React.ReactNode[] = [];
  if (s === "draft" && can("goods_in.edit"))
    actions.push(<ActionBtn key="edit" icon={Pencil} onClick={() => router.push(`/dashboard/goods-in/${grn.code}/edit`)} disabled={busy}>Edit</ActionBtn>);
  if (s === "draft" && can("goods_in.complete"))
    actions.push(<ActionBtn key="complete" icon={CheckCircle2} primary onClick={() => setConfirmComplete(true)} disabled={busy}>Complete</ActionBtn>);
  if (s === "draft" && can("goods_in.cancel"))
    actions.push(<ActionBtn key="cancel" icon={XCircle} onClick={() => { setReason(""); setCancelOpen(true); }} disabled={busy}>Cancel</ActionBtn>);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:flex-row sm:items-start sm:justify-between" style={{ borderRadius: "var(--radius)" }}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">{grn.code}</h1>
            <GrnStatusBadge status={grn.status} />
            {busy && <Loader2 className="h-4 w-4 animate-spin text-[var(--muted)]" />}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span className="font-mono">{grn.poCode ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>{grn.supplierName ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>{grn.warehouse?.name ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>Received {formatDate(grn.receivedDate)}</span>
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

      {tab === "overview" && <Overview grn={grn} />}
      {tab === "attachments" && <Attachments grn={grn} setGrn={setGrn} canEdit={can("goods_in.edit")} />}
      {tab === "audit" && <AuditTrail grnId={grn.id} />}

      <ConfirmDialog
        open={confirmComplete}
        title="Complete this goods receipt?"
        message={<>This posts <strong className="text-[var(--ink)]">{grn.totalAccepted}</strong> accepted unit(s) into <strong className="text-[var(--ink)]">{grn.warehouse?.name ?? "the warehouse"}</strong> and updates the purchase order. This can&apos;t be undone.</>}
        confirmLabel="Complete"
        busy={busy}
        onConfirm={() => { setConfirmComplete(false); run(() => grnService.completeGoodsReceipt(grn.id), "Goods receipt completed — stock updated."); }}
        onClose={() => setConfirmComplete(false)}
      />
      {cancelOpen && (
        <ReasonDialog
          value={reason}
          onChange={setReason}
          onClose={() => { setCancelOpen(false); setReason(""); }}
          onConfirm={() => { const r = reason.trim(); setCancelOpen(false); setReason(""); run(() => grnService.cancelGoodsReceipt(grn.id, r || undefined), "Goods receipt cancelled."); }}
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

function Overview({ grn }: { grn: GoodsReceipt }) {
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-4 py-3">Item</th><th className="px-4 py-3">Ordered</th><th className="px-4 py-3">Prev.</th>
                <th className="px-4 py-3">Received</th><th className="px-4 py-3">Damaged</th><th className="px-4 py-3">Accepted</th>
              </tr>
            </thead>
            <tbody>
              {grn.items.map((i) => (
                <tr key={i.id} className="border-b border-[var(--border)] align-top last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-[var(--ink)]">{i.itemName}</div>
                    {i.sku && <div className="text-[11px] text-[var(--faint)]">{i.sku}</div>}
                    {i.serials.length > 0 && <div className="mt-1 text-[11px] text-[var(--muted)]">Serials: {i.serials.map((s) => s.serialNumber).join(", ")}</div>}
                    {i.batches.length > 0 && <div className="mt-1 text-[11px] text-[var(--muted)]">Batches: {i.batches.map((b) => `${b.batchNumber} (${b.quantity}${b.expiryDate ? `, exp ${formatDate(b.expiryDate)}` : ""})`).join("; ")}</div>}
                    {i.notes && <div className="mt-1 text-[11px] italic text-[var(--faint)]">{i.notes}</div>}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">{i.orderedQuantity}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{i.previouslyReceived}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{i.receivedQuantity}{i.baseUnit ? ` ${i.baseUnit}` : ""}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{i.damagedQuantity}</td>
                  <td className="px-4 py-3 font-semibold text-[var(--ink)]">{i.acceptedQuantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap justify-end gap-x-8 gap-y-1 border-t border-[var(--border)] p-4 text-sm">
          <span className="text-[var(--muted)]">Received <strong className="text-[var(--ink)]">{grn.totalReceived}</strong></span>
          <span className="text-[var(--muted)]">Damaged <strong className="text-[var(--ink)]">{grn.totalDamaged}</strong></span>
          <span className="text-[var(--muted)]">Accepted into stock <strong className="text-[var(--ink)]">{grn.totalAccepted}</strong></span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Delivery">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Purchase order">{grn.poCode}</Field>
            <Field label="Warehouse">{grn.warehouse?.name}</Field>
            <Field label="Received date">{formatDate(grn.receivedDate)}</Field>
            <Field label="Delivery note">{grn.deliveryNoteNumber}</Field>
            <Field label="Carrier">{grn.carrier}</Field>
            <Field label="Vehicle">{grn.vehicleRegistration}</Field>
            <Field label="Reference">{grn.referenceNumber}</Field>
            {grn.description && <div className="col-span-2"><Field label="Description">{grn.description}</Field></div>}
          </div>
        </Card>
        <Card title="Supplier">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Supplier">{grn.supplier?.name ?? grn.supplierName}</Field>
            <Field label="Contact">{grn.supplier?.contactPerson}</Field>
            <Field label="Email">{grn.supplier?.contactEmail}</Field>
            <Field label="Phone">{grn.supplier?.contactPhone}</Field>
          </div>
        </Card>
        <Card title="Quality & inventory">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quality status">{GRN_QUALITY_LABELS[grn.qualityStatus]}</Field>
            <Field label="Stock impact">{grn.status === "completed" ? `${grn.totalAccepted} unit(s) added` : grn.status === "cancelled" ? "None (cancelled)" : `${grn.totalAccepted} unit(s) on completion`}</Field>
            {grn.qualityNotes && <div className="col-span-2"><Field label="Quality notes">{grn.qualityNotes}</Field></div>}
            {grn.internalNotes && <div className="col-span-2"><Field label="Internal notes">{grn.internalNotes}</Field></div>}
          </div>
        </Card>
        <Card title="Record">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Created by">{grn.createdBy}</Field>
            <Field label="Completed by">{grn.completedBy}</Field>
            <Field label="Completed">{formatDate(grn.completedAt)}</Field>
            <Field label="Cancelled by">{grn.cancelledBy}</Field>
            {grn.cancelReason && <div className="col-span-2"><Field label="Cancel reason">{grn.cancelReason}</Field></div>}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Attachments({ grn, setGrn, canEdit }: { grn: GoodsReceipt; setGrn: (g: GoodsReceipt) => void; canEdit: boolean }) {
  const { pushToast } = useDashboard();
  const [uploading, setUploading] = React.useState(false);
  const [confirm, setConfirm] = React.useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const [deleting, setDeleting] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const onFile = (file: File) => {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const fileType = EXT_TYPE[ext];
    if (!fileType) { pushToast("Unsupported file. Use PDF, DOCX, PNG or JPG.", "alert"); return; }
    if (file.size > 10 * 1024 * 1024) { pushToast("File must be 10 MB or smaller.", "alert"); return; }
    setUploading(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        setGrn(await grnService.addAttachment(grn.id, { fileName: file.name, fileType, fileSizeBytes: file.size, data: reader.result as string }));
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
      setGrn(await grnService.removeAttachment(grn.id, confirm.id));
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
          <p className="mt-1.5 text-[11px] text-[var(--faint)]">Delivery note, packing slip, invoice or photo — PDF, DOCX, PNG or JPG (max 10 MB).</p>
        </div>
      )}
      {grn.attachments.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <Paperclip className="h-7 w-7 text-[var(--faint)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">No attachments yet</p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border-2)]">
          {grn.attachments.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-3">
              <a href={a.url} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-2.5">
                <Paperclip className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold text-[var(--accent)] hover:underline">{a.fileName}</span>
                  <span className="text-[11px] text-[var(--faint)]">{a.fileType.toUpperCase()} · {(a.fileSizeBytes / 1024).toFixed(0)} KB</span>
                </span>
              </a>
              {canEdit && (
                <button type="button" onClick={() => setConfirm({ open: true, id: a.id })} className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)]" aria-label="Remove attachment"><Trash2 className="h-3.5 w-3.5" /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={confirm.open} danger busy={deleting} title="Remove attachment" message="Remove this attachment from the receipt?" confirmLabel="Remove" onConfirm={onDelete} onClose={() => { if (!deleting) setConfirm({ open: false, id: null }); }} />
    </div>
  );
}

function ReasonDialog({ value, onChange, onConfirm, onClose }: { value: string; onChange: (v: string) => void; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold text-[var(--ink)]">Cancel goods receipt</h3>
        <textarea autoFocus value={value} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={500} placeholder="Reason (optional)" className="mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]" />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)]">Keep</button>
          <button type="button" onClick={onConfirm} className="rounded-xl bg-[var(--neg)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90">Cancel receipt</button>
        </div>
      </div>
    </div>
  );
}

function AuditTrail({ grnId }: { grnId: string }) {
  const [entries, setEntries] = React.useState<AuditEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let active = true;
    auditService
      .listAuditLogs({ targetType: "goods_receipt", targetId: grnId, pageSize: 100 })
      .then((res) => active && setEntries(res.entries))
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load the audit trail."));
    return () => { active = false; };
  }, [grnId]);

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
