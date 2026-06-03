"use client";

import { useBranding } from "@/hooks/useBranding";
import { optimizeCloudinaryUrl } from "@/lib/utils";

// The brand "mark": the uploaded logo if one is set, otherwise the brand's first
// letter in a colored box. `className` controls size/rounding/text-size.
export function BrandMark({
  className,
  variant = "gradient",
}: {
  className: string;
  variant?: "gradient" | "translucent";
}) {
  const { brandName, logoUrl } = useBranding();

  if (logoUrl) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center overflow-hidden bg-white ${className}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={optimizeCloudinaryUrl(logoUrl)}
          alt={brandName}
          className="h-full w-full object-contain"
        />
      </span>
    );
  }

  const bg =
    variant === "translucent"
      ? "bg-white/15 text-white backdrop-blur"
      : "bg-gradient-to-br from-[var(--accent)] to-indigo-600 text-white";
  return (
    <span
      className={`flex shrink-0 items-center justify-center font-black ${bg} ${className}`}
    >
      {(brandName.trim()[0] || "S").toUpperCase()}
    </span>
  );
}
