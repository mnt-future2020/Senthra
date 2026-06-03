"use client";

import * as React from "react";

import { brandTitle } from "@/lib/branding";
import type { Branding } from "@/types/settings";

export interface BrandingState extends Branding {
  // Update the live branding (so the sidebar/title react instantly after a save).
  setBranding: (b: Branding) => void;
}

export const BrandingContext = React.createContext<BrandingState | null>(null);

export function BrandingProvider({
  branding: initial,
  children,
}: {
  branding: Branding;
  children: React.ReactNode;
}) {
  const [branding, setBranding] = React.useState<Branding>(initial);

  // Keep the browser-tab title + favicon in sync the instant branding changes,
  // instead of waiting for the next page load. (The SSR'd values are already
  // correct on first paint; this only matters after a live edit in Settings.)
  React.useEffect(() => {
    document.title = brandTitle(branding.brandName);

    const href = branding.faviconUrl || "/favicon.ico";
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = href;
  }, [branding.brandName, branding.faviconUrl]);

  const value = React.useMemo<BrandingState>(
    () => ({ ...branding, setBranding }),
    [branding],
  );
  return (
    <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>
  );
}
