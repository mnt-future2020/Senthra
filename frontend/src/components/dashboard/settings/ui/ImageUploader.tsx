"use client";

import * as React from "react";
import { Image as ImageIcon, Loader2, Trash2, Upload } from "lucide-react";

import { labelCls } from "@/components/ui/styles";

// Reusable preview + upload/remove control for a Settings image (the app logo & favicon in Branding,
// the PO document logo in Purchase Orders). Disabled by an enclosing <fieldset disabled>.
export function ImageUploader({
  title,
  hint,
  url,
  uploading,
  onPick,
  onRemove,
}: {
  title: string;
  hint: string;
  url: string;
  uploading: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div>
      <label className={labelCls}>{title}</label>
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={title} className="h-full w-full object-contain" />
          ) : (
            <ImageIcon className="h-6 w-6 text-[var(--faint)]" />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {url ? "Replace" : "Upload"}
            </button>
            {url && (
              <button
                type="button"
                onClick={onRemove}
                disabled={uploading}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-[var(--muted)] transition-all hover:text-[var(--neg)] disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            )}
          </div>
          <span className="text-[11px] leading-tight text-[var(--faint)]">{hint}</span>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
