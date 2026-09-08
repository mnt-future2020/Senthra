"use client";

import { useBranding } from "@/hooks/useBranding";
import { optimizeCloudinaryUrl } from "@/lib/utils";

// The brand "wordmark": the uploaded logo at its natural aspect ratio, for the
// wide slots where the square BrandMark is the wrong shape.
//
// Uploaded logos are typically horizontal lockups (name + tagline + icon). Ours
// is 4.4:1, so dropping it into BrandMark's square box renders it as a ~14px
// strip of illegible text surrounded by empty plate — which is what the login
// panel showed. Here the height is set by `className` and the width follows the
// image, so the logo stays legible at whatever size the slot allows.
//
// The mark is always drawn in its OWN colours, including on the auth panel's
// coloured gradient. Knocking it out to flat white is the reflex there, and it
// was tried, but it buys nothing: measured against that gradient the brand's
// dark ink scores 4.09:1 and white 3.94:1, so white is no easier to read and
// costs the mark its accent colour. Don't add a white/mono filter back without
// a contrast measurement that actually justifies it.
//
// With no logo uploaded there is nothing to lay out, so it falls back to the
// brand name as text styled by `textClassName`.
export function BrandWordmark({
  className,
  textClassName,
}: {
  className: string;
  textClassName?: string;
}) {
  const { brandName, logoUrl } = useBranding();

  if (!logoUrl) {
    return <span className={textClassName}>{brandName}</span>;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={optimizeCloudinaryUrl(logoUrl)}
      alt={brandName}
      className={`w-auto object-contain object-left select-none ${className}`}
    />
  );
}
