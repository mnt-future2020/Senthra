"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, CheckCircle2, ChevronRight, ClipboardCheck, Download, FileText, Loader2, Package, Paperclip, Pencil, ScrollText, Send, Trash2, Upload, UserRound, XCircle } from "lucide-react";

import * as poService from "@/services/purchase-order.service";
import * as auditService from "@/services/audit.service";
import * as grnService from "@/services/goods-in.service";
import { isPermissionError, isStaleStateError } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { usePurchaseOrderSocket } from "@/hooks/usePurchaseOrderSocket";
import { useDashboard } from "@/hooks/useDashboard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { Select } from "@/components/ui/Select";
import { inputCls, labelCls } from "@/components/ui/styles";
import { actionLabel, actionTone, changeLabels, relativeTime, TONE_CLASSES } from "@/components/dashboard/audit/auditDisplay";
import { AuditTrailSkeleton } from "@/components/dashboard/audit/AuditTrailSkeleton";
import { GrnStatusBadge, formatDate as grnDate } from "@/components/dashboard/goods-in/grnStatus";
import { ACCEPTANCE_RECORDABLE_STATUSES, PO_PRIORITY_LABELS, PoStatusBadge, RECEIVABLE_STATUSES, formatDate, formatMoney } from "./poStatus";
import { Pagination } from "@/components/ui/Pagination";
import type { AuditEntry } from "@/types/audit";
import type { GoodsReceipt } from "@/types/goods-in";
import type { PurchaseOrder } from "@/types/purchase-order";
import { uploadDirect } from "@/lib/upload";

const EXT_TYPE: Record<string, string> = { pdf: "pdf", docx: "docx", png: "png", jpg: "jpg", jpeg: "jpg" };

type Tab = "overview" | "receipts" | "attachments" | "audit";

