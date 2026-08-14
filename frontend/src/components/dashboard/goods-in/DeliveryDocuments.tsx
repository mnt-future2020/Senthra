"use client";

import * as React from "react";
import { FileText, Loader2, Trash2, Upload } from "lucide-react";

import { useDashboard } from "@/hooks/useDashboard";
import { viewDataUriInNewTab } from "@/lib/download";
import { readFileAsDataUrl } from "@/lib/image";
import { Modal } from "@/components/ui/Modal";
import type { GrnAttachment } from "@/types/goods-in";

// Shared delivery-document UI for the GRN form + detail. Limits MIRROR the backend
// source of truth in backend/src/modules/goods-in/goods-in.validation.ts — keep in sync.
export const GRN_DOC_MAX_COUNT = 5;
export const GRN_DOC_MAX_BYTES = 5 * 1024 * 1024; // 5 MB / file
export const GRN_DOC_MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB total
export const GRN_DOC_ACCEPT = ".pdf,.docx,.png,.jpg,.jpeg";

const EXT_TYPE: Record<string, string> = { pdf: "pdf", docx: "docx", png: "png", jpg: "jpg", jpeg: "jpg" };
const isImage = (fileType: string) => fileType === "png" || fileType === "jpg";
const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

// A unified shape the grid renders — works for a saved attachment (src = Cloudinary url)
// or a not-yet-uploaded staged file (src = in-memory data URL).
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
  /**
   * The file itself, for the detail page — that receipt exists, so its document goes straight to
   * Cloudinary and the backend only finalizes it.
   */
  file: File;
  /**
   * The same file as a base64 data URL, for the create/edit FORM, which still posts its documents
   * through this server (there is nothing to attach to until the receipt is saved).
   *
   * A FUNCTION, not a string, and that is the whole point. Reading a file this way costs about 1.33×
   * its size in memory — up to ~6.7 MB for one 5 MB PDF — and the picker used to pay that on every
   * pick, including on the detail page, which then used `file` and threw the string away. Not
   * spending it is most of what direct upload was for. Now only the caller that actually posts base64
   * calls this, and the detail page never allocates it at all.
   */
  readDataUrl: () => Promise<string>;
}

// Hidden file input + button. Validates type/size and the count + running-total caps
// (so the user gets instant feedback) before handing a read data URL to `onPick`.
// `onPick` may be async (the detail uploads immediately; the create form stages).
export function DocPicker({
  count,
  totalBytes,
  disabled,
  onPick,
}: {
  count: number;
  totalBytes: number;
  disabled?: boolean;
  onPick: (doc: PickedDoc) => void | Promise<void>;
}) {
  const { pushToast } = useDashboard();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const atCount = count >= GRN_DOC_MAX_COUNT;

  const onFile = async (file: File) => {
    const fileType = EXT_TYPE[file.name.split(".").pop()?.toLowerCase() ?? ""];
    if (!fileType) return pushToast("Unsupported file. Use PDF, DOCX, PNG, JPG or JPEG.", "alert");
    if (file.size > GRN_DOC_MAX_BYTES) return pushToast("File must be 5 MB or smaller.", "alert");
    if (count >= GRN_DOC_MAX_COUNT) return pushToast(`You can attach at most ${GRN_DOC_MAX_COUNT} documents.`, "alert");
    if (totalBytes + file.size > GRN_DOC_MAX_TOTAL_BYTES) return pushToast("Total documents can't exceed 20 MB.", "alert");
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
        readDataUrl: () => readFileAsDataUrl(file),
      });
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not read the file.", "alert");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div>
      <input ref={inputRef} type="file" accept={GRN_DOC_ACCEPT} className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || busy || atCount}
        className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload document
      </button>
      <p className="mt-1.5 text-[11px] text-[var(--faint)]">
        {atCount
          ? `Maximum ${GRN_DOC_MAX_COUNT} documents reached.`
          : `Delivery note, packing slip, invoice or photo — PDF, DOCX, PNG or JPG. Max 5 MB each · ${GRN_DOC_MAX_COUNT} files · 20 MB total.`}
      </p>
    </div>
  );
}

// Read-only grid of documents: image files show a thumbnail (click → lightbox), other
// files show a type chip that opens in a new tab. Pass `onRemove` to make them deletable.
export function AttachmentGrid({ items, onRemove }: { items: DocItem[]; onRemove?: (id: string) => void }) {
  const { pushToast } = useDashboard();
  const [preview, setPreview] = React.useState<DocItem | null>(null);

  // A staged (not-yet-uploaded) doc's src is an in-memory `data:` URI, and Chrome blocks a
  // top-level navigation straight to one — the tab opens blank on the raw base64. Route those
  // through a blob: URL instead. Saved attachments are plain Cloudinary URLs, so they just open.
  const openDoc = (e: React.MouseEvent<HTMLAnchorElement>, doc: DocItem) => {
    if (!doc.src.startsWith("data:")) return;
    e.preventDefault();
    if (!viewDataUriInNewTab(doc.src)) pushToast(`Couldn't preview "${doc.fileName}".`, "alert");
  };

  if (items.length === 0) {
    return <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--muted)]">No delivery documents attached yet.</p>;
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {items.map((a) => (
          <div key={a.id} className="group relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {isImage(a.fileType) ? (
              <button type="button" onClick={() => setPreview(a)} className="block aspect-[4/3] w-full overflow-hidden bg-[var(--surface-2)]" aria-label={`Preview ${a.fileName}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.src} alt={a.fileName} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
              </button>
            ) : (
              <a href={a.src} target="_blank" rel="noopener noreferrer" onClick={(e) => openDoc(e, a)} className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--accent)]">
                <FileText className="h-7 w-7" />
                <span className="text-[10px] font-bold">{a.fileType.toUpperCase()}</span>
              </a>
            )}
            <div className="p-2">
              <p className="truncate text-[11px] font-bold text-[var(--ink)]" title={a.fileName}>{a.fileName}</p>
              <p className="text-[10px] text-[var(--faint)]">{a.fileType.toUpperCase()} · {kb(a.fileSizeBytes)}</p>
            </div>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(a.id)}
                className="absolute right-1 top-1 rounded-lg bg-[var(--surface)]/90 p-1.5 text-[var(--muted)] shadow-sm transition-colors hover:bg-[var(--surface)] hover:text-[var(--neg)]"
                aria-label={`Remove ${a.fileName}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      {preview && (
        <Modal open title={preview.fileName} subtitle={`${preview.fileType.toUpperCase()} · ${kb(preview.fileSizeBytes)}`} onClose={() => setPreview(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview.src} alt={preview.fileName} className="mx-auto max-h-[70vh] w-auto rounded-lg" />
        </Modal>
      )}
    </>
  );
}
