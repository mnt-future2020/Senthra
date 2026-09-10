import { cache } from "react";

import type { Branding } from "@/types/settings";
import { env } from "./env";

// The page <title> format — shared by SSR (generateMetadata) and the client-side
// live update so they never drift. Deliberately role-neutral: it is rendered on the
// server before the session is known (the login screen included), so it cannot say who
// is viewing — and "Admin Dashboard" was wrong for every non-admin who saw it.
export function brandTitle(brandName: string): string {
  return `${brandName} — Dashboard`;
}

// The brand name, footer and login copy below mirror the backend's
// backend/src/modules/settings/branding.defaults.ts — change both together.
export const DEFAULT_BRAND_NAME = "Senthra";

// The footer the backend applies when none is set: always the current year and brand name.
export function defaultFooterText(brandName: string): string {
  return `© ${new Date().getFullYear()} ${brandName}. All rights reserved.`;
}

// The fallback when the backend is unreachable.
export const DEFAULT_BRANDING: Branding = {
  brandName: DEFAULT_BRAND_NAME,
  brandColor: "#7b6ef0",
  logoUrl: "",
  faviconUrl: "",
  footerText: defaultFooterText(DEFAULT_BRAND_NAME),
  loginHeadline: "Effortlessly manage your business and operations.",
  loginSubtext:
    "Sign in to access your dashboard and run everything from one place.",
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
