"use client";

// JobScanPanel — per-job scan panel for the Goods Management tab.
// Supports:
//   - Goods Out (issue): scan IRM/customer item → editable qty (capped at remainingIssuable) → Post
//   - Goods In (return): scan item → split the held qty into Good + Damaged portions (each its own
//     stepper, together ≤ held) → damaged portion requires a photo + reason → Post
//   - Close & Reconcile: surfaces any unaccounted items; confirms write-off if needed.

import * as React from "react";
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  ClipboardList,
  ImageUp,
  Loader2,
  PackageMinus,
  PackagePlus,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import * as gmService from "@/services/goodsManagement.service";
import { useDashboard } from "@/hooks/useDashboard";
import { readFileAsDataUrl } from "@/lib/image";
import { ScannerInput } from "./ScannerInput";
import type {
  MovementLinePayload,
  QueueKitLine,
  ScanMatch,
} from "@/types/goodsManagement";
import { inputCls, primaryBtn, secondaryBtn } from "@/components/ui/styles";
import { QtyStepper } from "@/components/ui/QtyStepper";

// ── Local types ───────────────────────────────────────────────────────────────

interface ScanLine {
  key: string; // stable unique key for React list
  match: ScanMatch;
  qty: number; // ISSUE: quantity to issue (unused on return)
  goodQty: number; // RETURN: good portion
  damagedQty: number; // RETURN: damaged portion
  damagePhotoDataUrl?: string; // data URI — kept for the preview image only
  damagePhotoUrl?: string; // Cloudinary-hosted URL sent to backend
  damagePhotoUploading?: boolean; // true while the upload is in flight
  damageReason?: string;
}

type Direction = "issue" | "return";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function lineKey(match: ScanMatch) {
  return match.irmItemId ?? match.customerStockEntryId ?? match.jobKitLineId ?? match.itemName;
}