export function PurchaseOrderDetail({ initial }: { initial: PurchaseOrder }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [po, setPo] = React.useState<PurchaseOrder>(initial);
  // Read-only traceability: this PO's goods receipts. The GRN stays the single
  // stock-affecting document — here we only LIST it, never write stock from the PO side.
  const canViewReceipts = can("goods_in.view");
  // The Audit trail tab hits GET /audit (needs audit.view) — only show it to holders of that
  // permission, so a role without it never lands on a tab that 403s.
  const TABS: Tab[] = [
    "overview",
    ...(canViewReceipts ? (["receipts"] as Tab[]) : []),
    "attachments",
    ...(can("audit.view") ? (["audit"] as Tab[]) : []),
  ];
  const requestedTab = searchParams.get("tab");
  const tab: Tab = TABS.includes(requestedTab as Tab) ? (requestedTab as Tab) : "overview";
  const setTab = (t: Tab) => router.replace(`/dashboard/purchase-orders/${po.code}?tab=${t}`, { scroll: false });
  const [busy, setBusy] = React.useState(false);
  const [reasonFor, setReasonFor] = React.useState<"reject" | "cancel" | null>(null);
  const [reason, setReason] = React.useState("");
  const [downloading, setDownloading] = React.useState(false);
  const [confirmSend, setConfirmSend] = React.useState(false);
  const [assignPmOpen, setAssignPmOpen] = React.useState(false);
  const [acceptOpen, setAcceptOpen] = React.useState(false);
  const [deliveryDateOpen, setDeliveryDateOpen] = React.useState(false);

  // Eagerly fetch total count only so the tab label can show "Receipts (n)".
  // The Receipts sub-component manages its own paginated fetch independently.
  const [receiptsTotal, setReceiptsTotal] = React.useState(0);
  React.useEffect(() => {
    if (!canViewReceipts) return;
    let active = true;
    grnService
      .listGoodsReceipts({ purchaseOrder: po.id, pageSize: 1, page: 1 })
      .then((res) => { if (active) setReceiptsTotal(res.total); })
      .catch(() => { /* count is best-effort; tab still renders */ });
    return () => { active = false; };
  }, [canViewReceipts, po.id]);

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      await poService.downloadPurchaseOrderPdf(po.id, `${po.code}.pdf`);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not generate the PDF.", "alert");
    } finally {
      setDownloading(false);
    }
  };

  // Monotonic counter for background refetches. A slow response must NEVER overwrite a newer one:
  // without it, a socket event and a focus event racing (or two events in quick succession) can
  // land out of order and REWIND the view to an older status — the exact staleness this is meant
  // to cure. Only the latest issued fetch is allowed to commit.
  const fetchSeq = React.useRef(0);
  // Mirrors `busy` synchronously so background refreshes can be suppressed while the user's OWN
  // action is in flight. `busy` state alone is not enough: it only lands on the next render, so an
  // event arriving in the same commit would still slip through and clobber the action's fresher
  // result with the pre-action row.
  const busyRef = React.useRef(false);

  // Pull the current server state into the view. Used to self-heal a stale screen — this page
  // fetches once on mount, so anything another user does in the meantime (a PM sending the order
  // from their own session) would otherwise leave this tab showing an outdated status with
  // actionable buttons. Best-effort: a failed refetch leaves the existing view untouched.
  const refresh = React.useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const fresh = await poService.getPurchaseOrder(po.id);
      if (seq !== fetchSeq.current) return; // a newer refresh won — don't rewind
      setPo(fresh);
    } catch {
      /* keep showing what we have; the next action, event or refocus will try again */
    }
  }, [po.id]);

  // A background refresh that yields to the user's own in-flight action.
  const refreshIfIdle = React.useCallback(() => {
    if (busyRef.current) return;
    void refresh();
  }, [refresh]);

  // Live-refresh when anyone moves this order on — the finance approver, the assigned PM sending it
  // from their own session, or the warehouse receiving stock against it. Also fires on socket
  // RECONNECT, so events missed during a network blip are recovered.
  usePurchaseOrderSocket(refreshIfIdle);

  // Revalidate when the tab regains focus. Belt-and-braces alongside the socket: covers the window
  // where the tab was backgrounded, and any client that never established a socket.
  React.useEffect(() => {
    const onFocus = () => { if (document.visibilityState === "visible") refreshIfIdle(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshIfIdle]);

  // Flip the ref FIRST (synchronously) so a background event in the same commit already sees it.
  const setBusyBoth = (v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  };

  /**
   * Run a workflow action and fold the result back into the view.
   *
   * `alsoResyncOn403` is for the ONE action whose 403 is genuinely state-dependent: sending while
   * in `pm_review` is restricted to the assigned PM, so a re-assignment elsewhere turns a valid
   * button into a 403. Every other 403 in this app is a static warehouse/permission failure where
   * refetching is futile, which is why `isStaleStateError` excludes 403 by default.
   */
  const run = async (fn: () => Promise<PurchaseOrder>, ok: string, alsoResyncOn403 = false) => {
    setBusyBoth(true);
    try {
      // The action's own response is the freshest truth — claim the sequence so an in-flight
      // background refetch issued before it can't land afterwards and rewind the status.
      const updated = await fn();
      fetchSeq.current += 1;
      setPo(updated);
      pushToast(ok, "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Action failed.", "alert");
      // The server refused because the order is no longer in the state this screen showed (someone
      // else moved it on, or deleted it). Refetch so the badge + buttons correct themselves instead
      // of leaving a button that fails identically on every click.
      if (isStaleStateError(e) || (alsoResyncOn403 && isPermissionError(e))) await refresh();
    } finally {
      setBusyBoth(false);
    }
  };

  // Approve is special: for a PRF-born draft the server either approves it (fast path) or, if it
  // has diverged from its PRF, routes it into the review queue instead — so there's never a
  // dead-end. Message the two outcomes distinctly.
  const onApprove = async () => {
    setBusyBoth(true);
    try {
      const { purchaseOrder, divertedToReview } = await poService.approvePurchaseOrder(po.id);
      fetchSeq.current += 1; // this response is the freshest truth — see run()
      setPo(purchaseOrder);
      pushToast(
        divertedToReview
          ? "This order no longer matched its purchase request, so it's been submitted for finance review."
          : "Approved.",
        divertedToReview ? "info" : "success",
      );
      // Guide the finance user straight into the next step of the flow (approve → route to PM → PM
      // sends). Auto-open the Route-to-PM dialog ONLY on a clean approval — never when the approval
      // was diverted back into review (the PO isn't `approved` then) — and only for a user who can
      // actually assign a PM. Sending directly stays available: they can just close the dialog.
      if (!divertedToReview && purchaseOrder.status === "approved" && can("purchase_orders.assign_pm")) {
        setAssignPmOpen(true);
      }
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Action failed.", "alert");
      if (isStaleStateError(e)) await refresh();
    } finally {
      setBusyBoth(false);
    }
  };

  const confirmReason = async () => {
    // A reason is mandatory for BOTH reject and cancel (the cancellation reason is audited
    // and, on an already-issued order, referenced by the supplier cancellation email).
    if (!reason.trim()) {
      pushToast(`A reason is required to ${reasonFor}.`, "alert");
      return;
    }
    const which = reasonFor;
    setReasonFor(null);
    const r = reason.trim();
    setReason("");
    if (which === "reject") await run(() => poService.rejectPurchaseOrder(po.id, r), "Sent back to draft.");
    else if (which === "cancel") await run(() => poService.cancelPurchaseOrder(po.id, r), "Purchase order cancelled.");
  };

  // Workflow buttons available for the current status × permissions. The PDF download is always
  // available to a viewer (it's the same document emailed to the supplier).
  const s = po.status;
  const actions: React.ReactNode[] = [
    <ActionBtn key="pdf" icon={Download} onClick={downloadPdf} disabled={busy || downloading}>
      {downloading ? "Preparing…" : "Download PDF"}
    </ActionBtn>,
  ];
  // A PO locks once approved (edits are draft-only, and there's no way back to draft), so an order
  // with no expected delivery date must be stopped while Edit is still on screen — otherwise it can
  // neither be sent nor fixed. The backend enforces this on approve/submit/send; this mirrors it.
  const noDate = !po.expectedDeliveryDate;
  const noDateReason = "Set an expected delivery date first — use Edit.";
  if (s === "draft" && can("purchase_orders.edit"))
    actions.push(<ActionBtn key="edit" icon={Pencil} onClick={() => router.push(`/dashboard/purchase-orders/${po.code}/edit`)} disabled={busy}>Edit</ActionBtn>);
  // A PRF-born draft takes the FAST PATH: Finance already reviewed these numbers on the PRF, so it
  // goes draft → approved directly (no re-submission). A standalone draft uses the normal
  // draft → pending_approval → approved path via Submit. The backend enforces the same split (and
  // re-checks commercial equality on the fast path), so this only mirrors what the server allows.
  if (s === "draft" && po.purchaseRequestId && can("purchase_orders.approve"))
    actions.push(<ActionBtn key="approve-fast" icon={CheckCircle2} primary onClick={onApprove} disabled={busy || noDate} title={noDate ? noDateReason : undefined}>Approve</ActionBtn>);
  if (s === "draft" && !po.purchaseRequestId && can("purchase_orders.submit"))
    actions.push(<ActionBtn key="submit" icon={Send} primary onClick={() => run(() => poService.submitPurchaseOrder(po.id), "Submitted for approval.")} disabled={busy || noDate} title={noDate ? noDateReason : undefined}>Submit</ActionBtn>);
  if (s === "pending_approval" && can("purchase_orders.approve")) {
    actions.push(<ActionBtn key="approve" icon={CheckCircle2} primary onClick={onApprove} disabled={busy || noDate} title={noDate ? noDateReason : undefined}>Approve</ActionBtn>);
    actions.push(<ActionBtn key="reject" icon={XCircle} onClick={() => { setReason(""); setReasonFor("reject"); }} disabled={busy}>Reject</ActionBtn>);
  }
  // Route an approved PO to a Project Manager for review + send (or re-assign while in
  // pm_review). Sending stays available in BOTH states for anyone with the send permission —
  // the backend enforces the assigned-PM rule in pm_review, and a 403 surfaces as a toast.
  if ((s === "approved" || s === "pm_review") && can("purchase_orders.assign_pm"))
    actions.push(<ActionBtn key="assign-pm" icon={UserRound} onClick={() => setAssignPmOpen(true)} disabled={busy}>{s === "pm_review" ? "Re-assign PM" : "Route to PM"}</ActionBtn>);
  // The backend rejects sending a PO with no expected delivery date (it's printed on the issued
  // document and the warehouse schedules against it). Mirror that here so it's caught before the
  // round-trip. Approve/Submit gate on the same thing, so this is a backstop.
  if ((s === "approved" || s === "pm_review") && can("purchase_orders.send"))
    actions.push(
      <ActionBtn
        key="send"
        icon={Send}
        primary
        onClick={() => setConfirmSend(true)}
        disabled={busy || !po.expectedDeliveryDate}
        title={!po.expectedDeliveryDate ? "Set an expected delivery date before sending to the supplier." : undefined}
      >
        Send to supplier
      </ActionBtn>,
    );
  // Record the supplier's acknowledgement. Available on any issued, non-terminal order — goods
  // often arrive before the paperwork, and the ack reference/date must not be lost just because
  // the truck was quick. Only `sent` advances the status; later ones record the event in place.
  // Once recorded this drops out of the toolbar: corrections belong on the Supplier acceptance
  // card, and revising the DATE has its own action below (which also captures a reason).
  if (!po.supplierAcceptedAt && ACCEPTANCE_RECORDABLE_STATUSES.includes(s) && can("purchase_orders.acknowledge"))
    actions.push(<ActionBtn key="accept" icon={ClipboardCheck} onClick={() => setAcceptOpen(true)} disabled={busy}>Record supplier acceptance</ActionBtn>);
  // Revise a date the supplier already gave — gated on the FIELD, not the status, so it stays
  // available after goods start arriving (the warehouse plans against this date).
  if (po.confirmedDeliveryDate && !["closed", "cancelled"].includes(s) && can("purchase_orders.acknowledge"))
    actions.push(<ActionBtn key="delivery-date" icon={CalendarClock} onClick={() => setDeliveryDateOpen(true)} disabled={busy}>Update delivery date</ActionBtn>);
  // Receive: launch the existing Goods In form with this PO preselected. Only for
  // receivable statuses (sent / supplier_accepted / partially_received) — never draft/approved
  // (not sent yet) or fully_received/cancelled/completed (terminal). The form + backend stay
  // authoritative.
  if (RECEIVABLE_STATUSES.includes(s) && can("goods_in.create"))
    actions.push(<ActionBtn key="receive" icon={Package} primary onClick={() => router.push(`/dashboard/goods-in/new?po=${po.id}`)} disabled={busy}>Receive</ActionBtn>);
  if ((s === "partially_received" || s === "fully_received") && can("purchase_orders.close"))
    actions.push(<ActionBtn key="close" icon={CheckCircle2} primary onClick={() => run(() => poService.closePurchaseOrder(po.id), "Purchase order closed.")} disabled={busy}>Close</ActionBtn>);
  if (["draft", "pending_approval", "approved", "pm_review", "sent", "supplier_accepted"].includes(s) && can("purchase_orders.cancel"))
    actions.push(<ActionBtn key="cancel" icon={XCircle} onClick={() => { setReason(""); setReasonFor("cancel"); }} disabled={busy}>Cancel</ActionBtn>);

  return (
    <div className="stack flex h-full flex-col">
      <DetailHeader
        storageKey="purchase-order-detail"
        title={po.code}
        badges={
          <>
            <PoStatusBadge status={po.status} />
            {/* Delivery is "scheduled" once the supplier has confirmed a date. */}
            {po.confirmedDeliveryDate && !["cancelled", "closed"].includes(po.status) && (
              <span className="inline-block whitespace-nowrap rounded-full bg-teal-500/12 px-2.5 py-0.5 text-[11px] font-bold text-teal-600">
                Delivery scheduled · {formatDate(po.confirmedDeliveryDate)}
              </span>
            )}
            {busy && <Loader2 className="h-4 w-4 animate-spin text-[var(--muted)]" />}
          </>
        }
        meta={
          <>
            <span>{po.supplierName ?? po.supplier?.name ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>{po.warehouse?.name ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>{PO_PRIORITY_LABELS[po.priority]} priority</span>
          </>
        }
        actions={actions.length > 0 ? actions : undefined}
      />

      <ProcurementChain po={po} />


      <div className="shrink-0 flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`shrink-0 border-b-2 px-3.5 py-2.5 text-xs font-bold capitalize transition-colors ${tab === t ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)] hover:text-[var(--ink)]"}`}>
            {t === "audit" ? "Audit trail" : t === "receipts" ? `Receipts (${receiptsTotal})` : t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "overview" && (
          <Overview
            po={po}
            onEditAcceptance={
              !busy && !["closed", "cancelled"].includes(po.status) && can("purchase_orders.acknowledge")
                ? () => setAcceptOpen(true)
                : undefined
            }
          />
        )}
        {tab === "receipts" && <Receipts poId={po.id} />}
        {tab === "attachments" && <Attachments po={po} setPo={setPo} canEdit={can("purchase_orders.edit")} />}
        {tab === "audit" && <AuditTrail poId={po.id} />}
      </div>

      {reasonFor && (
        <ReasonDialog
          title={reasonFor === "reject" ? "Reject purchase order" : "Cancel purchase order"}
          required
          value={reason}
          onChange={setReason}
          onConfirm={confirmReason}
          onClose={() => { setReasonFor(null); setReason(""); }}
        />
      )}

      {assignPmOpen && (
        <AssignPmDialog
          po={po}
          busy={busy}
          onAssign={async (pmUserId) => {
            setAssignPmOpen(false);
            await run(() => poService.assignPmPurchaseOrder(po.id, pmUserId), po.status === "pm_review" ? "PM re-assigned." : "Routed to the PM for review.");
          }}
          onClose={() => setAssignPmOpen(false)}
        />
      )}

      {acceptOpen && (
        <SupplierAcceptanceDialog
          po={po}
          busy={busy}
          onConfirm={async (payload) => {
            setAcceptOpen(false);
            await run(() => poService.recordSupplierAcceptance(po.id, payload), "Supplier acceptance recorded.");
          }}
          onClose={() => setAcceptOpen(false)}
        />
      )}

      {deliveryDateOpen && (
        <DeliveryDateDialog
          po={po}
          busy={busy}
          onConfirm={async (confirmedDeliveryDate, deliveryReason) => {
            setDeliveryDateOpen(false);
            await run(() => poService.updateConfirmedDeliveryDate(po.id, confirmedDeliveryDate, deliveryReason), "Confirmed delivery date updated.");
          }}
          onClose={() => setDeliveryDateOpen(false)}
        />
      )}

      <ConfirmDialog
        open={confirmSend}
        title="Send to supplier"
        message={
          po.supplier?.contactEmail
            ? `This issues ${po.code} and emails it to ${po.supplier.contactEmail} with the PO document (PDF) attached.`
            : `This issues ${po.code}. No supplier email is on file, so it will be marked sent but not emailed.`
        }
        confirmLabel="Send"
        busy={busy}
        onConfirm={() => {
          setConfirmSend(false);
          run(
            () => poService.sendPurchaseOrder(po.id),
            po.supplier?.contactEmail ? `Issued — emailing ${po.supplier.contactEmail}.` : "Issued to the supplier.",
            // A 403 here is state-dependent: in pm_review only the ASSIGNED PM may send, so a
            // re-assignment made elsewhere turns this button into a 403. Resync to show who owns it.
            true,
          );
        }}
        onClose={() => setConfirmSend(false)}
      />
    </div>
  );
}

function ActionBtn({ icon: Icon, primary, disabled, title, onClick, children }: { icon: React.ElementType; primary?: boolean; disabled?: boolean; title?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition-all disabled:opacity-60 ${primary ? "bg-[var(--accent)] text-white hover:opacity-90" : "border border-[var(--border)] text-[var(--ink)] hover:bg-[var(--surface-2)]"}`}>
      <Icon className="h-3.5 w-3.5" /> {children}
    </button>
  );
}

// `action` is an optional control rendered against the title — for edits that belong WITH the data
// rather than in the page toolbar (which stays reserved for workflow actions).
function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-extrabold text-[var(--ink)]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // min-w-0 lets this grid cell shrink below its content (grid items default to min-width:auto,
    // so a long unbroken value refuses to shrink and spills into the neighbouring column);
    // wrap-break-word then lets that value actually break. Emails are the usual culprit.
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</p>
      <div className="mt-0.5 text-sm wrap-break-word text-[var(--ink)]">{children || "—"}</div>
    </div>
  );
}

