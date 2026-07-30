"use client";

// ReportDamageModal — move units of stock that is ALREADY SITTING in a warehouse into the damaged
// pool. Used from both inventory pools: Company (IRM) rows and Customer consignment rows.
//
// Before this existed the damaged pool could only be fed by a field return (a job return or a van
// return), so damage found in our own racking had no correct action and operators reached for
// Adjust Stock → "damage correction", which removed the units and recorded no evidence at all.
//
// Reason AND photo are both required here, matching a damaged return line exactly. That is the
// point of the pool — the photo is what a supplier claim, an insurance claim or a customer dispute
// actually rests on — so this entry point is not allowed to be the cheap one.

import * as React from "react";
import Image from "next/image";
import { Camera, Loader2, Trash2 } from "lucide-react";

import * as gmService from "@/services/goodsManagement.service";
import { MAX_IMAGE_BYTES, readFileAsDataUrl } from "@/lib/image";
import { clampQuantityInput } from "@/lib/quantity";
import { useDashboard } from "@/hooks/useDashboard";
import { Modal } from "@/components/ui/Modal";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { Notice } from "@/components/ui/Notice";
import { NumberInput } from "@/components/ui/NumberInput";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";

export interface ReportDamageTarget {
  warehouseId: string;
  ownerType: "company" | "customer";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  /** Units currently available to damage — the modal never lets the user exceed it. */
  available: number;
}

