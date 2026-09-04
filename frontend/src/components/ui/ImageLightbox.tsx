"use client";

// ImageLightbox — full-screen in-app image preview (portal to <body>). Used to view damage photos
// etc. WITHOUT navigating to the raw Cloudinary URL. Closes on backdrop click, the X, or Escape.
// Safe to open ON TOP of a <Modal>: it sits at z-[60] above the modal's z-50 and swallows Escape so
// only the photo closes, leaving the modal beneath it open (see the keydown effect).

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { useScrollLock } from "@/hooks/useScrollLock";

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
  // Always open when mounted, and frequently mounted ON TOP of a Modal that already holds the
  // lock — which is exactly the case the ref count in scrollLock.ts exists for: closing the photo
  // must not unlock the page while the modal underneath is still up.
  useScrollLock(true);
  React.useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // Escape is handled in the CAPTURE phase and stopped there, because this lightbox can open on
    // top of a <Modal> (the damaged-stock history opens a photo from inside its modal) and both
    // listen for Escape on `document`.
    //
    // stopImmediatePropagation would NOT fix that: same-element listeners fire in REGISTRATION
    // order, and the Modal — mounted first — would already have closed underneath us before this
    // handler ever ran, dumping the user back to the table instead of just dismissing the photo.
    // Capturing runs ahead of every bubble-phase listener on `document` regardless of mount order,
    // so the topmost overlay consumes the key, which is what a stacked dialog should do.
    //
    // Scoped to Escape on purpose — Tab still reaches the Modal so its focus trap keeps working.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      // The capture flag is part of the listener's identity — removing without it is a no-op leak.
      document.removeEventListener("keydown", onKey, true);
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
