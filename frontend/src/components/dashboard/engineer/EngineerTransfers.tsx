"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  PenLine,
  Phone,
  Search,
  X,
} from "lucide-react";

import * as transferSvc from "@/services/engineerTransfer.service";
import { useDashboard } from "@/hooks/useDashboard";
import { subscribe } from "@/lib/socket";
import {
  EmptyState,
  fmtDateTime,
  PortalHeader,
  TableCardSkeleton,
} from "@/components/dashboard/portal/portalUi";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { inputCls, labelCls, primaryBtn, secondaryBtn } from "@/components/ui/styles";
import type { EngineerTransfer, PagedTransfers } from "@/services/engineerTransfer.service";

// Stock ownership shown in the lines table — "IRM (Company)" reads clearer than a bare "Company".
const ownershipLabel = (o: string) => (o === "company" ? "IRM (Company)" : "Customer");

// ── Constants ─────────────────────────────────────────────────────────────────

type Tab = "incoming" | "outgoing";

const STATUS_CLS: Record<string, string> = {
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-600",
  completed: "border-emerald-500/30 bg-emerald-500/10 text-[var(--pos)]",
  declined: "border-red-500/30 bg-red-500/10 text-[var(--neg)]",
  cancelled: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  completed: "Completed",
  declined: "Declined",
  cancelled: "Cancelled",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${STATUS_CLS[status] ?? STATUS_CLS.cancelled}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function requestAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Signature pad (canvas draw) ───────────────────────────────────────────────

function SignaturePad({
  onCapture,
  onCancel,
}: {
  onCapture: (dataUri: string) => void;
  onCancel: () => void;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const drawing = React.useRef(false);

  const getPos = (e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    if ("touches" in e) {
      const t = e.touches[0];
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    }
    return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top };
  };

  const start = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawing.current = true;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { x, y } = getPos(e, canvas);
    ctx.beginPath();
    ctx.moveTo(x, y);
    e.preventDefault();
  };

  const move = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { x, y } = getPos(e, canvas);
    ctx.strokeStyle = "var(--ink, #111)";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineTo(x, y);
    ctx.stroke();
    e.preventDefault();
  };

  const end = () => { drawing.current = false; };

  const clear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  };

  const save = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onCapture(canvas.toDataURL("image/png"));
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--muted)]">Draw your signature below to acknowledge receipt.</p>
      <div className="overflow-hidden rounded-xl border border-dashed border-[var(--border)] bg-white">
        <canvas
          ref={canvasRef}
          width={480}
          height={160}
          className="w-full touch-none"
          onMouseDown={start}
          onMouseMove={move}
          onMouseUp={end}
          onMouseLeave={end}
          onTouchStart={start}
          onTouchMove={move}
          onTouchEnd={end}
        />
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={clear} className={secondaryBtn}>Clear</button>
        <button type="button" onClick={save} className={primaryBtn}><PenLine className="h-3.5 w-3.5" /> Save signature</button>
        <button type="button" onClick={onCancel} className="ml-auto text-xs text-[var(--muted)] hover:text-[var(--neg)]">Cancel</button>
      </div>
    </div>
  );
}

// ── Acknowledge card (shows when a completed transfer needs signing) ───────────

