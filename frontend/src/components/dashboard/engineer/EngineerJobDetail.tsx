"use client";

import * as React from "react";
import { CheckCircle2, MapPin, ExternalLink, X, XCircle } from "lucide-react";

import * as engineerService from "@/services/engineer.service";
import { Notice } from "@/components/ui/Notice";
import { ghostBtn, primaryBtn } from "@/components/ui/styles";
import { fmtDate, JobStatusChip, PortalHeader, TableCard } from "@/components/dashboard/portal/portalUi";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import type { Job, JobKitLine, JobKitWarehouse } from "@/types/job";
import type { Msg } from "@/components/ui/types";

// Engineer Portal — single assigned job. Loads the engineer's own job by id, shows the
// identification / site / schedule cards + kit list, and an Accept button (only while the job is
// "assigned"). Accept POSTs and replaces local state with the server's returned job, so the status
// pill and the button reflect the real transition — the backend is the authority.

const KIT_HEADERS = ["Item", "SE code", "Type", "Warehouse", "Qty", "Notes"];

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

export function EngineerJobDetail({ id }: { id: string }) {
  const [job, setJob] = React.useState<Job | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<Msg>(null);
  const [accepting, setAccepting] = React.useState(false);
  const [rejecting, setRejecting] = React.useState(false);
  const [rejectMode, setRejectMode] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState("");
  const busy = accepting || rejecting;
  const [whModal, setWhModal] = React.useState<JobKitWarehouse | null>(null);

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

  const onAccept = async () => {
    setAccepting(true);
    setMsg(null);
    try {
      const updated = await engineerService.acceptOwnJob(id);
      setJob(updated); // replace with server truth (status now "accepted")
      setMsg({ type: "success", text: "Job accepted." });
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not accept this job." });
    } finally {
      setAccepting(false);
    }
  };

  const onReject = async () => {
    setRejecting(true);
    setMsg(null);
    try {
      const updated = await engineerService.rejectOwnJob(id, rejectReason.trim() || undefined);
      setJob(updated); // status now "rejected"
      setRejectMode(false);
      setRejectReason("");
      setMsg({ type: "success", text: "Job rejected. The project manager has been notified." });
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not reject this job." });
    } finally {
      setRejecting(false);
    }
  };

  if (loading) return <FormPageSkeleton />;
  if (error || !job) return <FormError message={error ?? "Job not found."} />;

  const canAccept = job.status === "assigned";
  const addressLines = [job.address, job.postcode].filter(Boolean).join(", ");
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
          ) : (
            <JobStatusChip value={job.status} />
          )
        }
      />
      {msg && <Notice msg={msg} />}

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

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Identification">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Job number" value={job.jobNumber} />
            <Field label="Status" value={<JobStatusChip value={job.status} />} />
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
            <Field label="Address" value={addressLines} />
            <Field label="Location" value={fixings} />
          </div>
        </Card>

        <Card title="Schedule">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Completion date" value={fmtDate(job.completionDate)} />
            <Field label="Assigned" value={fmtDate(job.assignedAt)} />
            <Field label="Accepted" value={fmtDate(job.acceptedAt)} />
            <Field label="Accepted by" value={job.acceptedBy} />
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
        {job.kitLines.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No kit lines on this job.</p>
        ) : (
          <TableCard headers={KIT_HEADERS} minWidth={760}>
            {job.kitLines.map((line) => (
              <tr key={line.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-4 py-3 font-semibold text-[var(--ink)]">
                  {line.itemName}
                  {line.description ? (
                    <span className="block text-xs font-normal text-[var(--muted)]">{line.description}</span>
                  ) : null}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{line.seCode ?? "—"}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{LINE_TYPE_LABEL[line.lineType] ?? line.lineType}</td>
                <td className="px-4 py-3">
                  {line.warehouse ? (
                    <button type="button" onClick={() => setWhModal(line.warehouse)} className="inline-flex max-w-[200px] items-center gap-1 font-semibold text-[var(--accent)] hover:underline" title="View pickup address">
                      <MapPin className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{line.warehouse.name}</span>
                    </button>
                  ) : (
                    <span className="font-semibold text-[var(--ink)]">{line.warehouseName ?? "—"}</span>
                  )}
                </td>
                <td className="px-4 py-3 font-bold text-[var(--ink)]">{line.qty}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{line.notes ?? "—"}</td>
              </tr>
            ))}
          </TableCard>
        )}
      </Card>

      {job.notes ? (
        <Card title="Notes">
          <p className="whitespace-pre-wrap text-sm text-[var(--ink)]">{job.notes}</p>
        </Card>
      ) : null}

      {whModal && <WarehouseModal wh={whModal} onClose={() => setWhModal(null)} />}
    </div>
  );
}

// Pickup-warehouse address modal — opened from a kit line so the engineer can see exactly where to
// collect the item and jump straight to maps/phone. The address is the warehouse's LIVE record
// (delivered on the job; the engineer has no warehouse-module access).
function WarehouseModal({ wh, onClose }: { wh: JobKitWarehouse; onClose: () => void }) {
  const addressParts = [wh.addressLine1, wh.addressLine2, wh.city, wh.county, wh.postcode, wh.country].filter(Boolean) as string[];
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([wh.name, ...addressParts].join(", "))}`;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-extrabold text-[var(--ink)]">
              <MapPin className="h-4 w-4 shrink-0 text-[var(--accent)]" />
              <span className="truncate">{wh.name}</span>
            </h3>
            <p className="mt-0.5 font-mono text-[11px] text-[var(--faint)]">{wh.code}</p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded-lg p-1 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3 text-sm">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Pickup address</p>
            {addressParts.length > 0 ? (
              <address className="mt-1 not-italic leading-relaxed text-[var(--ink)]">
                {addressParts.map((p, i) => (
                  <span key={i} className="block">{p}</span>
                ))}
              </address>
            ) : (
              <p className="mt-1 text-[var(--muted)]">No address on file for this warehouse.</p>
            )}
          </div>
          {wh.contactPhone && (
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Contact</p>
              <a href={`tel:${wh.contactPhone}`} className="mt-1 block font-semibold text-[var(--accent)] hover:underline">{wh.contactPhone}</a>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>Close</button>
          {addressParts.length > 0 && (
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className={primaryBtn}>
              <ExternalLink className="h-4 w-4" /> Open in Maps
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
