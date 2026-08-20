"use client";

import * as React from "react";
import { Loader2, Upload, Download, FileWarning } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { ghostBtn, primaryBtn } from "@/components/ui/styles";
import { useDashboard } from "@/hooks/useDashboard";
import {
  buildReportBlob, buildTemplateBlob, classifyRows, dedupeKey, mapColumns, parseSheet, validateRow,
  type PreviewRow,
} from "@/lib/siteImport";
import type { BulkSiteResult, CustomerSite } from "@/types/customer";

const BATCH_SIZE = 500;
const MAX_ROWS = 5000;

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Defer revoke a tick — revoking synchronously after click() cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

type Result = { created: number; skipped: number; failed: number };

export function SiteImportModal({
  customerId,
  onClose,
  onImported,
}: {
  customerId: string;
  onClose: () => void;
  onImported: (created: CustomerSite[]) => void;
}) {
  const { pushToast } = useDashboard();
  const [step, setStep] = React.useState<"upload" | "preview" | "result">("upload");
  const [fileName, setFileName] = React.useState("");
  const [rows, setRows] = React.useState<PreviewRow[]>([]);
  const [parsing, setParsing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [result, setResult] = React.useState<Result | null>(null);
  // Rows overlaid with the SERVER's outcome (a row the client sent as "new" that the backend
  // then failed/skipped is re-tagged), so the downloaded report reflects what actually saved.
  const [reportRows, setReportRows] = React.useState<PreviewRow[]>([]);

  // Dedupe keys come from the LEAN site-keys endpoint (name + postcode only) — never the full
  // site rows: a bulk-imported customer can have thousands. The server re-checks on import, so a
  // key set that's still loading only affects the PREVIEW labels, never what actually saves.
  const [existingKeys, setExistingKeys] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    let active = true;
    customerService
      .getCustomerSiteKeys(customerId)
      .then((keys) => { if (active) setExistingKeys(new Set(keys.map((k) => dedupeKey(k.name, k.postcode ?? "")))); })
      .catch(() => { /* preview-only — the server's own dedupe still applies on import */ });
    return () => { active = false; };
  }, [customerId]);

  const counts = React.useMemo(() => ({
    total: rows.length,
    new: rows.filter((r) => r.status === "new").length,
    duplicate: rows.filter((r) => r.status === "duplicate").length,
    error: rows.filter((r) => r.status === "error").length,
  }), [rows]);

  const onFile = async (file: File) => {
    setError(null);
    setParsing(true);
    try {
      const raw = await parseSheet(file);
      if (raw.length === 0) { setError("That sheet has no rows."); return; }
      if (raw.length > MAX_ROWS) { setError(`Too many rows (${raw.length}). Split the file into chunks of ${MAX_ROWS} or fewer.`); return; }
      const drafts = raw.map(mapColumns);
      if (drafts.every((d) => !d.name)) { setError("No 'name' column found — download the template and match the headers."); return; }
      setFileName(file.name);
      setRows(classifyRows(drafts, existingKeys));
      setStep("preview");
    } catch {
      setError("Couldn't read that file. Use .xlsx, .xls or .csv.");
    } finally {
      setParsing(false);
    }
  };

  const runImport = async () => {
    // Send each valid "new" row WITH its 1-based sheet row number so the server's per-row
    // notes point back at the user's file.
    const payloads = rows.flatMap((r) => {
      if (r.status !== "new") return [];
      const v = validateRow(r.draft);
      return v.ok ? [{ ...v.value, rowNumber: r.rowNumber }] : [];
    });
    if (payloads.length === 0) return;
    setImporting(true);
    setError(null);
    setProgress({ done: 0, total: payloads.length });
    const agg: Result = { created: 0, skipped: counts.duplicate, failed: counts.error };
    const allCreated: CustomerSite[] = [];
    // Server outcomes keyed by sheet row number, to overlay onto the report.
    const serverOutcome = new Map<number, { status: "error" | "duplicate"; reason: string }>();
    try {
      for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
        const batch = payloads.slice(i, i + BATCH_SIZE);
        const res: BulkSiteResult = await customerService.bulkAddSites(customerId, batch, fileName);
        allCreated.push(...res.createdSites);
        agg.created += res.createdSites.length;
        agg.skipped += res.skipped.length;
        agg.failed += res.failed.length;
        for (const n of res.failed) serverOutcome.set(n.row, { status: "error", reason: n.reason });
        for (const n of res.skipped) serverOutcome.set(n.row, { status: "duplicate", reason: n.reason });
        setProgress({ done: Math.min(i + BATCH_SIZE, payloads.length), total: payloads.length });
      }
      setReportRows(overlay(rows, serverOutcome));
      setResult(agg);
      setStep("result");
      onImported(allCreated);
      pushToast(`Imported ${agg.created} site${agg.created === 1 ? "" : "s"}.`, "success");
    } catch (e) {
      // Partial failure: surface what DID save so the sites list reflects it, and let the
      // user retry the rest (re-upload skips the already-created rows as duplicates).
      if (allCreated.length) onImported(allCreated);
      setError(e instanceof Error ? e.message : "Import failed part-way. The sites that saved are shown; re-upload to retry the rest (duplicates are skipped).");
    } finally {
      setImporting(false);
    }
  };

  const footer =
    step === "upload" ? (
      <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
    ) : step === "preview" ? (
      <>
        <button type="button" onClick={onClose} disabled={importing} className={ghostBtn}>Cancel</button>
        <button type="button" onClick={runImport} disabled={importing || counts.new === 0} className={primaryBtn}>
          {importing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Import {counts.new} new site{counts.new === 1 ? "" : "s"}
        </button>
      </>
    ) : (
      <button type="button" onClick={onClose} className={primaryBtn}>Done</button>
    );

  return (
    <Modal
      open
      title="Import sites"
      subtitle="Upload an Excel/CSV sheet of sites for this customer."
      onClose={importing ? () => {} : onClose}
      footer={footer}
    >
      {step === "upload" && (
        <div className="space-y-4">
          <button type="button" onClick={async () => downloadBlob(await buildTemplateBlob(), "site-import-template.xlsx")} className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--accent)] hover:opacity-80">
            <Download className="h-3.5 w-3.5" /> Download template
          </button>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface-2)]/30 p-8 text-center hover:border-[var(--accent)]">
            {parsing ? <Loader2 className="h-6 w-6 animate-spin text-[var(--accent)]" /> : <Upload className="h-6 w-6 text-[var(--muted)]" />}
            <span className="text-sm font-semibold text-[var(--ink)]">{parsing ? "Reading…" : "Choose a .xlsx, .xls or .csv file"}</span>
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" disabled={parsing}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
          </label>
          <p className="text-[11px] text-[var(--faint)]">Columns: name (required), addressLine1, addressLine2, city, county, postcode, country, contactPerson, contactNumber, status. Postcode is geocoded on save.</p>
          {error && <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--neg)]"><FileWarning className="h-4 w-4 shrink-0" />{error}</p>}
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <span className="rounded-lg bg-[var(--pos)]/10 px-2.5 py-1 text-[var(--pos)]">{counts.new} new</span>
            <span className="rounded-lg bg-[var(--surface-2)] px-2.5 py-1 text-[var(--muted)]">{counts.duplicate} skip (exists)</span>
            <span className="rounded-lg bg-[var(--neg)]/10 px-2.5 py-1 text-[var(--neg)]">{counts.error} error</span>
          </div>
          <div className="max-h-[46vh] overflow-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 z-10 bg-[var(--surface-2)] text-[var(--faint)]">
                <tr><th className="px-2 py-1.5">#</th><th className="px-2 py-1.5">Name</th><th className="px-2 py-1.5">Postcode</th><th className="px-2 py-1.5">Status</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.rowNumber} className="border-t border-[var(--border)]">
                    <td className="px-2 py-1.5 text-[var(--faint)]">{r.rowNumber}</td>
                    <td className="px-2 py-1.5 text-[var(--ink)]">{r.draft.name || <span className="text-[var(--faint)]">—</span>}</td>
                    <td className="px-2 py-1.5 text-[var(--muted)]">{r.draft.postcode || "—"}</td>
                    <td className="px-2 py-1.5">
                      {r.status === "new" && <span className="font-bold text-[var(--pos)]">New</span>}
                      {r.status === "duplicate" && <span className="text-[var(--muted)]" title={r.reason}>Skip</span>}
                      {r.status === "error" && <span className="font-bold text-[var(--neg)]" title={r.reason}>Error</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {importing && <p className="text-xs text-[var(--muted)]">Importing… {progress.done}/{progress.total}</p>}
          {error && <p className="text-[13px] font-semibold text-[var(--neg)]">{error}</p>}
        </div>
      )}

      {step === "result" && result && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            <Stat label="Added" value={result.created} tone="text-[var(--pos)]" />
            <Stat label="Skipped" value={result.skipped} tone="text-[var(--muted)]" />
            <Stat label="Errors" value={result.failed} tone="text-[var(--neg)]" />
          </div>
          <button type="button" onClick={async () => downloadBlob(await buildReportBlob(reportRows.length ? reportRows : rows), "site-import-report.xlsx")} className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--accent)] hover:opacity-80">
            <Download className="h-3.5 w-3.5" /> Download report
          </button>
        </div>
      )}
    </Modal>
  );
}

// Re-tag client preview rows with the server's actual outcome (by sheet row number) so the
// downloaded report tells the truth: a client "new" row the backend failed/skipped is flipped.
function overlay(rows: PreviewRow[], serverOutcome: Map<number, { status: "error" | "duplicate"; reason: string }>): PreviewRow[] {
  if (serverOutcome.size === 0) return rows;
  return rows.map((r) => {
    const o = serverOutcome.get(r.rowNumber);
    return o ? { ...r, status: o.status, reason: o.reason } : r;
  });
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
      <div className={`text-2xl font-extrabold ${tone}`}>{value}</div>
      <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</div>
    </div>
  );
}
