"use client";

// JobScanPanel — per-job scan panel for the Goods Management tab.
// Supports:
//   - Goods Out (issue): scan IRM/customer item → editable qty (capped at remainingIssuable) → Post
//   - Goods In (return): scan item → per-line good/damaged toggle → damaged requires photo + reason → Post
//   - Close & Reconcile: surfaces any unaccounted items; confirms write-off if needed.

import * as React from "react";
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  ImageUp,
  Loader2,
  Minus,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import * as gmService from "@/services/goodsManagement.service";
import { useDashboard } from "@/hooks/useDashboard";
import { readFileAsDataUrl } from "@/lib/image";
import { ScannerInput } from "./ScannerInput";
import type {
  LineCondition,
  MovementLinePayload,
  ScanMatch,
} from "@/types/goodsManagement";
import { inputCls, primaryBtn, secondaryBtn } from "@/components/ui/styles";

// ── Local types ───────────────────────────────────────────────────────────────

interface ScanLine {
  key: string; // stable unique key for React list
  match: ScanMatch;
  qty: number;
  condition: LineCondition;
  damagePhotoDataUrl?: string; // data URI before upload
  damagePhotoUrl?: string; // final value sent to backend
  damageReason?: string;
}

type Direction = "issue" | "return";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function lineKey(match: ScanMatch) {
  return match.irmItemId ?? match.customerStockEntryId ?? match.itemName;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function JobScanPanel({
  jobId,
  jobNumber,
  jobName,
  warehouseId,
  warehouseCode: _warehouseCode,
  onBack,
}: {
  jobId: string;
  jobNumber: string;
  jobName: string;
  warehouseId: string;
  warehouseCode: string;
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

  // Damage-photo picker refs (one per line, managed by index via Map)
  const photoRefs = React.useRef<Map<string, HTMLInputElement>>(new Map());

  // ── Direction toggle clears the scan list ─────────────────────────────────
  const setDir = (d: Direction) => {
    setDirection(d);
    setLines([]);
    setUnaccounted(null);
  };

  // ── Scan handler ──────────────────────────────────────────────────────────
  const onCode = async (code: string) => {
    if (scanning) return;
    setScanning(true);
    try {
      const match = await gmService.scanLookup(jobId, direction, code);

      // Deduplicate: if the same item is already in the list, increment qty.
      const existing = lines.find(
        (l) => lineKey(l.match) === lineKey(match),
      );
      if (existing) {
        setLines((prev) =>
          prev.map((l) =>
            lineKey(l.match) === lineKey(match)
              ? {
                  ...l,
                  qty: clamp(
                    l.qty + 1,
                    1,
                    direction === "issue"
                      ? match.remainingIssuable
                      : match.alreadyIssued,
                  ),
                }
              : l,
          ),
        );
      } else {
        const maxQty =
          direction === "issue"
            ? match.remainingIssuable
            : match.alreadyIssued;
        setLines((prev) => [
          ...prev,
          {
            key: `${lineKey(match)}-${Date.now()}`,
            match,
            qty: Math.min(1, maxQty),
            condition: "good",
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

  const changeQty = (key: string, delta: number) =>
    setLines((prev) =>
      prev.map((l) => {
        if (l.key !== key) return l;
        const max =
          direction === "issue"
            ? l.match.remainingIssuable
            : l.match.alreadyIssued;
        return { ...l, qty: clamp(l.qty + delta, 1, max) };
      }),
    );

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
    try {
      const dataUrl = await readFileAsDataUrl(file);
      updateLine(key, {
        damagePhotoDataUrl: dataUrl,
        damagePhotoUrl: dataUrl, // send data URI; backend handles Cloudinary upload
      });
    } catch {
      pushToast("Could not read the photo.", "alert");
    }
  };

  // ── Post movement ─────────────────────────────────────────────────────────
  const onPost = async () => {
    if (lines.length === 0) {
      pushToast("Scan at least one item.", "alert");
      return;
    }
    // Validate damage lines.
    for (const l of lines) {
      if (direction === "return" && l.condition === "damaged") {
        if (!l.damagePhotoUrl) {
          pushToast(`${l.match.itemName}: a damage photo is required.`, "alert");
          return;
        }
        if (!l.damageReason?.trim()) {
          pushToast(`${l.match.itemName}: a damage reason is required.`, "alert");
          return;
        }
      }
    }
    setPosting(true);
    try {
      const payload: MovementLinePayload[] = lines.map((l) => ({
        source: l.match.source,
        irmItemId: l.match.irmItemId,
        customerStockEntryId: l.match.customerStockEntryId,
        jobKitLineId: l.match.jobKitLineId,
        qty: l.qty,
        condition: direction === "return" ? l.condition : undefined,
        damagePhotoUrl:
          direction === "return" && l.condition === "damaged"
            ? l.damagePhotoUrl
            : undefined,
        damageReason:
          direction === "return" && l.condition === "damaged"
            ? l.damageReason
            : undefined,
      }));

      if (direction === "issue") {
        await gmService.postIssue(jobId, { lines: payload });
        pushToast("Stock issued successfully.", "success");
      } else {
        await gmService.postReturn(jobId, { lines: payload });
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
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Queue
        </button>
        <div className="min-w-0">
          <h2 className="text-sm font-extrabold text-[var(--ink)]">
            {jobNumber}
          </h2>
          <p className="truncate text-xs text-[var(--muted)]">{jobName}</p>
        </div>
      </div>

      {/* Goods In / Out toggle */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-[var(--muted)]">Direction:</span>
        {(["issue", "return"] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDir(d)}
            className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition-all ${
              direction === d
                ? "bg-[var(--accent)] text-white"
                : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            {d === "issue" ? "Goods Out (Issue)" : "Goods In (Return)"}
          </button>
        ))}
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
            const maxQty =
              direction === "issue"
                ? line.match.remainingIssuable
                : line.match.alreadyIssued;
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
                      ) : (
                        <>
                          Issued:{" "}
                          <span className="font-semibold">
                            {line.match.alreadyIssued}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  {/* Qty stepper */}
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => changeQty(line.key, -1)}
                      disabled={line.qty <= 1}
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-40"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={maxQty}
                      value={line.qty}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (!Number.isNaN(v)) {
                          updateLine(line.key, { qty: clamp(v, 1, maxQty) });
                        }
                      }}
                      className="w-16 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-center text-sm font-bold text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                    />
                    <button
                      type="button"
                      onClick={() => changeQty(line.key, 1)}
                      disabled={line.qty >= maxQty}
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-40"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                    <span className="ml-1 text-xs text-[var(--faint)]">
                      {line.match.uom ?? ""}
                    </span>
                    {/* Remove */}
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

                {/* Return-only: condition toggle */}
                {direction === "return" && (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                        Condition:
                      </span>
                      {(["good", "damaged"] as const).map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() =>
                            updateLine(line.key, {
                              condition: c,
                              // Clear damage fields if switching back to good.
                              damagePhotoUrl:
                                c === "good" ? undefined : line.damagePhotoUrl,
                              damagePhotoDataUrl:
                                c === "good"
                                  ? undefined
                                  : line.damagePhotoDataUrl,
                              damageReason:
                                c === "good" ? undefined : line.damageReason,
                            })
                          }
                          className={`rounded-full px-3 py-1 text-[11px] font-bold transition-all ${
                            line.condition === c
                              ? c === "good"
                                ? "bg-[var(--pos)] text-white"
                                : "bg-[var(--neg)] text-white"
                              : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
                          }`}
                        >
                          {c === "good" ? "Good" : "Damaged"}
                        </button>
                      ))}
                    </div>

                    {/* Damage details */}
                    {line.condition === "damaged" && (
                      <div className="ml-2 space-y-2 border-l-2 border-[var(--neg)] pl-3">
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
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                photoRefs.current.get(line.key)?.click()
                              }
                              className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[11px] font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)]"
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
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-3">
        {lines.length > 0 && (
          <button
            type="button"
            onClick={onPost}
            disabled={posting}
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
                ? `Post issue (${lines.length} line${lines.length !== 1 ? "s" : ""})`
                : `Post return (${lines.length} line${lines.length !== 1 ? "s" : ""})`}
          </button>
        )}

        {/* Close & reconcile */}
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
