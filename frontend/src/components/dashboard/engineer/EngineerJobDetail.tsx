"use client";

import * as React from "react";
import { ArrowLeftRight, CheckCircle2, MapPin, PackagePlus, Truck, XCircle, PlayCircle, ClipboardCheck } from "lucide-react";

import * as engineerService from "@/services/engineer.service";
import { isStaleStateError } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useJobSocket } from "@/hooks/useJobSocket";
import { useGoodsSocket } from "@/hooks/useGoodsSocket";
import { EngineerKitRequests } from "./EngineerKitRequests";
import { ghostBtn, primaryBtn } from "@/components/ui/styles";
import { fmtDate, fmtDateTime, JobStatusChip, PortalHeader, TableCard } from "@/components/dashboard/portal/portalUi";
import { GoodsStatusChip } from "@/components/dashboard/jobs/jobStatus";
import { crossWarehouseReturnNote, kitLineSourceSplit } from "@/components/dashboard/jobs/jobStatus";
import { outstandingKit } from "@/components/dashboard/jobs/outstandingKit";
import { Notice } from "@/components/ui/Notice";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import type { Job, JobKitLine, JobKitWarehouse } from "@/types/job";
import { WarehousePickupModal } from "./WarehousePickupModal";
import type { UsedLinePayload } from "@/types/goodsManagement";

// Engineer Portal — single assigned job. Loads the engineer's own job by id, shows the
// identification / site / schedule cards + kit list, and an Accept button (only while the job is
// "assigned"). Accept POSTs and replaces local state with the server's returned job, so the status
// pill and the button reflect the real transition — the backend is the authority.

const KIT_HEADERS = ["Item", "SE code", "Type", "Warehouse", "Planned", "Issued", "Used", "Returned", "Remaining", "Notes"];

const LINE_TYPE_LABEL: Record<JobKitLine["lineType"], string> = {
  customer_stock: "Customer stock",
  irm: "IRM",
  misc: "Misc",
};

// One labelled field inside a detail card. Renders "—" for empty values.
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold text-[var(--ink)]">{value || "—"}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs">
      <p className="mb-4 text-[11px] font-extrabold uppercase tracking-wider text-[var(--faint)]">{title}</p>
      {children}
    </section>
  );
}

// Used-qty row for a kit line in the Complete work form.
interface UsedRow {
  kitLineId: string;
  source: "irm" | "customer";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  warehouseName: string | null; // which warehouse this line was collected from (disambiguates same item)
  held: number; // qty the engineer currently holds for this line (issued − returned) — the usable max
  qty: number; // declared used quantity
}

