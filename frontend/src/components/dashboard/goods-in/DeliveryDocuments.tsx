"use client";

import * as React from "react";
import { FileText, Loader2, Trash2, Upload } from "lucide-react";

import { useDashboard } from "@/hooks/useDashboard";
import { shrinkImage } from "@/lib/image";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import type { GrnAttachment } from "@/types/goods-in";
import { isImageType, resolveDocType, stageFiles, UNTYPED_IMAGE } from "./docPicker";

// Shared delivery-document UI for the GRN form + detail. Limits MIRROR the backend
// source of truth in backend/src/modules/goods-in/goods-in.validation.ts — keep in sync.
export const GRN_DOC_MAX_COUNT = 5;
export const GRN_DOC_MAX_BYTES = 5 * 1024 * 1024; // 5 MB / file
export const GRN_DOC_MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB total
export const GRN_DOC_ACCEPT = ".pdf,.docx,.png,.jpg,.jpeg";

// The type map and the multi-pick accumulator live in ./docPicker so they can be tested — both were
// inline here, and both were written for the goods receipt and then silently reused by the hire
// photo picker, which advertises a wider set of types and a much larger cap.
const isImage = isImageType;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

// A unified shape the grid renders — works for a saved attachment (src = Cloudinary url)
// or a not-yet-uploaded staged file (src = an in-memory object URL).
export interface DocItem {
  id: string;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  src: string;
}

export function attachmentToDoc(a: GrnAttachment): DocItem {
  return { id: a.id, fileName: a.fileName, fileType: a.fileType, fileSizeBytes: a.fileSizeBytes, src: a.url };
}

export interface PickedDoc {
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  /** The file itself. Every caller now uploads it directly to Cloudinary — see onPickDoc. */
  file: File;
}

/** What a surface allows. Defaults are the goods receipt's, so its callers pass nothing. */
export interface PickerLimits {
  maxCount: number;
  maxBytes: number;
  maxTotalBytes: number;
}

const GRN_LIMITS: PickerLimits = {
  maxCount: GRN_DOC_MAX_COUNT,
  maxBytes: GRN_DOC_MAX_BYTES,
  maxTotalBytes: GRN_DOC_MAX_TOTAL_BYTES,
};

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