// Total being returned for a line = good + damaged.
function returnTotal(l: ScanLine) {
  return l.goodQty + l.damagedQty;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function JobScanPanel({
  jobId,
  jobNumber,
  jobName,
  warehouseId,
  warehouseCode: _warehouseCode,
  miscLines = [],
  onBack,
}: {
  jobId: string;
  jobNumber: string;
  jobName: string;
  warehouseId: string;
  warehouseCode: string;
  miscLines?: QueueKitLine[]; // free-text kit lines — issued by count (no barcode)
  onBack: () => void;
}) {
  const { pushToast } = useDashboard();

  const [direction, setDirection] = React.useState<Direction>("issue");
  const [lines, setLines] = React.useState<ScanLine[]>([]);
  const [scanning, setScanning] = React.useState(false);
  const [posting, setPosting] = React.useState(false);
  const [reconciling, setReconciling] = React.useState(false);

  // Reconcile result
  const [unaccounted, setUnaccounted] = React.useState<
    { itemName: string; qty: number }[] | null
  >(null);
  const [writeOffConfirm, setWriteOffConfirm] = React.useState(false);

  // Damage-photo picker refs (one per line, managed by key via Map)
  const photoRefs = React.useRef<Map<string, HTMLInputElement>>(new Map());

  // ── Direction toggle clears the scan list ─────────────────────────────────
  const setDir = (d: Direction) => {
    setDirection(d);
    setLines([]);
    setUnaccounted(null);
  };

  // ── Scan handler ──────────────────────────────────────────────────────────
  // ⚠️ These scan rules are MIRRORED in van-requests/VanRequestDetail.tsx `onScan` (the non-job van
  // stock flow): in-flight guard → dead-scan message → re-scan bumps qty → otherwise stage a new line.
  // Its good/damaged split + evidence-clearing mirror `setPortion` below. The BEHAVIOUR is shared; the
  // CODE is not — VSR sits on a different document (a VSR line, not a job kit line) and has no
  // issue/return toggle or misc no-barcode lines, so a shared hook would leak. If you change the
  // scan/split rules HERE, change them THERE too. (ScannerInput itself is already shared by both.)
  const onCode = async (code: string) => {
    if (scanning) return;
    setScanning(true);
    try {
      const match = await gmService.scanLookup(jobId, direction, code, warehouseId);
      const isIssue = direction === "issue";

      // Nothing left to move for this item — block it here (before it can be added) with a clear
      // message, instead of letting the user build a line that the backend would reject on Post.
      const cap = isIssue ? match.remainingIssuable : match.heldByEngineer;
      if (cap <= 0) {
        pushToast(
          isIssue
            ? `${match.itemName} is already fully issued — nothing left to issue.`
            : `${match.itemName} has nothing left to return — the engineer isn't holding any.`,
          "alert",
        );
        return;
      }

      // Deduplicate: if the same item is already in the list, bump its qty (issue → qty,
      // return → the Good portion) instead of adding a second card.
      const existing = lines.find((l) => lineKey(l.match) === lineKey(match));
      if (existing) {
        setLines((prev) =>
          prev.map((l) => {
            if (lineKey(l.match) !== lineKey(match)) return l;
            if (isIssue) return { ...l, qty: clamp(l.qty + 1, 1, cap) };
            // Keep good + damaged ≤ held.
            return { ...l, goodQty: clamp(l.goodQty + 1, 0, cap - l.damagedQty) };
          }),
        );
      } else {
        setLines((prev) => [
          ...prev,
          {
            key: `${lineKey(match)}-${Date.now()}`,
            match,
            qty: isIssue ? Math.min(1, cap) : 0,
            goodQty: isIssue ? 0 : Math.min(1, cap),
            damagedQty: 0,
          },
        ]);
      }
    } catch (e) {
      pushToast(
        e instanceof Error ? e.message : "Could not look up that code.",
        "alert",
      );
    } finally {
      setScanning(false);
    }
  };

  // ── Line editing helpers ──────────────────────────────────────────────────
  const updateLine = (key: string, patch: Partial<ScanLine>) =>
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );

  const removeLine = (key: string) =>
    setLines((prev) => prev.filter((l) => l.key !== key));

  // Issue qty: clamp to 1..remainingIssuable.
  const setIssueQty = (key: string, next: number) =>
    setLines((prev) =>
      prev.map((l) =>
        l.key === key ? { ...l, qty: clamp(next, 1, l.match.remainingIssuable) } : l,
      ),
    );

  // Return portion (good/damaged): clamp to 0..(held − other portion). When the damaged portion
  // drops to 0, clear its photo/reason so a stale photo can't be posted.
  const setPortion = (key: string, field: "goodQty" | "damagedQty", next: number) =>
    setLines((prev) =>
      prev.map((l) => {
        if (l.key !== key) return l;
        const other = field === "goodQty" ? l.damagedQty : l.goodQty;
        const val = clamp(next, 0, Math.max(0, l.match.heldByEngineer - other));
        const patch: Partial<ScanLine> = { [field]: val };
        if (field === "damagedQty" && val === 0) {
          patch.damagePhotoDataUrl = undefined;
          patch.damagePhotoUrl = undefined;
          patch.damagePhotoUploading = undefined;
          patch.damageReason = undefined;
        }
        return { ...l, ...patch };
      }),
    );

  // ── Add a misc kit line (no barcode — issued by count) ────────────────────
  const addMisc = (k: QueueKitLine) => {
    const remaining = k.plannedQty - k.issuedQty;
    if (remaining <= 0) return;
    if (lines.some((l) => l.match.jobKitLineId === k.id)) {
      pushToast(`${k.itemName} is already in the list.`, "alert");
      return;
    }
    const match: ScanMatch = {
      source: "misc",
      jobKitLineId: k.id,
      itemName: k.itemName,
      uom: null,
      plannedQty: k.plannedQty,
      alreadyIssued: k.issuedQty,
      remainingIssuable: remaining,
      heldByEngineer: 0, // misc lines aren't stock-tracked, so they're never returned here
      available: 0,
    };
    setLines((prev) => [
      ...prev,
      { key: `misc-${k.id}-${Date.now()}`, match, qty: 1, goodQty: 0, damagedQty: 0 },
    ]);
  };

  // ── Damage photo pick ─────────────────────────────────────────────────────
  const onPhotoChange = async (
    key: string,
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so the same file can be re-picked if needed.
    const input = photoRefs.current.get(key);
    if (input) input.value = "";
    let dataUrl: string;
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch {
      pushToast("Could not read the photo.", "alert");
      return;
    }
    // Show preview immediately; mark upload in-flight.
    updateLine(key, {
      damagePhotoDataUrl: dataUrl,
      damagePhotoUrl: undefined,
      damagePhotoUploading: true,
    });
    try {
      const hostedUrl = await gmService.uploadDamagePhoto(dataUrl);
      updateLine(key, { damagePhotoUrl: hostedUrl, damagePhotoUploading: false });
    } catch (err) {
      // Clear the preview so the user knows the upload failed and must re-pick.
      updateLine(key, {
        damagePhotoDataUrl: undefined,
        damagePhotoUrl: undefined,
        damagePhotoUploading: false,
      });
      pushToast(
        err instanceof Error ? err.message : "Could not upload the damage photo.",
        "alert",
      );
    }
  };

  // Movement lines that WILL be posted (issue → one per line; return → up to two per line).
  const postLineCount =
    direction === "issue"
      ? lines.length
      : lines.reduce(
          (n, l) => n + (l.goodQty > 0 ? 1 : 0) + (l.damagedQty > 0 ? 1 : 0),
          0,
        );
  const canPost = direction === "issue" ? lines.length > 0 : postLineCount > 0;

  // ── Post movement ─────────────────────────────────────────────────────────
  const onPost = async () => {
    if (lines.length === 0) {
      pushToast("Scan at least one item.", "alert");
      return;
    }
    if (direction === "return") {
      for (const l of lines) {
        if (returnTotal(l) < 1) {
          pushToast(`${l.match.itemName}: set a return quantity (good and/or damaged).`, "alert");
          return;
        }
        if (l.damagedQty > 0) {
          if (l.damagePhotoUploading) {
            pushToast(`${l.match.itemName}: photo upload still in progress — please wait.`, "alert");
            return;
          }
          if (!l.damagePhotoUrl) {
            pushToast(`${l.match.itemName}: a damage photo is required for the damaged units.`, "alert");
            return;
          }
          if (!l.damageReason?.trim()) {
            pushToast(`${l.match.itemName}: a damage reason is required for the damaged units.`, "alert");
            return;
          }
        }
      }
    }
    setPosting(true);
    try {
      let payload: MovementLinePayload[];
      if (direction === "issue") {
        payload = lines.map((l) => ({
          source: l.match.source,
          irmItemId: l.match.irmItemId,
          customerStockEntryId: l.match.customerStockEntryId,
          jobKitLineId: l.match.jobKitLineId,
          qty: l.qty,
        }));
      } else {
        // Each returned item can split into a Good line and a Damaged line.
        payload = [];
        for (const l of lines) {
          const base = {
            source: l.match.source,
            irmItemId: l.match.irmItemId,
            customerStockEntryId: l.match.customerStockEntryId,
            jobKitLineId: l.match.jobKitLineId,
          };
          if (l.goodQty > 0) {
            payload.push({ ...base, qty: l.goodQty, condition: "good" });
          }
          if (l.damagedQty > 0) {
            payload.push({
              ...base,
              qty: l.damagedQty,
              condition: "damaged",
              damagePhotoUrl: l.damagePhotoUrl,
              damageReason: l.damageReason,
            });
          }
        }
      }

      if (direction === "issue") {
        await gmService.postIssue(jobId, { warehouseId, lines: payload });
        pushToast("Stock issued successfully.", "success");
      } else {
        await gmService.postReturn(jobId, { warehouseId, lines: payload });
        pushToast("Return posted successfully.", "success");
      }
      setLines([]);
    } catch (e) {
      pushToast(
        e instanceof Error ? e.message : "Could not post the movement.",
        "alert",
      );
    } finally {
      setPosting(false);
    }
  };

  // ── Close & reconcile ─────────────────────────────────────────────────────
  const onReconcile = async (writeOffLost = false) => {
    setReconciling(true);
    try {
      const result = await gmService.closeReconcile(jobId, writeOffLost || undefined);
      if (result.unaccounted.length > 0 && !writeOffLost) {
        setUnaccounted(result.unaccounted);
        setWriteOffConfirm(false);
      } else {
        pushToast("Job reconciled — stock balanced.", "success");
        onBack();
      }
    } catch (e) {
      pushToast(
        e instanceof Error ? e.message : "Could not reconcile this job.",
        "alert",
      );
    } finally {
      setReconciling(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Header — back to queue + the job this scan session is for */}
      <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xs">
        <button
          type="button"
          onClick={onBack}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Queue
        </button>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)]/10 text-[var(--accent)]">
            <ClipboardList className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-base font-extrabold tracking-tight text-[var(--ink)]">{jobNumber}</h2>
            <p className="truncate text-xs text-[var(--muted)]">{jobName}</p>
          </div>
        </div>
      </div>

      {/* Direction — segmented control: Goods Out (issue) vs Goods In (return) */}
      <div className="flex items-center gap-3">
        <span className="text-xs font-bold text-[var(--muted)]">Direction</span>
        <div className="inline-flex rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
          {(["issue", "return"] as const).map((d) => {
            const Icon = d === "issue" ? PackageMinus : PackagePlus;
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDir(d)}
                aria-pressed={direction === d}
                className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-bold transition-all ${
                  direction === d
                    ? "bg-[var(--accent)] text-white shadow-xs"
                    : "text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                <Icon className="h-4 w-4" />
                {d === "issue" ? "Goods Out (Issue)" : "Goods In (Return)"}
              </button>
            );
          })}
        </div>
      </div>

      {/* Scanner input */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="mb-3 text-[11px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
          Scan item
        </p>
        <ScannerInput
          onCode={onCode}
          disabled={posting || scanning}
          placeholder={
            direction === "issue"
              ? "Scan or type an IRM code / barcode to issue…"
              : "Scan or type an IRM code / barcode to return…"
          }
        />
        {scanning && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Looking up…
          </div>
        )}
      </div>

      {/* Scanned lines */}
      {lines.length > 0 && (
        <div className="space-y-3">
          <p className="text-[11px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
            Scanned items ({lines.length})
          </p>
          {lines.map((line) => {
            const held = line.match.heldByEngineer;
            const total = returnTotal(line);
            return (
              <div
                key={line.key}
                className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-[var(--ink)]">
                      {line.match.itemName}
                    </p>
                    <p className="text-xs text-[var(--muted)]">
                      {direction === "issue" ? (
                        <>
                          Planned:{" "}
                          <span className="font-semibold">
                            {line.match.plannedQty}
                          </span>
                          {" · "}Remaining:{" "}
                          <span
                            className={
                              line.match.remainingIssuable <= 0
                                ? "font-bold text-[var(--neg)]"
                                : "font-semibold"
                            }
                          >
                            {line.match.remainingIssuable}
                          </span>
                          {/* Misc lines have no stock — only real items show warehouse availability. */}
                          {line.match.source !== "misc" && (
                            <>
                              {" · "}Available:{" "}
                              <span
                                className={
                                  line.match.available <= 0
                                    ? "font-bold text-[var(--neg)]"
                                    : "font-semibold"
                                }
                              >
                                {line.match.available}
                              </span>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          Held:{" "}
                          <span className="font-semibold">{held}</span>
                        </>
                      )}
                    </p>
                  </div>

                  {/* Issue: single qty stepper in the header. Return: steppers move below. */}
                  <div className="flex shrink-0 items-center gap-1">
                    {direction === "issue" && (
                      <QtyStepper
                        value={line.qty}
                        min={1}
                        max={line.match.remainingIssuable}
                        onChange={(v) => setIssueQty(line.key, v)}
                        uom={line.match.uom}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => removeLine(line.key)}
                      className="ml-2 flex h-7 w-7 items-center justify-center rounded-lg text-[var(--faint)] transition-all hover:text-[var(--neg)]"
                      title="Remove line"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Return-only: split into Good + Damaged portions */}
                {direction === "return" && (
                  <div className="mt-3 space-y-2">
                    {/* Good portion */}
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
                      <span className="flex items-center gap-1.5 text-xs font-bold text-[var(--pos)]">
                        <CheckCircle2 className="h-4 w-4" />
                        Good
                      </span>
                      <QtyStepper
                        value={line.goodQty}
                        min={0}
                        max={held - line.damagedQty}
                        onChange={(v) => setPortion(line.key, "goodQty", v)}
                        uom={line.match.uom}
                      />
                    </div>

                    {/* Damaged portion */}
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-xs font-bold text-[var(--neg)]">
                          <Trash2 className="h-4 w-4" />
                          Damaged
                        </span>
                        <QtyStepper
                          value={line.damagedQty}
                          min={0}
                          max={held - line.goodQty}
                          onChange={(v) => setPortion(line.key, "damagedQty", v)}
                          uom={line.match.uom}
                        />
                      </div>

                      {/* Damage details — only when there are damaged units */}
                      {line.damagedQty > 0 && (
                        <div className="mt-2 ml-1 space-y-2 border-l-2 border-[var(--neg)] pl-3">
                          {/* Photo */}
                          <div>
                            <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                              Damage photo <span className="text-[var(--neg)]">*</span>
                            </p>
                            {line.damagePhotoDataUrl ? (
                              <div className="flex items-center gap-2">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={line.damagePhotoDataUrl}
                                  alt="Damage preview"
                                  className="h-16 w-24 rounded-lg object-cover border border-[var(--border)]"
                                />
                                {line.damagePhotoUploading ? (
                                  <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    Uploading…
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateLine(line.key, {
                                        damagePhotoDataUrl: undefined,
                                        damagePhotoUrl: undefined,
                                      })
                                    }
                                    className="flex items-center gap-1 text-[11px] font-bold text-[var(--neg)] hover:underline"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    Remove
                                  </button>
                                )}
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  photoRefs.current.get(line.key)?.click()
                                }
                                className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[11px] font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)]"
                              >
                                <Camera className="h-3.5 w-3.5" />
                                <ImageUp className="h-3.5 w-3.5" />
                                Attach photo
                              </button>
                            )}
                            {/* Hidden file input */}
                            <input
                              ref={(el) => {
                                if (el) photoRefs.current.set(line.key, el);
                                else photoRefs.current.delete(line.key);
                              }}
                              type="file"
                              accept="image/*"
                              className="hidden"
                              aria-hidden
                              tabIndex={-1}
                              onChange={(e) => onPhotoChange(line.key, e)}
                            />
                          </div>

                          {/* Reason */}
                          <div>
                            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                              Damage reason <span className="text-[var(--neg)]">*</span>
                            </label>
                            <input
                              type="text"
                              value={line.damageReason ?? ""}
                              onChange={(e) =>
                                updateLine(line.key, {
                                  damageReason: e.target.value,
                                })
                              }
                              placeholder="Describe the damage…"
                              className={inputCls}
                              maxLength={500}
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Total vs held helper */}
                    <p className="text-[11px] text-[var(--faint)]">
                      Returning{" "}
                      <span
                        className={
                          total === 0
                            ? "font-bold text-[var(--neg)]"
                            : "font-bold text-[var(--ink)]"
                        }
                      >
                        {total}
                      </span>{" "}
                      of <span className="font-semibold">{held}</span> held
                      {total === 0 ? " — set a quantity to return" : ""}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Misc items — free-text, no barcode; add by count (below the scanned list) */}
      {direction === "issue" &&
        miscLines.filter((k) => k.plannedQty - k.issuedQty > 0 && !lines.some((l) => l.match.jobKitLineId === k.id)).length > 0 && (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="mb-3 text-[11px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
              Misc items (no barcode — add by count)
            </p>
            <div className="space-y-2">
              {miscLines
                .filter((k) => k.plannedQty - k.issuedQty > 0 && !lines.some((l) => l.match.jobKitLineId === k.id))
                .map((k) => (
                  <div
                    key={k.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="font-bold text-[var(--ink)]">{k.itemName}</p>
                      <p className="text-xs text-[var(--muted)]">
                        Planned: <span className="font-semibold">{k.plannedQty}</span>
                        {" · "}Issued: <span className="font-semibold">{k.issuedQty}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => addMisc(k)}
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-extrabold text-white transition-all hover:opacity-90"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-3">
        {lines.length > 0 && (
          <button
            type="button"
            onClick={onPost}
            disabled={posting || !canPost}
            className={primaryBtn}
          >
            {posting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {posting
              ? "Posting…"
              : direction === "issue"
                ? `Post issue (${postLineCount} line${postLineCount !== 1 ? "s" : ""})`
                : `Post return (${postLineCount} line${postLineCount !== 1 ? "s" : ""})`}
          </button>
        )}

        {/* Close & reconcile — only on the Return side; it's the closing step after stock comes back. */}
        {direction === "return" && (
          <button
            type="button"
            onClick={() => onReconcile(false)}
            disabled={reconciling || posting}
            className={secondaryBtn}
          >
            {reconciling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Close &amp; Reconcile
          </button>
        )}
      </div>

      {/* Unaccounted items dialog */}
      {unaccounted !== null && unaccounted.length > 0 && (
        <div className="rounded-2xl border border-[var(--neg)] bg-[var(--surface)] p-5 space-y-3">
          <p className="text-sm font-extrabold text-[var(--neg)]">
            Unaccounted stock
          </p>
          <p className="text-xs text-[var(--muted)]">
            The following items were issued but not fully returned or consumed.
            You can write them off as lost or leave the job open.
          </p>
          <ul className="space-y-1">
            {unaccounted.map((u, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className="font-semibold text-[var(--ink)]">
                  {u.itemName}
                </span>
                <span className="text-[var(--neg)] font-bold">
                  {u.qty} unaccounted
                </span>
              </li>
            ))}
          </ul>
          {!writeOffConfirm ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setWriteOffConfirm(true)}
                className="rounded-xl bg-[var(--neg)] px-4 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90"
              >
                Write off as lost
              </button>
              <button
                type="button"
                onClick={() => setUnaccounted(null)}
                className={secondaryBtn}
              >
                Leave open
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-bold text-[var(--neg)]">
                Confirm: mark these {unaccounted.reduce((s, u) => s + u.qty, 0)}{" "}
                units as lost? This cannot be undone.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onReconcile(true)}
                  disabled={reconciling}
                  className="rounded-xl bg-[var(--neg)] px-4 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60"
                >
                  {reconciling ? (
                    <Loader2 className="inline h-3.5 w-3.5 animate-spin" />
                  ) : null}{" "}
                  Confirm write-off
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWriteOffConfirm(false);
                    setUnaccounted(null);
                  }}
                  className={secondaryBtn}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