export function ReportDamageModal({
  target,
  onClose,
  onReported,
}: {
  target: ReportDamageTarget | null;
  onClose: () => void;
  onReported: () => void;
}) {
  const { pushToast } = useDashboard();
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Held as a STRING like every other numeric field in this codebase: a number state would turn
  // into NaN the moment the field is cleared mid-edit.
  const [quantity, setQuantity] = React.useState("1");
  const [reason, setReason] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [photoPreview, setPhotoPreview] = React.useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  // Reset the form whenever a DIFFERENT row is opened (and on close, so reopening starts clean).
  // Carrying a half-filled damage report over onto another item is the kind of mistake that ends up
  // in an insurance file, so this resets on identity, not just on open/close.
  //
  // Adjusted DURING RENDER — React's documented "reset state when a prop changes" pattern, and the
  // same one InventoryView uses for its warehouse prop. An effect doing this would fire a second
  // commit and trip the React-Compiler lint (setState synchronously inside an effect body).
  const targetKey = target ? `${target.warehouseId}|${target.irmItemId ?? target.customerStockEntryId}` : null;
  const [prevTargetKey, setPrevTargetKey] = React.useState(targetKey);
  if (targetKey !== prevTargetKey) {
    setPrevTargetKey(targetKey);
    setQuantity("1");
    setReason("");
    setNotes("");
    setPhotoPreview(null);
    setPhotoUrl(null);
    setUploading(false);
    setMsg(null);
  }

  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = ""; // let the same file be re-picked after a failure
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      pushToast("That photo is over 2 MB — pick a smaller one.", "alert");
      return;
    }
    let dataUrl: string;
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch {
      pushToast("Could not read the photo.", "alert");
      return;
    }
    setPhotoPreview(dataUrl); // show it immediately; the hosted URL lands when the upload returns
    setPhotoUrl(null);
    setUploading(true);
    try {
      setPhotoUrl(await gmService.uploadDamagePhoto(dataUrl));
    } catch (err) {
      // Clear the preview too, so "there's a photo on screen" can never mean "a photo was saved".
      setPhotoPreview(null);
      pushToast(err instanceof Error ? err.message : "Could not upload the damage photo.", "alert");
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!target || saving) return;
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > target.available) {
      setMsg({ type: "error", text: `Enter a whole quantity between 1 and ${target.available}.` });
      return;
    }
    if (!reason.trim()) {
      setMsg({ type: "error", text: "Give a reason for the damage." });
      return;
    }
    if (!photoUrl) {
      setMsg({ type: "error", text: uploading ? "Wait for the photo to finish uploading." : "Attach a photo of the damage." });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      await gmService.reportDamage({
        warehouseId: target.warehouseId,
        ownerType: target.ownerType,
        irmItemId: target.irmItemId,
        customerStockEntryId: target.customerStockEntryId,
        quantity: qty,
        reason: reason.trim(),
        damagePhotoUrl: photoUrl,
        notes: notes.trim() || undefined,
      });
      pushToast(`${qty} × ${target.itemName} moved to damaged stock.`, "success");
      onReported();
      onClose();
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not report the damage." });
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || uploading;
  // Upper bound for the quantity field. Falls back to 1 only while the modal is closed (no target).
  const max = target?.available ?? 1;

  return (
    <Modal
      open={target !== null}
      title="Report damage"
      subtitle={target ? `${target.itemName} · ${target.available} available` : undefined}
      onClose={busy ? () => {} : onClose}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          {/* ghostBtn + primaryBtn is this app's modal footer pairing (23 modals use it; secondaryBtn
              is footer scale for full-page forms and appeared in exactly one modal — this one). */}
          <button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={submit} disabled={busy}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Move to damaged
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <Notice msg={msg} />

        {/* ONE line, and only the consequence. The reason and photo being kept on record is already
            obvious from the two required fields directly below, and "restorable later" is detail for
            the Damaged tab (where Restore actually lives), not for the moment of reporting. */}
        <p className="text-xs text-[var(--muted)]">
          These units leave usable stock and move into the damaged pool.
        </p>

        <div>
          <label className={labelCls}>
            Quantity damaged <RequiredMark />
          </label>
          <NumberInput
            value={quantity}
            // CLAMP AS YOU TYPE rather than complaining after submit — the same pattern the van
            // request and job scan panels use for their capped quantities. Typing 999 against 1
            // available simply lands on 1; an out-of-range number never sits in the box at all.
            // "" is allowed through so the field can be cleared and retyped mid-edit; submit still
            // rejects an empty value, which is now the only way to fail this field.
            onChange={(e) => {
              const next = clampQuantityInput(e.target.value, max);
              if (next !== null) setQuantity(next);
            }}
            min={1}
            max={max}
            step={1}
            className={inputCls}
          />
        </div>

        <div>
          <label className={labelCls}>
            Reason <RequiredMark />
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="e.g. Crushed by forklift in aisle 3"
            className={inputCls}
          />
        </div>

        <div>
          <label className={labelCls}>
            Photo of the damage <RequiredMark />
          </label>
          {/* Styling matches the two existing damage-photo captures (JobScanPanel and
              VanRequestDetail) exactly: a small bordered "Attach photo" with the camera/upload pair,
              and a plain red text-link "Remove" — NOT a boxed button. It was using secondaryBtn,
              which is explicitly "sized to sit beside primaryBtn" (i.e. footer scale), so it towered
              over an 80px thumbnail and read as a third primary action.
              ONE icon on Attach, though: those panels pair Camera+ImageUp because they sit in dense
              inline rows where the glyphs carry the whole affordance. Here there's an explicit label
              directly above the button, so a second icon is just clutter. */}
          {photoPreview ? (
            <div className="flex items-center gap-3">
              <div className="relative h-20 w-20 overflow-hidden rounded-lg border border-[var(--border)]">
                {/* h-full w-full, NOT h-20 w-20. The wrapper is 80px OUTER, so its 1px border leaves
                    a 78px content box — and Tailwind preflight's `img { max-width: 100% }` then
                    clamps the width to 78 while h-20 held the height at 80. next/image compares the
                    rendered size against the width/height attributes and warns when exactly one
                    differs, which is the dev warning this produced. Filling the content box keeps
                    both dimensions consistent. */}
                <Image src={photoPreview} alt="Damage photo" width={80} height={80} className="h-full w-full object-cover" unoptimized />
                {uploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <Loader2 className="h-5 w-5 animate-spin text-white" />
                  </div>
                )}
              </div>
              {uploading ? (
                <span className="text-[11px] font-bold text-[var(--muted)]">Uploading…</span>
              ) : (
                <button
                  type="button"
                  className="flex items-center gap-1 text-[11px] font-bold text-[var(--neg)] transition-colors hover:underline disabled:opacity-60"
                  disabled={busy}
                  onClick={() => { setPhotoPreview(null); setPhotoUrl(null); }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </button>
              )}
            </div>
          ) : (
            <button type="button" className={ghostBtn} disabled={busy} onClick={() => fileRef.current?.click()}>
              <Camera className="h-3.5 w-3.5" />
              Attach photo
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" className="hidden" aria-hidden tabIndex={-1} onChange={onPickPhoto} />
        </div>

        <div>
          <label className={labelCls}>Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Optional — anything else worth recording."
            className={inputCls}
          />
        </div>
      </div>
    </Modal>
  );
}