function AcknowledgeCard({
  transfer,
  onDone,
}: {
  transfer: EngineerTransfer;
  onDone: () => void;
}) {
  const { pushToast } = useDashboard();
  const [signing, setSigning] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const capture = async (dataUri: string) => {
    setBusy(true);
    try {
      await transferSvc.acknowledgeTransfer(transfer.id, dataUri);
      pushToast("Transfer acknowledged.");
      onDone();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Failed to acknowledge.", "alert");
    } finally {
      setBusy(false);
      setSigning(false);
    }
  };

  return (
    <div className="rounded-2xl border border-[var(--accent)]/40 bg-[var(--accent-10)] p-4 space-y-3">
      <div className="flex items-start gap-2">
        <PenLine className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
        <div>
          <p className="text-sm font-bold text-[var(--ink)]">Awaiting your signature — {transfer.code}</p>
          <p className="text-xs text-[var(--muted)]">
            From {transfer.fromEngineerName}
            {transfer.fromEngineerPhone && (
              <>
                {" "}·{" "}
                <a href={`tel:${transfer.fromEngineerPhone}`} className="font-semibold text-[var(--accent)] hover:underline">
                  {transfer.fromEngineerPhone}
                </a>
              </>
            )}
            . Sign to acknowledge receipt of the transferred stock.
          </p>
        </div>
      </div>
      {signing ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          {busy ? (
            <div className="flex items-center gap-2 py-6 justify-center text-[var(--muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Saving…
            </div>
          ) : (
            <SignaturePad onCapture={capture} onCancel={() => setSigning(false)} />
          )}
        </div>
      ) : (
        <button type="button" onClick={() => setSigning(true)} className={primaryBtn}>
          <PenLine className="h-3.5 w-3.5" /> Sign to acknowledge
        </button>
      )}
    </div>
  );
}

// ── Decline modal ─────────────────────────────────────────────────────────────

function DeclineModal({
  transfer,
  onDone,
  onCancel,
}: {
  transfer: EngineerTransfer;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { pushToast } = useDashboard();
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await transferSvc.declineTransfer(transfer.id, reason.trim() || undefined);
      pushToast("Transfer declined.");
      onDone();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Failed to decline.", "alert");
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <button type="button" onClick={onCancel} disabled={busy} className={secondaryBtn}>Cancel</button>
      <button
        type="button"
        onClick={() => submit()}
        disabled={busy}
        className="flex items-center gap-2 rounded-xl bg-[var(--neg)] px-4 py-2.5 text-xs font-extrabold text-white disabled:opacity-60"
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Decline
      </button>
    </>
  );

  return (
    <Modal
      open
      onClose={busy ? () => {} : onCancel}
      title="Decline transfer"
      subtitle={`${transfer.code} — from ${transfer.fromEngineerName}`}
      size="sm"
      footer={footer}
    >
      <div>
        <label className={labelCls}>Reason (optional)</label>
        <textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why are you declining?"
          className={`${inputCls} resize-none`}
        />
      </div>
    </Modal>
  );
}

// ── Transfer row (collapsible) ────────────────────────────────────────────────