// Hidden file input + button. Validates type/size and the count + running-total caps
// (so the user gets instant feedback) before handing the file to `onPick`.
// `onPick` may be async (the detail uploads immediately; the create form stages).
//
// The CAPS and the accepted types are arguments, not constants, because the surfaces that pick files
// do not agree on them: a goods receipt takes 5 documents of 5 MB, a hire delivery takes 12 photographs
// of 10 MB. They were the goods receipt's numbers baked in, so the second surface had to grow its own
// picker — and then its own shrink, its own type gate and its own toasts, which is three chances for
// the two to drift on the rule the server actually enforces.
export function DocPicker({
  count,
  totalBytes,
  disabled,
  onPick,
  limits = GRN_LIMITS,
  accept = GRN_DOC_ACCEPT,
  label = "Upload document",
  hint,
  multiple = false,
}: {
  count: number;
  totalBytes: number;
  disabled?: boolean;
  onPick: (doc: PickedDoc) => void | Promise<void>;
  limits?: PickerLimits;
  /** Extensions this surface takes, e.g. ".png,.jpg,.jpeg". Also gates what is accepted on drop. */
  accept?: string;
  label?: string;
  hint?: string;
  /** A phone gallery hands over a set — one at a time is the wrong shape for condition photos. */
  multiple?: boolean;
}) {
  const { pushToast } = useDashboard();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const atCount = count >= limits.maxCount;
  // Derived from `accept` rather than a second prop, so the picker cannot advertise one set of types
  // and refuse another.
  const allowed = new Set(accept.split(",").map((e) => e.trim().replace(/^\./, "").toLowerCase()));

  // Returns the size actually STAGED, or null when the file was refused — see stageFiles for why the
  // running total cannot be advanced by the picked file's own size.
  const onFile = async (rawFile: File, runningBytes: number, runningCount: number): Promise<number | null> => {
    // The type gate runs on what was PICKED, so the message names the file the user chose. Resolved
    // against this surface's own `accept`, so the dialog can never offer a type the gate refuses.
    if (resolveDocType(rawFile.name, allowed) == null) {
      pushToast(`Unsupported file. Use ${accept.replace(/\./g, "").toUpperCase().replace(/,/g, ", ")}.`, "alert");
      return null;
    }
    // Then downscale, and measure THAT. PDFs and DOCX come back untouched; a photographed delivery
    // note does not, and it is the one thing here that regularly arrives over the per-file limit.
    // Checking the original would refuse a 6 MB phone photo that stores as a few hundred KB — and
    // the running total, which the backend also enforces, would count bytes we never send.
    const file = await shrinkImage(rawFile);
    // Re-derived, because a PNG re-encoded as JPEG arrives here renamed, and a WebP small enough to
    // skip the downscale keeps its own extension. Resolved against `allowed` again for the same
    // reason, so a re-encode can never produce a type this surface does not take.
    const fileType = resolveDocType(file.name, allowed) ?? "jpg";
    if (file.size > limits.maxBytes) {
      pushToast(`File must be ${mb(limits.maxBytes)} or smaller.`, "alert");
      return null;
    }
    // Counted against what this pick has ALREADY added, not only what was on screen when it started —
    // a multi-file pick would otherwise wave through a whole gallery past the cap.
    if (runningCount >= limits.maxCount) {
      pushToast(`You can attach at most ${limits.maxCount} files.`, "alert");
      return null;
    }
    if (runningBytes + file.size > limits.maxTotalBytes) {
      pushToast(`Total files can't exceed ${mb(limits.maxTotalBytes)}.`, "alert");
      return null;
    }
    setBusy(true);
    try {
      // `readDataUrl` is handed over unevaluated — a caller that uploads the File directly never
      // triggers the read. A throw from it still lands in this catch, because every caller awaits it
      // inside `onPick`.
      await onPick({
        fileName: file.name,
        fileType,
        fileSizeBytes: file.size,
        file,
      });
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not read the file.", "alert");
      return null;
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
    return file.size;
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={async (e) => {
          await stageFiles(Array.from(e.target.files ?? []), { bytes: totalBytes, count }, onFile);
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || busy || atCount}
        className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {label}
      </button>
      <p className="mt-1.5 text-[11px] text-[var(--faint)]">
        {atCount
          ? `Maximum ${limits.maxCount} files reached.`
          : (hint ??
            `Delivery note, packing slip, invoice or photo — PDF, DOCX, PNG or JPG. Max ${mb(limits.maxBytes)} each · ${limits.maxCount} files · ${mb(limits.maxTotalBytes)} total.`)}
      </p>
    </div>
  );
}

// Read-only LIST of attached files — one compact row each: a small preview (image) or type icon, the
// file name as the link, and its type/size beneath. Pass `onRemove` to make them deletable.
//
// A LIST, not a grid of thumbnails. The grid gave every file a 4:3 tile, which at a quarter of a wide
// container is ~380x285 — one condition photo filled the panel, and a delivery with six of them was
// unreadable. This is the same row the PO / PRF / Job attachment tabs already use (divided rows, name
// in accent, type and size under it, trash on the right), so files look the same wherever they hang.
//
// The 40px preview is the one addition to that pattern, and only for images: condition evidence is
// the thing on a hire record somebody actually needs to LOOK at, and a filename is not a photograph.
// At row height it costs no space and still says which photo is which.
export function AttachmentList({
  items,
  onRemove,
  emptyLabel = "No delivery documents attached yet.",
  confirmRemove = true,
  removePrompt,
}: {
  items: DocItem[];
  onRemove?: (id: string) => void | Promise<void>;
  /** What this surface calls its files — a hire delivery attaches photographs, not documents. */
  emptyLabel?: string;
  /**
   * Ask before removing. DEFAULT TRUE, and the default is the point: a stored file is gone for good
   * the moment the trash icon is hit, and the surfaces sharing this component disagreed about
   * whether to ask — the goods receipt detail confirmed, the hire delivery deleted on the click.
   * Condition photos are the worst case: they are evidence for a claim against a supplier and
   * nobody can photograph an arrival after the van has gone.
   *
   * Pass false ONLY where the removal is local staging — a file picked but not yet uploaded costs
   * nothing to pick again, and a dialog there is ceremony.
   */
  confirmRemove?: boolean;
  /** Names what is being removed. Defaults to neutral file wording. */
  removePrompt?: { title: string; message: React.ReactNode };
}) {
  const [preview, setPreview] = React.useState<DocItem | null>(null);
  const [pending, setPending] = React.useState<DocItem | null>(null);
  const [removing, setRemoving] = React.useState(false);

  // One path for both modes, so the confirmed and unconfirmed removals can never drift apart.
  const doRemove = async (item: DocItem) => {
    if (!onRemove) return;
    setRemoving(true);
    try {
      await onRemove(item.id);
      setPending(null);
    } finally {
      setRemoving(false);
    }
  };

  if (items.length === 0) {
    return <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--muted)]">{emptyLabel}</p>;
  }

  return (
    <>
      {/* The remove button sits WITH its file, not at the far end of the row.
          `justify-between` pushed it to the row's right edge, which reads fine in a narrow card and
          falls apart anywhere wide — on the hire record this list is full-bleed, so the trash sat
          ~1400px from the file it deletes and, with several photos, belonged to no row you could
          name. Capping the width only shortened that gap; it did not join the two things up.
          So the row is shrink-to-fit and the button follows the name directly. The earlier
          thumbnail grid had this right by overlaying the trash on the tile — that exact trick is not
          available now the preview is 40px (the button would be ~16px, well under a usable tap
          target), and this is the same association without the tiny hit area. `max-w-xl` is only an
          upper bound so a long file name truncates instead of stretching the row. */}
      <ul className="max-w-xl divide-y divide-[var(--border-2)]">
        {items.map((a) => {
          // Each half is DROPPED when the record does not hold it, rather than printed as a
          // placeholder: an evidence photo stored as a bare URL knows neither its format nor its
          // size, and "IMAGE/JPEG · 0 KB" states two things that are not true of it.
          const meta = [
            a.fileType === UNTYPED_IMAGE ? "" : a.fileType.toUpperCase(),
            a.fileSizeBytes > 0 ? kb(a.fileSizeBytes) : "",
          ]
            .filter(Boolean)
            .join(" · ");
          // An image opens IN THE APP; anything else has no in-app viewer and opens its own tab.
          const body = (
            <>
              {isImage(a.fileType) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.src} alt="" aria-hidden className="h-10 w-10 shrink-0 rounded-lg border border-[var(--border)] object-cover" />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-[var(--accent)]" />
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-[var(--accent)] hover:underline">{a.fileName}</span>
                {meta && <span className="text-[11px] text-[var(--faint)]">{meta}</span>}
              </span>
            </>
          );
          return (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded-lg px-2 py-2.5 transition-colors hover:bg-[var(--surface-2)]"
            >
              {isImage(a.fileType) ? (
                <button type="button" onClick={() => setPreview(a)} className="flex min-w-0 items-center gap-2.5 text-left" aria-label={`Preview ${a.fileName}`}>
                  {body}
                </button>
              ) : (
                <a href={a.src} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-2.5">
                  {body}
                </a>
              )}
              {onRemove && (
                <button
                  type="button"
                  onClick={() => (confirmRemove ? setPending(a) : void doRemove(a))}
                  className="shrink-0 rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)]"
                  title="Remove"
                  aria-label={`Remove ${a.fileName}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {/* The app's own full-screen preview rather than a hand-rolled <img> in a Modal. That one
          capped the HEIGHT and left `w-auto`, so a phone photo opened at its natural 3000px inside a
          512px dialog and spilled out of it — height alone is not a constraint. ImageLightbox bounds
          both sides, portals above the modal it may have been opened from, and takes Escape first. */}
      {preview && (
        <ImageLightbox
          src={preview.src}
          alt={preview.fileName}
          caption={`${preview.fileName} · ${preview.fileType.toUpperCase()} · ${kb(preview.fileSizeBytes)}`}
          onClose={() => setPreview(null)}
        />
      )}

      <ConfirmDialog
        open={Boolean(pending)}
        danger
        busy={removing}
        title={removePrompt?.title ?? "Remove file"}
        message={removePrompt?.message ?? "Remove this file? This can't be undone."}
        confirmLabel="Remove"
        onConfirm={() => {
          if (pending) void doRemove(pending);
        }}
        onClose={() => {
          if (!removing) setPending(null);
        }}
      />
    </>
  );
}

