"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Pencil, ScrollText, Send, XCircle } from "lucide-react";

import * as goodsOutService from "@/services/goods-out.service";
import * as auditService from "@/services/audit.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionLabel, actionTone, relativeTime, TONE_CLASSES } from "@/components/dashboard/audit/auditDisplay";
import { AuditTrailSkeleton } from "@/components/dashboard/audit/AuditTrailSkeleton";
import { DISPATCH_REASON_LABELS, GoodsOutStatusBadge, formatDate } from "./goodsOutStatus";
import type { AuditEntry } from "@/types/audit";
import type { GoodsOut } from "@/types/goods-out";

type Tab = "overview" | "audit";

export function GoodsOutDetail({ initial }: { initial: GoodsOut }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [gdn, setGdn] = React.useState<GoodsOut>(initial);
  const TABS: Tab[] = ["overview", "audit"];
  const requestedTab = searchParams.get("tab");
  const tab: Tab = TABS.includes(requestedTab as Tab) ? (requestedTab as Tab) : "overview";
  const setTab = (t: Tab) => router.replace(`/dashboard/goods-out/${gdn.code}?tab=${t}`, { scroll: false });
  const [busy, setBusy] = React.useState(false);
  const [confirmDispatch, setConfirmDispatch] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");

  const run = async (fn: () => Promise<GoodsOut>, ok: string) => {
    setBusy(true);
    try {
      setGdn(await fn());
      pushToast(ok, "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Action failed.", "alert");
    } finally {
      setBusy(false);
    }
  };

  const s = gdn.status;
  const actions: React.ReactNode[] = [];
  if (s === "draft" && can("goods_out.edit"))
    actions.push(<ActionBtn key="edit" icon={Pencil} onClick={() => router.push(`/dashboard/goods-out/${gdn.code}/edit`)} disabled={busy}>Edit</ActionBtn>);
  if (s === "draft" && can("goods_out.dispatch"))
    actions.push(<ActionBtn key="dispatch" icon={Send} primary onClick={() => setConfirmDispatch(true)} disabled={busy}>Dispatch</ActionBtn>);
  if (s === "draft" && can("goods_out.cancel"))
    actions.push(<ActionBtn key="cancel" icon={XCircle} onClick={() => { setReason(""); setCancelOpen(true); }} disabled={busy}>Cancel</ActionBtn>);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:flex-row sm:items-start sm:justify-between" style={{ borderRadius: "var(--radius)" }}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">{gdn.code}</h1>
            <GoodsOutStatusBadge status={gdn.status} />
            {busy && <Loader2 className="h-4 w-4 animate-spin text-[var(--muted)]" />}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span>{gdn.warehouseName}</span>
            <span aria-hidden>→</span>
            <span className="font-semibold text-[var(--ink)]">{gdn.engineerName}</span>
            {gdn.engineerEmployeeId && <span className="font-mono">{gdn.engineerEmployeeId}</span>}
            <span aria-hidden>·</span>
            <span>Dispatch {formatDate(gdn.dispatchDate)}</span>
          </p>
        </div>
        {actions.length > 0 && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {(["overview", "audit"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`shrink-0 border-b-2 px-3.5 py-2.5 text-xs font-bold capitalize transition-colors ${tab === t ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)] hover:text-[var(--ink)]"}`}>
            {t === "audit" ? "Audit trail" : t}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview gdn={gdn} />}
      {tab === "audit" && <AuditTrail gdnId={gdn.id} />}

      <ConfirmDialog
        open={confirmDispatch}
        title="Dispatch this stock?"
        message={<>This posts <strong className="text-[var(--ink)]">{gdn.totalQuantity}</strong> unit(s) from <strong className="text-[var(--ink)]">{gdn.warehouseName}</strong> into <strong className="text-[var(--ink)]">{gdn.engineerName}</strong>&apos;s holding. This can&apos;t be undone.</>}
        confirmLabel="Dispatch"
        busy={busy}
        onConfirm={() => { setConfirmDispatch(false); run(() => goodsOutService.dispatchGoodsOut(gdn.id), "Dispatched — warehouse stock updated."); }}
        onClose={() => setConfirmDispatch(false)}
      />
      {cancelOpen && (
        <ReasonDialog
          value={reason}
          onChange={setReason}
          onClose={() => { setCancelOpen(false); setReason(""); }}
          onConfirm={() => { const r = reason.trim(); setCancelOpen(false); setReason(""); run(() => goodsOutService.cancelGoodsOut(gdn.id, r || undefined), "Dispatch cancelled."); }}
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

function Overview({ gdn }: { gdn: GoodsOut }) {
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-4 py-3">Item</th><th className="px-4 py-3 text-right">Quantity</th><th className="px-4 py-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {gdn.items.map((i) => (
                <tr key={i.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-[var(--ink)]">{i.itemName}</div>
                    {i.sku && <div className="text-[11px] text-[var(--faint)]">{i.sku}</div>}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-[var(--ink)]">{i.quantity}{i.baseUnit ? ` ${i.baseUnit}` : ""}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{i.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap justify-end gap-x-8 gap-y-1 border-t border-[var(--border)] p-4 text-sm">
          <span className="text-[var(--muted)]">Total dispatched <strong className="text-[var(--ink)]">{gdn.totalQuantity}</strong></span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Dispatch">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Source warehouse">{gdn.warehouseName}{gdn.warehouseCode ? ` (${gdn.warehouseCode})` : ""}</Field>
            <Field label="Reason">{DISPATCH_REASON_LABELS[gdn.dispatchReason]}</Field>
            <Field label="Dispatch date">{formatDate(gdn.dispatchDate)}</Field>
            <Field label="Expected return">{formatDate(gdn.expectedReturnDate)}</Field>
            <Field label="Authorised by">{gdn.authorizedByName}</Field>
            <Field label="Reference">{gdn.referenceNumber}</Field>
            {gdn.description && <div className="col-span-2"><Field label="Description">{gdn.description}</Field></div>}
          </div>
        </Card>
        <Card title="Engineer">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">{gdn.engineerName}</Field>
            <Field label="Employee ID">{gdn.engineerEmployeeId}</Field>
            <Field label="Email">{gdn.engineerEmail}</Field>
            <Field label="Stock impact">{gdn.status === "dispatched" ? `${gdn.totalQuantity} unit(s) added to holding` : gdn.status === "cancelled" ? "None (cancelled)" : `${gdn.totalQuantity} unit(s) on dispatch`}</Field>
          </div>
        </Card>
        <Card title="Record">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Created by">{gdn.createdBy}</Field>
            <Field label="Dispatched by">{gdn.dispatchedBy}</Field>
            <Field label="Dispatched">{formatDate(gdn.dispatchedAt)}</Field>
            <Field label="Cancelled by">{gdn.cancelledBy}</Field>
            {gdn.cancelReason && <div className="col-span-2"><Field label="Cancel reason">{gdn.cancelReason}</Field></div>}
            {gdn.internalNotes && <div className="col-span-2"><Field label="Internal notes">{gdn.internalNotes}</Field></div>}
          </div>
        </Card>
      </div>
    </div>
  );
}

function ReasonDialog({ value, onChange, onConfirm, onClose }: { value: string; onChange: (v: string) => void; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold text-[var(--ink)]">Cancel dispatch</h3>
        <textarea autoFocus value={value} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={500} placeholder="Reason (optional)" className="mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]" />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)]">Keep</button>
          <button type="button" onClick={onConfirm} className="rounded-xl bg-[var(--neg)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90">Cancel dispatch</button>
        </div>
      </div>
    </div>
  );
}

function AuditTrail({ gdnId }: { gdnId: string }) {
  const [entries, setEntries] = React.useState<AuditEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let active = true;
    auditService
      .listAuditLogs({ targetType: "goods_out", targetId: gdnId, pageSize: 100 })
      .then((res) => active && setEntries(res.entries))
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load the audit trail."));
    return () => { active = false; };
  }, [gdnId]);

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
