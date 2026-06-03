import { cache } from "react";

import type { Branding } from "@/types/settings";
import { env } from "./env";

// The page <title> format — shared by SSR (generateMetadata) and the client-side
// live update so they never drift.
export function brandTitle(brandName: string): string {
  return `${brandName} — Admin Dashboard`;
}

export const DEFAULT_BRANDING: Branding = {
  brandName: "Senthra",
  logoUrl: "",
  faviconUrl: "",
  footerText: `© ${new Date().getFullYear()} Senthra. All rights reserved.`,
  loginHeadline: "Effortlessly manage your business and operations.",
  loginSubtext:
    "Sign in to access your admin dashboard and run everything from one place.",
};

// Server-side branding fetch for the root layout (SSR → no flash). Falls back to
// defaults if the backend is unreachable so the app still renders.
//
// Wrapped in React.cache so the two callers in a single render pass —
// generateMetadata() and RootLayout() — share ONE backend request. `no-store`
// disables fetch-level memoization, so without this the endpoint would be hit
// twice per page load.
export const fetchBranding = cache(async (): Promise<Branding> => {
  try {
    // Always fresh so branding changes reflect on the next render. Branding is a
    // tiny endpoint and the layout is already dynamic (reads the appearance cookie).
    const res = await fetch(`${env.apiUrl}/settings/branding`, {
      cache: "no-store",
    });
    if (!res.ok) return DEFAULT_BRANDING;
    const data = (await res.json()) as { branding?: Branding };
    return data.branding ?? DEFAULT_BRANDING;
  } catch {
    return DEFAULT_BRANDING;
  }
});