// The procurement chain: Quote/PRF → PO → GRNs. A compact linked breadcrumb so the whole
// document trail is one click away from any node. Hidden when this PO stands alone (no source
// PRF and nothing received yet). The current PO renders as the non-link anchor node.
function ProcurementChain({ po }: { po: PurchaseOrder }) {
  const router = useRouter();
  if (!po.purchaseRequest && po.goodsReceipts.length === 0) return null;

  const nodeCls = "inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs font-bold";
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3.5 py-2.5">
      <span className="mr-1 text-[10px] font-extrabold uppercase tracking-wider text-[var(--faint)]">Chain</span>
      {po.purchaseRequest && (
        <>
          <button
            type="button"
            onClick={() => router.push(`/dashboard/purchase-requests/${po.purchaseRequest!.code}`)}
            className={`${nodeCls} text-[var(--accent)] transition-colors hover:bg-[var(--surface-2)]`}
            title="View the source purchase request"
          >
            <FileText className="h-3.5 w-3.5 shrink-0" /> {po.purchaseRequest.code}
          </button>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--faint)]" aria-hidden />
        </>
      )}
      <span className={`${nodeCls} text-[var(--ink)]`} aria-current="page">
        <Package className="h-3.5 w-3.5 shrink-0" /> {po.code}
      </span>
      {po.goodsReceipts.map((g) => (
        <React.Fragment key={g.id}>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--faint)]" aria-hidden />
          <button
            type="button"
            onClick={() => router.push(`/dashboard/goods-in/${g.code}`)}
            className={`${nodeCls} text-[var(--accent)] transition-colors hover:bg-[var(--surface-2)]`}
            title={`View goods receipt${g.receivedDate ? ` — received ${formatDate(g.receivedDate)}` : ""}`}
          >
            <ClipboardCheck className="h-3.5 w-3.5 shrink-0" /> {g.code}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

// Route-to-PM picker. Candidates come from the backend and the user picks one explicitly — POs are
// no longer job-linked in the UI, so there is no job creator to suggest as a default.
function AssignPmDialog({ po, busy, onAssign, onClose }: { po: PurchaseOrder; busy: boolean; onAssign: (pmUserId: string) => void; onClose: () => void }) {
  const { pushToast } = useDashboard();
  const [candidates, setCandidates] = React.useState<poService.PmCandidate[] | null>(null);
  const [pmUserId, setPmUserId] = React.useState(po.pmUserId ?? "");

  React.useEffect(() => {
    let active = true;
    poService
      .listPmCandidates()
      .then((res) => {
        if (!active) return;
        setCandidates(res.candidates);
      })
      .catch((e) => {
        if (!active) return;
        setCandidates([]);
        pushToast(e instanceof Error ? e.message : "Could not load project managers.", "alert");
      });
    return () => { active = false; };
  }, [pushToast]);

  const confirm = () => {
    if (!pmUserId) {
      pushToast("Select a project manager.", "alert");
      return;
    }
    onAssign(pmUserId);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold text-[var(--ink)]">{po.status === "pm_review" ? "Re-assign project manager" : "Route to project manager"}</h3>
        <p className="mt-1 text-xs text-[var(--muted)]">The assigned PM reviews {po.code} and issues it to the supplier.</p>
        <div className="mt-4">
          <label className={labelCls}>Project manager</label>
          {candidates === null ? (
            <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-xs text-[var(--muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : (
            <Select
              value={pmUserId}
              onChange={setPmUserId}
              options={candidates.map((c) => ({ value: c.id, label: `${c.name} (${c.email})` }))}
              placeholder="— Select a project manager —"
              ariaLabel="Project manager"
            />
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)]">Cancel</button>
          <button type="button" onClick={confirm} disabled={busy || candidates === null} className="rounded-xl bg-[var(--accent)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90 disabled:opacity-60">Assign</button>
        </div>
      </div>
    </div>
  );
}

// "Record supplier acceptance" — the supplier confirmed the issued order (sent →
// supplier_accepted). The confirmed delivery date is REQUIRED: accepting means committing to a
// date, and it's what the warehouse plans against. It stays revisable via "Update delivery date".
function SupplierAcceptanceDialog({ po, busy, onConfirm, onClose }: { po: PurchaseOrder; busy: boolean; onConfirm: (payload: poService.SupplierAcceptancePayload) => void; onClose: () => void }) {
  const { pushToast } = useDashboard();
  // Prefill from what's already recorded — the same dialog doubles as "correct the details" on an
  // order that was acknowledged earlier, so starting blank would look like the data was lost.
  const existing = Boolean(po.supplierAcceptedAt);
  const [acceptedDate, setAcceptedDate] = React.useState(po.supplierAcceptedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
  const [confirmedDeliveryDate, setConfirmedDeliveryDate] = React.useState(po.confirmedDeliveryDate?.slice(0, 10) ?? "");
  const [supplierAckReference, setSupplierAckReference] = React.useState(po.supplierAckReference ?? "");
  const [notes, setNotes] = React.useState(po.supplierAcceptNotes ?? "");

  const confirm = () => {
    if (!confirmedDeliveryDate) {
      pushToast("Enter the delivery date the supplier confirmed.", "alert");
      return;
    }
    onConfirm({
      acceptedDate: acceptedDate || undefined,
      confirmedDeliveryDate,
      supplierAckReference: supplierAckReference.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold text-[var(--ink)]">{existing ? "Update acknowledgement" : "Record supplier acceptance"}</h3>
        <p className="mt-1 text-xs text-[var(--muted)]">
          {existing
            ? `Correct the acknowledgement details recorded for ${po.code}. To log a delivery-date change with its reason, use “Update delivery date” instead.`
            : `${po.supplierName ?? po.supplier?.name ?? "The supplier"} has confirmed ${po.code}.`}
        </p>
        {/* Recording against an order that's already receiving is legitimate (a late ack) — say so,
            and be explicit that it won't rewind the order's status. */}
        {(po.status === "partially_received" || po.status === "fully_received") && (
          <p className="mt-2 rounded-lg bg-[var(--surface-2)] px-2.5 py-1.5 text-[11px] text-[var(--muted)]">
            Goods have already been received. This records the supplier&apos;s acknowledgement without changing the order status.
          </p>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Accepted on</label>
            <input type="date" className={inputCls} value={acceptedDate} onChange={(e) => setAcceptedDate(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Confirmed delivery date<span className="ml-0.5 text-[var(--neg)]">*</span></label>
            <input type="date" className={inputCls} value={confirmedDeliveryDate} onChange={(e) => setConfirmedDeliveryDate(e.target.value)} min={acceptedDate || undefined} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Supplier reference</label>
            <input className={inputCls} value={supplierAckReference} onChange={(e) => setSupplierAckReference(e.target.value)} maxLength={120} placeholder="Order confirmation / acknowledgement number (optional)" />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Notes</label>
            <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="Anything the supplier flagged (optional)" />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)]">Cancel</button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="rounded-xl bg-[var(--accent)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90 disabled:opacity-60"
          >
            Record acceptance
          </button>
        </div>
      </div>
    </div>
  );
}

// Revise the confirmed delivery date on an accepted order — shows the current date so the
// change is deliberate; the optional reason is audited alongside prev/new.
function DeliveryDateDialog({ po, busy, onConfirm, onClose }: { po: PurchaseOrder; busy: boolean; onConfirm: (confirmedDeliveryDate: string, reason?: string) => void; onClose: () => void }) {
  const { pushToast } = useDashboard();
  const [date, setDate] = React.useState(po.confirmedDeliveryDate ? po.confirmedDeliveryDate.slice(0, 10) : "");
  const [reason, setReason] = React.useState("");

  const confirm = () => {
    if (!date) {
      pushToast("Enter the new confirmed delivery date.", "alert");
      return;
    }
    onConfirm(date, reason.trim() || undefined);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold text-[var(--ink)]">Update delivery date</h3>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Currently confirmed for <span className="font-bold text-[var(--ink)]">{formatDate(po.confirmedDeliveryDate)}</span>.
        </p>
        <div className="mt-4 space-y-3">
          <div>
            <label className={labelCls}>New confirmed delivery date</label>
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Reason</label>
            <textarea className={inputCls} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why the date changed (optional)" />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)]">Cancel</button>
          <button type="button" onClick={confirm} disabled={busy} className="rounded-xl bg-[var(--accent)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90 disabled:opacity-60">Update date</button>
        </div>
      </div>
    </div>
  );
}

// `onEditAcceptance` is supplied only when the viewer may amend the acknowledgement — the parent
// owns the permission/status decision, so this stays a dumb renderer.
function Overview({ po, onEditAcceptance }: { po: PurchaseOrder; onEditAcceptance?: () => void }) {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="cell-y px-4">Item</th>
                <th className="cell-y px-4">Qty</th>
                <th className="cell-y px-4">Unit Price</th>
                <th className="cell-y px-4">VAT</th>
                <th className="cell-y px-4">Line Total</th>
              </tr>
            </thead>
            <tbody>
              {po.items.map((i) => (
                <tr key={i.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="cell-y px-4">
                    <div className="font-semibold text-[var(--ink)]">{i.itemName}</div>
                    {i.sku && <div className="text-[11px] text-[var(--faint)]">{i.sku}</div>}
                  </td>
                  <td className="cell-y px-4 text-[var(--muted)]">{i.quantity}{i.baseUnit ? ` ${i.baseUnit}` : ""}</td>
                  <td className="cell-y px-4 text-[var(--muted)]">{formatMoney(i.unitPrice, po.currency)}</td>
                  <td className="cell-y px-4 text-[var(--muted)]">{i.vatRate}%</td>
                  <td className="cell-y px-4 font-semibold text-[var(--ink)]">{formatMoney(i.lineTotal, po.currency)}</td>
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
            <Field label="Expected delivery">
              {po.expectedDeliveryDate ? (
                formatDate(po.expectedDeliveryDate)
              ) : (
                // Not just a blank "—": the order cannot be sent until this is set, so say so.
                <span className="font-semibold text-[var(--neg)]">Not set — required before sending</span>
              )}
            </Field>
            <Field label="Reference">{po.referenceNumber}</Field>
            <Field label="Priority">{PO_PRIORITY_LABELS[po.priority]}</Field>
            <Field label="Project reference">{po.projectRef}</Field>
            {po.purchaseRequest && (
              <div className="col-span-2">
                <Field label="Source purchase request">
                  <button type="button" onClick={() => router.push(`/dashboard/purchase-requests/${po.purchaseRequest!.code}`)} className="font-mono text-sm font-bold text-[var(--accent)] hover:underline">
                    {po.purchaseRequest.code}
                  </button>
                </Field>
              </div>
            )}
            {po.description && <div className="col-span-2"><Field label="Description">{po.description}</Field></div>}
          </div>
        </Card>
        {po.pmUserId && (
          <Card title="Project manager">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Assigned PM">{po.pmName}</Field>
              <Field label="Assigned">{formatDate(po.pmAssignedAt)}</Field>
              <div className="col-span-2">
                <Field label="Email">
                  {po.pmEmail ? (
                    <a className="text-[var(--accent)] hover:underline" href={`mailto:${po.pmEmail}`}>{po.pmEmail}</a>
                  ) : (
                    ""
                  )}
                </Field>
              </div>
            </div>
          </Card>
        )}
        {po.supplierAcceptedAt && (
          <Card
            title="Supplier acceptance"
            // Corrections live WITH the record (fix a mistyped reference, a wrong accepted-on
            // date). The everyday date slip has its own toolbar action, which also captures a
            // reason — so this stays out of the toolbar to avoid two buttons doing one job.
            action={
              onEditAcceptance ? (
                <button
                  type="button"
                  onClick={onEditAcceptance}
                  className="shrink-0 text-[11px] font-bold text-[var(--accent)] hover:underline"
                >
                  Edit
                </button>
              ) : undefined
            }
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="Accepted">{formatDate(po.supplierAcceptedAt)}</Field>
              <Field label="Recorded by">{po.supplierAcceptedBy}</Field>
              <Field label="Supplier reference">{po.supplierAckReference}</Field>
              <Field label="Confirmed delivery">{formatDate(po.confirmedDeliveryDate)}</Field>
              {po.supplierAcceptNotes && <div className="col-span-2"><Field label="Notes">{po.supplierAcceptNotes}</Field></div>}
            </div>
          </Card>
        )}
        <Card title="Delivery">
          <div className="space-y-3">
            <Field label="Warehouse">{po.warehouse?.name}</Field>
            <Field label="Address">{po.deliveryAddress || po.warehouse?.address}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Delivery terms">{po.deliveryTermsLabel}</Field>
              <Field label="Payment terms">{po.paymentTerms}</Field>
            </div>
            <Field label="Instructions">{po.deliveryInstructions}</Field>
          </div>
        </Card>
        <Card title="Approval">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Created by">{po.createdBy}</Field>
            {/* A PRF-born PO that skipped the submit step (fast-tracked: Finance already reviewed the
                numbers on the PRF) has no "submitted by" — showing a blank row reads as "why wasn't
                this submitted?". Show the fast-track provenance instead. A standalone PO that went
                through submit → pending_approval keeps the normal "Submitted by". */}
            {po.purchaseRequestId && !po.submittedBy ? (
              <Field label="Approval route">
                {po.purchaseRequest ? (
                  <button
                    type="button"
                    onClick={() => router.push(`/dashboard/purchase-requests/${po.purchaseRequest!.code}`)}
                    className="font-semibold text-[var(--accent)] hover:underline"
                  >
                    Fast-tracked from {po.purchaseRequest.code}
                  </button>
                ) : (
                  "Fast-tracked from purchase request"
                )}
              </Field>
            ) : (
              <Field label="Submitted by">{po.submittedBy}</Field>
            )}
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
    // Straight to Cloudinary, then finalize attaches it through the order's own service — same
    // permissions, same caps, same audit event, same DTO back.
    void (async () => {
      try {
        const result = await uploadDirect({ purpose: "po_attachment", file, targetId: po.id });
        if ("attachment" in result) setPo(result.attachment as typeof po);
        pushToast("Attachment added.", "success");
      } catch (e) {
        pushToast(e instanceof Error ? e.message : "Upload failed.", "alert");
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    })();
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
          {po.attachments.map((a) => {
            // The system-archived copy of the PO exactly as it was issued to the supplier —
            // the document of record. Rendered distinctly and NEVER deletable.
            const isRecord = a.uploadedBy === "system" && a.label === "Issued PO — as sent";
            return (
              <li key={a.id} className="flex items-center justify-between gap-3 py-3">
                <a href={a.url} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-2.5">
                  {isRecord ? <FileText className="h-4 w-4 shrink-0 text-[var(--accent)]" /> : <Paperclip className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="block truncate text-sm font-bold text-[var(--accent)] hover:underline">{a.label || a.fileName}</span>
                      {isRecord && (
                        <span className="inline-block shrink-0 whitespace-nowrap rounded-full bg-sky-500/12 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-sky-600">
                          Document of record
                        </span>
                      )}
                    </span>
                    <span className="text-[11px] text-[var(--faint)]">{a.fileType.toUpperCase()} · {(a.fileSizeBytes / 1024).toFixed(0)} KB{isRecord ? ` · archived ${formatDate(a.createdAt)}` : ""}</span>
                  </span>
                </a>
                {canEdit && !isRecord && (
                  <button type="button" onClick={() => setConfirm({ open: true, id: a.id })} className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)]" title="Remove" aria-label="Remove attachment">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
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

const RECEIPTS_PAGE_SIZE = 20;

// Read-only list of the goods receipts raised against this PO (traceability). Owns its
// own paginated fetch; rows deep-link to the authoritative GRN document; nothing here
// writes stock.
function Receipts({ poId }: { poId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const page = Math.max(1, Number(searchParams.get("receiptsPage")) || 1);
  const patchPage = React.useCallback((next: number | null) => {
    const params = new URLSearchParams(window.location.search);
    if (next && next > 1) params.set("receiptsPage", String(next)); else params.delete("receiptsPage");
    router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
  }, [router]);
  const [rows, setRows] = React.useState<GoodsReceipt[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    grnService
      .listGoodsReceipts({ purchaseOrder: poId, page, pageSize: RECEIPTS_PAGE_SIZE })
      .then((res) => {
        if (!active) return;
        setRows(res.goodsReceipts);
        setTotal(res.total);
        setTotalPages(res.totalPages);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Could not load receipts.");
        setLoading(false);
      });
    return () => { active = false; setLoading(true); };
  }, [poId, page]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;

  if (loading)
    return (
      <div className="space-y-2 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-[var(--surface-2)]" />
        ))}
      </div>
    );

  if (!rows || rows.length === 0)
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <Package className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">No receipts raised against this PO yet</p>
        <p className="text-xs text-[var(--muted)]">Goods received against this order will appear here.</p>
      </div>
    );

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <ul className="divide-y divide-[var(--border)]">
          {rows.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                onClick={() => router.push(`/dashboard/goods-in/${g.code}`)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="font-mono text-xs text-[var(--muted)]">{g.code}</span>
                  <GrnStatusBadge status={g.status} />
                </div>
                <div className="flex shrink-0 items-center gap-3 text-[11px] text-[var(--muted)]">
                  <span>{g.items.length} line{g.items.length === 1 ? "" : "s"} · {g.totalAccepted} accepted</span>
                  <span className="text-[var(--faint)]">{grnDate(g.receivedDate)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <Pagination page={page} totalPages={totalPages} total={total} label="receipts" onPage={(n) => patchPage(n)} />
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
