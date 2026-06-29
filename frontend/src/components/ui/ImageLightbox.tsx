"use client";

// ImageLightbox — full-screen in-app image preview (portal to <body>). Used to view damage photos
// etc. WITHOUT navigating to the raw Cloudinary URL. Closes on backdrop click, the X, or Escape.

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function ImageLightbox({
  src,
  alt = "Image",
  caption,
  onClose,
}: {
  src: string;
  alt?: string;
  caption?: React.ReactNode;
  onClose: () => void;
}) {
  React.useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/80 p-4 anim-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-lg bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        aria-label="Close preview"
      >
        <X className="h-5 w-5" />
      </button>
      {/* Raw <img> (not next/image): the source is an arbitrary external Cloudinary URL shown at its
          natural size in a lightbox. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
      />
      {caption && (
        <div className="max-w-[90vw] text-center text-sm text-white/85" onClick={(e) => e.stopPropagation()}>
          {caption}
        </div>
      )}
    </div>,
    document.body,
  );
}