function TransferRow({
  transfer,
  role,
  onAction,
}: {
  transfer: EngineerTransfer;
  role: "incoming" | "outgoing";
  onAction: () => void;
}) {
  const { pushToast } = useDashboard();
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [declining, setDeclining] = React.useState(false);
  const [signing, setSigning] = React.useState(false);
  // Both approve (accepts custody of another engineer's stock) and cancel (irreversible) go through a
  // confirm step, matching the deliberate-action bar the rest of the transfer/field-stock flow holds.
  const [confirm, setConfirm] = React.useState<null | "approve" | "cancel">(null);

  const approve = async () => {
    setBusy(true);
    try {
      await transferSvc.approveTransfer(transfer.id);
      pushToast("Transfer approved.");
      onAction();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Approve failed.", "alert");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await transferSvc.cancelTransfer(transfer.id);
      pushToast("Transfer cancelled.");
      onAction();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Cancel failed.", "alert");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const acknowledge = async (dataUri: string) => {
    setBusy(true);
    try {
      await transferSvc.acknowledgeTransfer(transfer.id, dataUri);
      pushToast("Acknowledged.");
      onAction();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Acknowledge failed.", "alert");
    } finally {
      setBusy(false);
      setSigning(false);
    }
  };

  const needsSign =
    role === "outgoing" &&
    transfer.status === "completed" &&
    transfer.requireSignature &&
    !transfer.acknowledgedAt;

  return (
    <>
      {declining && (
        <DeclineModal
          transfer={transfer}
          onDone={() => { setDeclining(false); onAction(); }}
          onCancel={() => setDeclining(false)}
        />
      )}
      <ConfirmDialog
        open={confirm === "approve"}
        title="Approve this transfer?"
        message="The requested stock moves to the other engineer once you approve."
        confirmLabel="Approve transfer"
        busy={busy}
        onConfirm={approve}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "cancel"}
        title="Cancel this transfer?"
        message={`Transfer ${transfer.code} will be cancelled. This can't be undone.`}
        confirmLabel="Cancel transfer"
        danger
        busy={busy}
        onConfirm={cancel}
        onClose={() => setConfirm(null)}
      />
      <tr className="border-b border-[var(--border)] last:border-0">
        <td className="px-4 py-3">
          <div className="font-mono text-xs font-bold text-[var(--ink)]">{transfer.code}</div>
          <div className="flex items-center gap-1 text-[11px] text-[var(--faint)]">
            <Clock className="h-3 w-3" /> {requestAge(transfer.createdAt)}
          </div>
        </td>
        <td className="px-4 py-3 text-sm text-[var(--ink)]">
          {/* Incoming = I'm the HOLDER being asked → show the RECIPIENT who's requesting my stock.
              My requests (outgoing) = I'm the RECIPIENT → show the HOLDER I collect from, with their
              phone so I can call to coordinate the handover. */}
          {role === "incoming" ? (
            transfer.toEngineerName
          ) : (
            <div>
              <div>{transfer.fromEngineerName}</div>
              {transfer.fromEngineerPhone && (
                <a href={`tel:${transfer.fromEngineerPhone}`} className="flex items-center gap-1 text-[11px] font-semibold text-[var(--accent)] hover:underline">
                  <Phone className="h-3 w-3" /> {transfer.fromEngineerPhone}
                </a>
              )}
            </div>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-[var(--muted)]">{transfer.reason}</td>
        <td className="px-4 py-3">
          <StatusBadge status={transfer.status} />
          {needsSign && (
            <span className="ml-1 rounded-full bg-[var(--accent-10)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent)]">
              Sign
            </span>
          )}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            {/* Incoming pending → Approve + Decline */}
            {role === "incoming" && transfer.status === "pending" && (
              <>
                <button
                  type="button"
                  onClick={() => setConfirm("approve")}
                  disabled={busy}
                  className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[11px] font-bold text-white disabled:opacity-60"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => setDeclining(true)}
                  disabled={busy}
                  className="flex items-center gap-1 rounded-lg border border-[var(--neg)]/30 px-2.5 py-1.5 text-[11px] font-bold text-[var(--neg)] disabled:opacity-60"
                >
                  <X className="h-3 w-3" /> Decline
                </button>
              </>
            )}
            {/* Outgoing pending → Cancel */}
            {role === "outgoing" && transfer.status === "pending" && (
              <button
                type="button"
                onClick={() => setConfirm("cancel")}
                disabled={busy}
                className="flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--muted)] hover:text-[var(--neg)] disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                Cancel
              </button>
            )}
            {/* Completed but needs signature */}
            {needsSign && !signing && (
              <button
                type="button"
                onClick={() => setSigning(true)}
                className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[11px] font-bold text-white"
              >
                <PenLine className="h-3 w-3" /> Sign
              </button>
            )}
            {/* Expand details */}
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="rounded-lg border border-[var(--border)] p-1.5 hover:bg-[var(--surface-2)]"
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5 text-[var(--muted)]" /> : <ChevronDown className="h-3.5 w-3.5 text-[var(--muted)]" />}
            </button>
          </div>
        </td>
      </tr>

      {/* Expanded detail row */}
      {expanded && (
        <tr className="border-b border-[var(--border)] bg-[var(--surface-2)] last:border-0">
          <td colSpan={5} className="px-4 pb-4 pt-2">
            <div className="space-y-3 text-xs">
              {transfer.notes && <p className="text-[var(--muted)]"><span className="font-semibold text-[var(--ink)]">Notes:</span> {transfer.notes}</p>}
              {transfer.declineReason && <p className="text-[var(--neg)]"><span className="font-semibold">Declined:</span> {transfer.declineReason}</p>}
              <div>
                <p className="mb-1 font-semibold text-[var(--ink)]">Lines</p>
                <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                        <th className="px-3 py-2">Item</th>
                        <th className="px-3 py-2">Ownership</th>
                        <th className="px-3 py-2 text-right">Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transfer.lines.map((l) => (
                        <tr key={l.id} className="border-b border-[var(--border)] last:border-0">
                          <td className="px-3 py-2 font-semibold text-[var(--ink)]">
                            {l.itemName}
                            {l.sku && <span className="ml-1 font-mono text-[10px] text-[var(--faint)]">· {l.sku}</span>}
                          </td>
                          <td className="px-3 py-2 text-[var(--muted)]">{ownershipLabel(l.ownership)}</td>
                          <td className="px-3 py-2 text-right font-bold text-[var(--ink)]">
                            {l.quantity}{l.uom ? ` ${l.uom}` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {transfer.attachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {transfer.attachments.map((url, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={i} src={url} alt={`Attachment ${i + 1}`} className="h-16 w-16 rounded-lg border border-[var(--border)] object-cover" />
                  ))}
                </div>
              )}
              {transfer.acknowledgedAt && (
                <p className="text-[var(--pos)]">Acknowledged {fmtDateTime(transfer.acknowledgedAt)}</p>
              )}
              {transfer.receiverSignatureUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={transfer.receiverSignatureUrl} alt="Signature" className="h-16 rounded-lg border border-[var(--border)] bg-white object-contain p-1" />
              )}
            </div>
            {/* Inline signature pad */}
            {signing && (
              <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                {busy ? (
                  <div className="flex items-center gap-2 py-6 justify-center text-[var(--muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                  </div>
                ) : (
                  <SignaturePad onCapture={acknowledge} onCancel={() => setSigning(false)} />
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Incoming / Outgoing list ───────────────────────────────────────────────────

function TransferList({ role }: { role: "incoming" | "outgoing" }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Filters live in the URL (?status, ?sort, ?q, ?page) so they survive a refresh — same approach as
  // the admin board. The active tab is ?view= (owned by the parent), preserved on every patch.
  const status = searchParams.get("status") ?? "";
  const sortOldest = searchParams.get("sort") === "oldest"; // default: newest first (matches every other list)
  const search = searchParams.get("q") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [paged, setPaged] = React.useState<PagedTransfers | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seed the box when ?q changes outside typing (browser back/forward). Adjusting state during
  // render (not via an effect) is the React-recommended pattern and avoids a cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const reload = React.useCallback(() => setRefreshKey((k) => k + 1), []);
  // Only the transfer event is relevant here — subscribe narrowly instead of via useGoodsSocket, so an
  // unrelated warehouse issue/return anywhere doesn't trigger a full paged refetch of this list.
  React.useEffect(() => subscribe(["engineer:transfer_updated"], reload), [reload]);

  const patchParams = React.useCallback(
    (updates: Record<string, string | null>, resetPage = false) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      if (resetPage) params.delete("page");
      router.replace(`/dashboard/engineer/transfers?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  // Debounce the search box into ?q.
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== search) patchParams({ q: searchInput.trim() || null }, true);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patchParams]);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      if (active) setLoading(true);
      try {
        const r = await transferSvc.listMyTransfers({
          role,
          status: status || undefined,
          sort: sortOldest ? "oldest" : "newest",
          search: search || undefined,
          page,
          pageSize: 20,
        });
        if (active) { setPaged(r); setError(null); }
      } catch (err) {
        // A load failure gets its OWN state — never render it as an empty inbox (which reads as
        // "nothing here" and hides the failure), matching EngineerJobs / EngineerVanStock.
        if (active) setError(err instanceof Error ? err.message : "Could not load your transfers.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [role, status, sortOldest, search, page, refreshKey]);

  const data = paged?.transfers ?? [];
  const filtered = !!(search || status);

  // Pending ack banners — only the recipient (outgoing / "My requests") can acknowledge
  const needsAck = role === "outgoing"
    ? data.filter((t) => t.status === "completed" && t.requireSignature && !t.acknowledgedAt)
    : [];

  const headers = [
    "Code / Age",
    role === "incoming" ? "Requested by" : "From (holder)",
    "Reason",
    "Status",
    "",
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {needsAck.map((t) => (
        <AcknowledgeCard key={t.id} transfer={t} onDone={reload} />
      ))}

      {/* Toolbar — search + status filter + sort */}
      <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xs lg:flex-row lg:flex-wrap lg:items-center">
        <div className="relative w-full lg:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search code or reason…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <Select
          size="sm"
          value={status}
          onChange={(v) => patchParams({ status: v || null }, true)}
          options={[
            { value: "", label: "All statuses" },
            { value: "pending", label: "Pending" },
            { value: "completed", label: "Completed" },
            { value: "declined", label: "Declined" },
            { value: "cancelled", label: "Cancelled" },
          ]}
          ariaLabel="Status filter"
        />
        <Select
          size="sm"
          value={sortOldest ? "oldest" : "newest"}
          onChange={(v) => patchParams({ sort: v === "oldest" ? "oldest" : null }, true)}
          options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
          ]}
          ariaLabel="Sort order"
        />
      </div>

      {loading ? (
        <TableCardSkeleton
          headers={headers}
          cells={["h-3 w-16", "h-3 w-24", "h-3 w-32", "h-3 w-16", "h-3 w-20"]}
          minWidth={480}
        />
      ) : error ? (
        <div className="flex flex-1 items-center justify-center p-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</div>
      ) : data.length === 0 ? (
        <EmptyState
          icon={ArrowRightLeft}
          title={filtered ? "No matching transfers" : role === "incoming" ? "No incoming requests" : "No outgoing requests"}
          hint={
            filtered
              ? "Try a different search or status filter."
              : role === "incoming"
                ? "When another engineer requests stock from you, it will appear here."
                : "Requests you've sent will appear here."
          }
        />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                  <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    {headers.map((h, i) => (
                      <th key={i} className="px-4 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((t) => (
                    <TransferRow key={t.id} transfer={t} role={role} onAction={reload} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {paged && paged.total > 0 && (
            <div className="shrink-0">
              <Pagination
                page={paged.page}
                totalPages={paged.totalPages}
                total={paged.total}
                label="transfers"
                onPage={(p) => patchParams({ page: p > 1 ? String(p) : null })}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function EngineerTransfers() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The active tab + list filters all live in the URL so a refresh keeps you exactly where you were.
  const tab: Tab = searchParams.get("view") === "outgoing" ? "outgoing" : "incoming";

  const setTab = (t: Tab) => {
    const params = new URLSearchParams(window.location.search);
    params.set("view", t);
    params.delete("page"); // switching tabs starts at page 1 (filters carry over)
    router.replace(`/dashboard/engineer/transfers?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <PortalHeader
        title="Transfers"
        subtitle="Request stock from another engineer, or act on incoming requests."
        action={
          <button type="button" onClick={() => router.push("/dashboard/engineer/transfers/new")} className={primaryBtn}>
            <ArrowRightLeft className="h-3.5 w-3.5" /> Request stock
          </button>
        }
      />

      {/* Tabs */}
      <div className="flex shrink-0 items-center gap-2">
        {(["incoming", "outgoing"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition-all ${
              tab === t
                ? "bg-[var(--accent)] text-white"
                : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            {t === "incoming" ? "Incoming" : "My requests"}
          </button>
        ))}
      </div>

      {tab === "incoming" ? <TransferList role="incoming" /> : <TransferList role="outgoing" />}
    </div>
  );
}
