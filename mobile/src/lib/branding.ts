import { useEffect, useState } from "react";
import { api } from "./api";

// Public server-configured branding (same source as the web dashboard's logo).
// Cached for the app session — branding changes are rare.

export interface PublicBranding {
  companyName?: string;
  logoUrl: string;
}

let cached: PublicBranding | null = null;

export function useBranding(): PublicBranding | null {
  const [branding, setBranding] = useState<PublicBranding | null>(cached);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    api<{ branding: PublicBranding }>("/settings/branding")
      .then((r) => {
        cached = r.branding;
        if (!cancelled) setBranding(r.branding);
      })
      .catch(() => {
        /* branding is cosmetic — fall back to the wordmark */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return branding;
}