export function EngineerJobDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [job, setJob] = React.useState<Job | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [accepting, setAccepting] = React.useState(false);
  const [rejecting, setRejecting] = React.useState(false);
  const [rejectMode, setRejectMode] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState("");
  const [starting, setStarting] = React.useState(false);
  const [completing, setCompleting] = React.useState(false);
  const [completeMode, setCompleteMode] = React.useState(false);
  const [workSummary, setWorkSummary] = React.useState("");
  const [usedRows, setUsedRows] = React.useState<UsedRow[]>([]);
  const busy = accepting || rejecting || starting || completing;
  const [whModal, setWhModal] = React.useState<JobKitWarehouse | null>(null);
  const [kitOpen, setKitOpen] = React.useState(false); // controls the "Request items" modal (trigger in header)

  React.useEffect(() => {
    let active = true;
    engineerService
      .getOwnJob(id)
      .then((j) => {
        if (active) setJob(j);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load this job.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  // Live-refresh the job so the kit tallies + the "Start work" gate never go stale: when the
  // warehouse issues/returns this job's kit (goods:*) or the planner edits/cancels/reassigns it
  // (job:*), refetch server truth. Skipped while one of this page's own mutations is in flight (that
  // action already replaces state from its response), so a socket refetch can't race it.
  const busyRef = React.useRef(busy);
  React.useEffect(() => { busyRef.current = busy; });
  const reloadJob = React.useCallback(() => {
    if (busyRef.current) return;
    engineerService
      .getOwnJob(id)
      .then((j) => setJob(j))
      // This is a background socket-triggered refetch, not a user action. Only a genuine stale-state
      // error (404/409 — the planner reassigned or cancelled the job out from under this engineer) is
      // worth interrupting them for; a transient network blip is swallowed, leaving the current job on
      // screen until the next event or navigation recovers it (no scary toast over a job that's fine).
      .catch((e) => {
        if (isStaleStateError(e)) pushToast("This job is no longer available — it may have been reassigned or cancelled.", "alert");
      });
  }, [id, pushToast]);
  useJobSocket(reloadJob);
  useGoodsSocket(reloadJob);

  const onAccept = async () => {
    setAccepting(true);
    try {
      const updated = await engineerService.acceptOwnJob(id);
      setJob(updated); // replace with server truth (status now "accepted")
      pushToast("Job accepted.");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not accept this job.", "alert");
    } finally {
      setAccepting(false);
    }
  };

  const onReject = async () => {
    setRejecting(true);
    try {
      const updated = await engineerService.rejectOwnJob(id, rejectReason.trim() || undefined);
      setJob(updated); // status now "rejected"
      setRejectMode(false);
      setRejectReason("");
      pushToast("Job rejected. The project manager has been notified.");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not reject this job.", "alert");
    } finally {
      setRejecting(false);
    }
  };

  const onStart = async () => {
    setStarting(true);
    try {
      const updated = await engineerService.startOwnJob(id);
      setJob(updated); // status now "in_progress"
      pushToast("Job started. You are now on site.");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not start this job.", "alert");
    } finally {
      setStarting(false);
    }
  };

  // Build the used-qty form rows from the current job's kit lines (IRM + customer_stock only).
  const openCompleteForm = (currentJob: Job) => {
    const rows: UsedRow[] = currentJob.kitLines
      .filter((l) => l.lineType === "irm" || l.lineType === "customer_stock")
      .map((l) => ({
        kitLineId: l.id,
        source: l.lineType === "irm" ? "irm" : "customer",
        irmItemId: l.irmItemId,
        customerStockEntryId: l.customerStockEntryId,
        itemName: l.itemName,
        warehouseName: l.warehouseName,
        held: l.remaining, // what the engineer still holds for this line — caps "used"
        qty: 0,
      }));
    setUsedRows(rows);
    setWorkSummary("");
    setCompleteMode(true);
  };

  const onComplete = async () => {
    setCompleting(true);
    try {
      const usedLines: UsedLinePayload[] = usedRows
        .map((r) => ({ ...r, qty: Math.min(r.qty, r.held) })) // never declare more than is held
        .filter((r) => r.qty > 0)
        .map((r) => ({
          source: r.source,
          irmItemId: r.source === "irm" ? (r.irmItemId ?? undefined) : undefined,
          customerStockEntryId: r.source === "customer" ? (r.customerStockEntryId ?? undefined) : undefined,
          jobKitLineId: r.kitLineId, // file "used" against the exact kit line (an item can be on >1 warehouse)
          qty: r.qty,
        }));
      const updated = await engineerService.completeOwnJob(id, {
        workSummary: workSummary.trim() || undefined,
        usedLines,
      });
      setJob(updated); // status now "completed"
      setCompleteMode(false);
      pushToast("Job marked as complete. Well done!");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not complete this job.", "alert");
    } finally {
      setCompleting(false);
    }
  };

  if (loading) return <FormPageSkeleton />;
  if (error || !job) return <FormError message={error ?? "Job not found."} />;

  const canAccept = job.status === "assigned";
  const canStart = job.status === "accepted";
  const canComplete = job.status === "in_progress";
  // Reconciled goods lock the job's kit — no more requests possible. The CARD stays visible (the
  // engineer keeps their request history + a note saying why it's locked); only the request
  // TRIGGERS (header button + card button) go by this flag.
  const kitLocked = job.goodsStatus === "reconciled";
  // The Additional Kit card shows while the job is live for an engineer who can request kit; the
  // "Request items" trigger sits in the header (and the card), gated additionally by kitLocked.
  const showKitCard = (job.status === "accepted" || job.status === "in_progress") && can("engineer.jobs.request_kit");
  const canRequestKit = showKitCard && !kitLocked;
  // Can't start until the kit is COLLECTED: every stock-tracked line (IRM / customer stock) must be
  // fully issued by the warehouse. Misc/free-text lines aren't warehouse stock, so they don't block.
  const stockLines = job.kitLines.filter((l) => l.lineType === "irm" || l.lineType === "customer_stock");
  const goodsCollected = stockLines.length === 0 || stockLines.every((l) => l.issued >= l.qty);
  // Site address for display + a text-based Google Maps directions link (same approach as the pickup
  // warehouse below — the app stores no map coordinates, so the postcode + street text drives the search).
  const siteAddressParts = [job.addressLine1, job.addressLine2, job.city, job.county, job.postcode, job.country].filter(Boolean) as string[];
  const addressLines = [job.addressLine1, job.addressLine2, job.city, job.county, job.postcode].filter(Boolean).join(", ");
  const siteMapsUrl = siteAddressParts.length > 0
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(siteAddressParts.join(", "))}`
    : null;
  const fixings = [
    job.floor ? `Floor ${job.floor}` : null,
    job.suite ? `Suite ${job.suite}` : null,
    job.rack ? `Rack ${job.rack}` : null,
    job.shelf ? `Shelf ${job.shelf}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-6">
      <PortalHeader
        title={job.name}
        subtitle={`${job.jobNumber}${job.customerName ? ` · ${job.customerName}` : ""}`}
        action={
          canAccept ? (
            <div className="flex items-center gap-2">
              <button type="button" onClick={onAccept} disabled={busy} className={primaryBtn}>
                <CheckCircle2 className="h-4 w-4" /> {accepting ? "Accepting…" : "Accept job"}
              </button>
              <button type="button" onClick={() => setRejectMode((v) => !v)} disabled={busy} className={ghostBtn}>
                <XCircle className="h-4 w-4" /> Reject
              </button>
            </div>
          ) : canStart ? (
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-2">
                {canRequestKit && (
                  <button type="button" onClick={() => setKitOpen(true)} disabled={busy} className={ghostBtn}>
                    <PackagePlus className="h-4 w-4" /> Request items
                  </button>
                )}
                <button type="button" onClick={onStart} disabled={busy || !goodsCollected} title={!goodsCollected ? "Collect your kit from the warehouse first" : undefined} className={primaryBtn}>
                  <PlayCircle className="h-4 w-4" /> {starting ? "Starting…" : "Start work"}
                </button>
              </div>
              {!goodsCollected && <p className="text-[11px] font-semibold text-[var(--muted)]">Collect your kit from the warehouse first</p>}
            </div>
          ) : canComplete ? (
            <div className="flex items-center gap-2">
              {canRequestKit && (
                <button type="button" onClick={() => setKitOpen(true)} disabled={busy} className={ghostBtn}>
                  <PackagePlus className="h-4 w-4" /> Request items
                </button>
              )}
              <button type="button" onClick={() => openCompleteForm(job)} disabled={busy} className={primaryBtn}>
                <ClipboardCheck className="h-4 w-4" /> Complete work
              </button>
            </div>
          ) : (
            <JobStatusChip value={job.status} />
          )
        }
      />

      {canAccept && rejectMode && (
        <Card title="Reject this job">
          <p className="mb-2 text-xs text-[var(--muted)]">Tell the project manager why you cannot take this job (optional). They will be notified and can reassign it.</p>
          <textarea
            autoFocus
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Reason (optional)"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => { setRejectMode(false); setRejectReason(""); }} disabled={busy} className={ghostBtn}>Cancel</button>
            <button type="button" onClick={onReject} disabled={busy} className="flex items-center gap-1.5 rounded-xl bg-[var(--neg)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90 disabled:opacity-60">
              <XCircle className="h-3.5 w-3.5" /> {rejecting ? "Rejecting…" : "Confirm reject"}
            </button>
          </div>
        </Card>
      )}

      {job.status === "rejected" && (
        <Card title="Rejected">
          <Field label="Reason" value={job.rejectReason} />
        </Card>
      )}

      {canComplete && completeMode && (
        <Card title="Complete this job">
          <p className="mb-4 text-xs text-[var(--muted)]">
            Declare how many of each item you used on site. Leave at 0 if unused — the rest is treated as
            still held (return it to the warehouse). You can&apos;t declare more than you&apos;re holding.
          </p>

          {usedRows.length > 0 && (
            <div className="mb-4 overflow-x-auto rounded-xl border border-[var(--border)]">
              <table className="w-full text-sm" style={{ minWidth: 560 }}>
                <thead>
                  <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    <th className="px-4 py-2 text-left">Item</th>
                    <th className="px-4 py-2 text-left">Type</th>
                    <th className="px-4 py-2 text-left">Warehouse</th>
                    <th className="w-20 px-4 py-2 text-right">Held</th>
                    <th className="w-28 px-4 py-2 text-right">Used qty</th>
                  </tr>
                </thead>
                <tbody>
                  {usedRows.map((row, i) => (
                    <tr key={row.kitLineId} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-4 py-2 font-semibold text-[var(--ink)]">{row.itemName}</td>
                      <td className="px-4 py-2 text-[var(--muted)]">{row.source === "irm" ? "IRM" : "Customer stock"}</td>
                      <td className="px-4 py-2 text-[var(--muted)]">{row.warehouseName ?? "—"}</td>
                      <td className="px-4 py-2 text-right font-bold text-[var(--ink)]">{row.held}</td>
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          min={0}
                          max={row.held}
                          step={1}
                          value={row.qty}
                          disabled={row.held === 0}
                          title={row.held === 0 ? "Nothing issued to you for this item" : `Max ${row.held} (held)`}
                          onChange={(e) => {
                            // Cap at the held quantity so the engineer can never declare more than they hold.
                            const v = Math.min(row.held, Math.max(0, Math.floor(Number(e.target.value) || 0)));
                            setUsedRows((rows) => rows.map((r, j) => j === i ? { ...r, qty: v } : r));
                          }}
                          className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-right text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)] disabled:opacity-40"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <label className="mb-1 block text-xs font-bold text-[var(--faint)]">Work summary (optional)</label>
          <textarea
            value={workSummary}
            onChange={(e) => setWorkSummary(e.target.value)}
            rows={4}
            maxLength={4000}
            placeholder="Describe the work completed on site…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />

          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCompleteMode(false)}
              disabled={completing}
              className={ghostBtn}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onComplete}
              disabled={completing}
              className="flex items-center gap-1.5 rounded-xl bg-[var(--pos)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90 disabled:opacity-60"
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              {completing ? "Completing…" : "Confirm complete"}
            </button>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Identification">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Job number" value={job.jobNumber} />
            <Field label="Status" value={<JobStatusChip value={job.status} />} />
            {/* Goods lifecycle — the engineer needs to SEE when goods are reconciled (locked), since
                that's why kit requests disappear. Same chip the admin jobs list uses. */}
            <Field label="Goods" value={<GoodsStatusChip status={job.goodsStatus} />} />
            <Field label="Customer" value={job.customerName} />
            <Field label="Project" value={job.projectName} />
            <Field label="Customer ref" value={job.customerRef} />
            <Field label="Scheme no." value={job.schemeNo} />
            <Field label="Job type" value={job.jobType} />
            <Field label="Technology" value={job.technology} />
            <Field label="Priority" value={job.priority} />
            <Field label="Installer" value={job.installerType} />
            <Field label="Supplier" value={job.supplierName} />
            <Field label="TRS area" value={job.trsArea} />
          </div>
        </Card>

        <Card title="Site & address">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Site" value={job.siteName} />
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Address</p>
              <p className="mt-0.5 text-sm font-semibold text-[var(--ink)]">{addressLines || "—"}</p>
              {siteMapsUrl && (
                <a
                  href={siteMapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-[11px] font-bold text-[var(--accent)] hover:underline"
                >
                  <MapPin className="h-3 w-3 shrink-0" /> Directions
                </a>
              )}
            </div>
            <Field label="Location" value={fixings} />
          </div>
        </Card>

        <Card title="Schedule">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Completion date" value={fmtDate(job.completionDate)} />
            <Field label="Assigned" value={fmtDate(job.assignedAt)} />
            <Field label="Accepted" value={fmtDate(job.acceptedAt)} />
            <Field label="Accepted by" value={job.acceptedBy} />
            <Field label="Work started" value={fmtDateTime(job.startedAt)} />
            <Field label="Work completed" value={fmtDateTime(job.completedAt)} />
          </div>
        </Card>

        <Card title="Planner & engineer">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Engineer" value={job.assignedEngineerName} />
            <Field label="Engineer email" value={job.assignedEngineerEmail} />
            <Field label="Planner" value={job.plannerName} />
            <Field label="Planner phone" value={job.plannerPhone} />
          </div>
        </Card>
      </div>

      <Card title="Kit list">
        {/* The engineer is the person physically holding the stock, so a cancelled job's one remaining
            instruction belongs here, above the kit. Non-blocking and only while something is actually
            out — see outstandingKitWarning for the office-side twin. */}
        {job.status === "cancelled" &&
          (() => {
            const { units } = outstandingKit(job.kitLines);
            if (units === 0) return null;
            return (
              // Bare — Notice already draws the amber panel; a bordered wrapper nested a second box.
              <div className="mb-3">
                <Notice
                  msg={{ type: "warn", text: `This job was cancelled. Return the ${units} unit${units === 1 ? "" : "s"} you're still holding to the warehouse — nothing more is to be collected.` }}
                  size="sm"
                />
              </div>
            );
          })()}
        {job.kitLines.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No kit lines on this job.</p>
        ) : (
          <TableCard headers={KIT_HEADERS} minWidth={1040}>
            {job.kitLines.map((line) => {
              const isMisc = line.lineType === "misc";
              return (
              <tr key={line.id} className="border-b border-[var(--border)] last:border-0">
                <td className="cell-y px-4 font-semibold text-[var(--ink)]">
                  {line.itemName}
                  {line.description ? (
                    <span className="block text-xs font-normal text-[var(--muted)]">{line.description}</span>
                  ) : null}
                </td>
                <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{line.seCode ?? "—"}</td>
                <td className="cell-y px-4 text-[var(--muted)]">{LINE_TYPE_LABEL[line.lineType] ?? line.lineType}</td>
                {/* Where this stock actually comes FROM. A van-sourced line still stores a warehouse
                    (leftovers are returned there), so showing that warehouse as the pickup location
                    would send the engineer to collect stock a colleague is already handing them. */}
                <td className="cell-y px-4">
                  {line.vanSources?.length ? (
                    // A row can carry BOTH origins (kit lines merge same item + warehouse), so the
                    // engineer sees each with its quantity — how many to collect vs how many a
                    // colleague is handing over — then where the leftovers go back.
                    (() => {
                      const s = kitLineSourceSplit(line, { jobCancelled: job.status === "cancelled" });
                      return (
                        // Sources wrap on ONE line instead of stacking: a split row was three stacked
                        // lines (warehouse, van, return note) and stood twice as tall as its
                        // neighbours. Wrapping only kicks in when there genuinely are several
                        // holders, which is the case that has earned the height.
                        <div className="flex flex-col items-start gap-0.5">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {/* warehouseSHARE, not warehouseQty: the latter counts only units already
                              issued, so on a line the planner has just split it is 0 and the whole
                              warehouse row vanished — the engineer saw the van hand-over and was
                              never told where to collect the rest. */}
                          {s.warehouseShare > 0 && line.warehouse && (
                            <button type="button" onClick={() => setWhModal(line.warehouse)} className="inline-flex max-w-[200px] items-center gap-1 font-semibold text-[var(--accent)] hover:underline" title="View pickup address">
                              <MapPin className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{line.warehouse.name}</span>
                              <span className="font-normal text-[var(--faint)]">×{s.warehouseShare}</span>
                              {s.outstandingWarehouseQty > 0 && s.warehouseQty > 0 && (
                                <span className="text-[10px] font-bold text-amber-600">{s.outstandingWarehouseQty} to collect</span>
                              )}
                            </button>
                          )}
                          {line.vanSources.map((v) => (
                            <span key={v.transferCode} className="inline-flex items-center gap-1 font-semibold text-[var(--ink)]" title={`${v.transferCode} — ${v.quantity} from ${v.engineerName}`}>
                              <Truck className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
                              {/* Tappable, because the handover is arranged person-to-person and a kit
                                  list can name two or three different holders. The request-level
                                  "View transfer & contact" link only ever points at one of them, so
                                  the engineer had to guess which. The phone is already snapshotted on
                                  the transfer for exactly this. */}
                              {v.engineerPhone ? (
                                <a href={`tel:${v.engineerPhone}`} className="truncate text-[var(--accent)] hover:underline" title={`Call ${v.engineerName} on ${v.engineerPhone}`}>
                                  {v.engineerName}
                                </a>
                              ) : (
                                <span className="truncate">{v.engineerName}</span>
                              )}
                              <span className="font-normal text-[var(--faint)]">×{v.quantity}</span>
                              {v.status === "pending" && <span className="text-[10px] font-bold text-amber-600">awaiting handover</span>}
                            </span>
                          ))}
                          </div>
                          {/* Van stock never left a warehouse, so it can be handed in anywhere;
                              warehouse-issued units owe their own site. A merged line has both, so
                              spell each part out — the server enforces exactly this on return. */}
                          <span className="text-[10px] text-[var(--faint)]">
                            {s.vanOnly
                              ? "Return at any warehouse"
                              : s.vanReturnableQty > 0 && s.warehouseQty > 0 && line.warehouseName
                                ? `Return ×${s.warehouseQty} at ${line.warehouseName}, ×${s.vanReturnableQty} at any warehouse`
                                : line.warehouseName
                                  ? `Return at ${line.warehouseName}`
                                  : ""}
                          </span>
                        </div>
                      );
                    })()
                  ) : line.warehouse ? (
                    <button type="button" onClick={() => setWhModal(line.warehouse)} className="inline-flex max-w-[200px] items-center gap-1 font-semibold text-[var(--accent)] hover:underline" title="View pickup address">
                      <MapPin className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{line.warehouse.name}</span>
                    </button>
                  ) : (
                    <span className="font-semibold text-[var(--ink)]">{line.warehouseName ?? "—"}</span>
                  )}
                </td>
                {/* Planned + Issued are real for a misc line — it IS planned and handed over by count.
                    Used / Returned / Remaining are not: misc is free text with no barcode and no stock
                    balance, so it can never be scanned back, the Complete form leaves it out, and
                    reconcile skips it entirely. Those three would therefore sit at 0 / 0 / issued
                    forever, and "Remaining 5" on a job already marked Reconciled reads as five units
                    the engineer still owes. An em dash says the column doesn't apply — the same thing
                    the Goods Management queue shows for misc. */}
                <td className="cell-y px-4 font-bold text-[var(--ink)]">{line.qty}</td>
                <td className="cell-y px-4 text-[var(--ink)]">{line.issued}</td>
                <td className="cell-y px-4 text-[var(--ink)]">{isMisc ? "—" : line.used}</td>
                <td className="cell-y px-4 text-[var(--ink)]">
                  <div className="flex flex-col items-start gap-1">
                    <span>{isMisc ? "—" : line.returned}</span>
                    {!isMisc && line.returned > line.issued && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600" title="Returned here but issued from another warehouse">
                        <ArrowLeftRight className="h-2.5 w-2.5 shrink-0" />
                        {crossWarehouseReturnNote(line, job.kitLines)}
                      </span>
                    )}
                  </div>
                </td>
                <td className="cell-y px-4 font-bold text-[var(--ink)]">{isMisc ? "—" : line.remaining}</td>
                <td className="cell-y px-4 text-[var(--muted)]">{line.notes ?? "—"}</td>
              </tr>
              );
            })}
          </TableCard>
        )}
      </Card>

      {/* The card stays visible even when goods are reconciled — the engineer keeps their request
          HISTORY and sees a lock note instead of the button (silently removing the whole section
          reads as a bug). The "Request items" triggers live in the page header + card header. */}
      {showKitCard && (
        <EngineerKitRequests job={job} locked={kitLocked} open={kitOpen} onOpenChange={setKitOpen} />
      )}

      {job.notes ? (
        <Card title="Notes">
          <p className="whitespace-pre-wrap text-sm text-[var(--ink)]">{job.notes}</p>
        </Card>
      ) : null}

      {whModal && <WarehousePickupModal wh={whModal} onClose={() => setWhModal(null)} />}
    </div>
  );
}
