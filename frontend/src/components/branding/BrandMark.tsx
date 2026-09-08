"use client";

import * as React from "react";

import { useBranding } from "@/hooks/useBranding";
import { fitsSquareSlot, markSrc } from "./markSource";

type Verdict = { kind: "image"; src: string } | { kind: "letter" };

// Probe results keyed by the exact URL probed, at module scope on purpose: a
// verdict then survives remounts and route changes, so the blank measuring
// frame below is paid once per session rather than on every navigation.
// `false` is recorded for rejected AND failed URLs alike, which is what stops a
// failing image being retried forever.
const probed = new Map<string, boolean>();

// Load the candidate detached from the DOM and judge it there. Nothing reaches
// the screen until a verdict exists, which is the whole point: rendering the
// candidate first and swapping it out on load is what let the wide lockup paint
// for a full round trip. The browser caches the response, so the <img> that
// eventually renders this same URL reuses it instead of fetching again.
function probe(src: string): Promise<boolean> {
  const seen = probed.get(src);
  if (seen !== undefined) return Promise.resolve(seen);

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const ok = fitsSquareSlot(img.naturalWidth, img.naturalHeight);
      probed.set(src, ok);
      resolve(ok);
    };
    img.onerror = () => {
      probed.set(src, false);
      resolve(false);
    };
    img.src = src;
  });
}

// The verdict already known from earlier probes, or null if any candidate ahead
// of it still has to be measured. Lets a revisit render the right mark on the
// first frame instead of flashing the placeholder again.
function cachedVerdict(srcs: readonly string[]): Verdict | null {
  for (const src of srcs) {
    const seen = probed.get(src);
    if (seen === undefined) return null;
    if (seen) return { kind: "image", src };
  }
  return { kind: "letter" };
}

function sameVerdict(a: Verdict | null, b: Verdict): boolean {
  if (!a || a.kind !== b.kind) return false;
  return a.kind === "image" && b.kind === "image" ? a.src === b.src : true;
}

// The brand mark for SQUARE slots — sidebar, avatar-sized chrome. Wide slots
// (the auth panel) use BrandWordmark, which lays the logo out at its natural
// width. `className` controls size/rounding/text-size.
//
// Branding stores two images and neither records its shape, so the source is
// picked by measuring rather than by trusting the field:
//
//   1. logoUrl    — right when the operator uploaded an icon-shaped logo, but
//                   these are usually horizontal lockups (ours is 4.4:1), which
//                   is what letterboxed the mark into an illegible strip.
//   2. faviconUrl — a favicon is square by definition, so it is the brand's
//                   icon-shaped asset even though it was uploaded for the
//                   browser tab. An operator who has set one already has a real
//                   mark here with nothing more to upload.
//   3. the brand's first letter in a colored box.
//
// Anything too wide, too small or that fails to load is skipped and the next
// candidate takes over, so every failure mode ends at the letter rather than at
// a smear or a broken-image glyph.
//
// A `variant` prop used to offer a translucent chip for dark panels, but it was
// only ever read on the letter fallback: the image branch returned first and
// hardcoded the plate, so the one caller that asked for translucent silently
// got white. That caller is now a BrandWordmark and the prop had no other
// users, so rather than leave a flag that half works, it is gone.
export function BrandMark({ className }: { className: string }) {
  const { brandName, logoUrl, faviconUrl } = useBranding();

  const srcs = React.useMemo(
    () => [logoUrl, faviconUrl].filter((u): u is string => Boolean(u)).map(markSrc),
    [logoUrl, faviconUrl],
  );

  const [verdict, setVerdict] = React.useState<Verdict | null>(() => cachedVerdict(srcs));
  // Bumped when a rendered image fails, to re-run the search past it. Each
  // failure caches `false` for that URL first, so the list strictly shrinks and
  // the search always terminates — at the letter if nothing is left.
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      for (const src of srcs) {
        const ok = await probe(src);
        if (cancelled) return;
        if (ok) {
          setVerdict((prev) => {
            const next: Verdict = { kind: "image", src };
            return sameVerdict(prev, next) ? prev : next;
          });
          return;
        }
      }
      setVerdict((prev) => (sameVerdict(prev, { kind: "letter" }) ? prev : { kind: "letter" }));
    })();

    return () => {
      cancelled = true;
    };
  }, [srcs, attempt]);

  if (!verdict) {
    // Measuring. Hold the slot's size so the chrome around it doesn't reflow,
    // but paint nothing — the candidate this component exists to reject must
    // never reach the screen, not even for a frame.
    return <span className={`block shrink-0 ${className}`} aria-hidden />;
  }

  if (verdict.kind === "image") {
    return (
      <span
        className={`flex shrink-0 items-center justify-center overflow-hidden bg-white ${className}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={verdict.src}
          alt={brandName}
          className="h-full w-full object-contain"
          onError={() => {
            // Probed fine but failed to render — cache eviction, a URL revoked
            // between the two. Bury this candidate and resume the search rather
            // than leaving a broken-image glyph in permanent chrome.
            probed.set(verdict.src, false);
            setVerdict(null);
            setAttempt((n) => n + 1);
          }}
        />
      </span>
    );
  }

  return (
    <span
      className={`flex shrink-0 items-center justify-center bg-gradient-to-br from-[var(--accent)] to-indigo-600 font-black text-white ${className}`}
    >
      {(brandName.trim()[0] || "S").toUpperCase()}
    </span>
  );
}
