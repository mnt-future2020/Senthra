import { useEffect, useState } from "react";
import { api } from "./api";

// Public server-configured branding (same source as the web dashboard's logo).
// Cached for the app session — branding changes are rare.

export interface PublicBranding {
  companyName?: string;
  logoUrl: string;
}

/**
 * A branding logo is only usable as a remote image source when it is ABSOLUTE.
 * Uploads go to Cloudinary and come back absolute, but `Settings.logoUrl` is a
 * free-text field, so it can also hold a stale relative path. A relative value
 * gets resolved against whatever origin is serving the app — on Expo web that
 * is the Metro dev server, which then answers every render with
 * `Asset not found: <project>/assets/images/<name> for platform: (unspecified)`,
 * and on a device it silently yields a blank image. Treat anything non-absolute
 * as unset so the "S" wordmark fallback renders instead.
 */
function usableLogoUrl(url: unknown): string {
  const trimmed = typeof url === "string" ? url.trim() : "";
  return /^(https?:\/\/|data:image\/)/i.test(trimmed) ? trimmed : "";
}

let cached: PublicBranding | null = null;

export function useBranding(): PublicBranding | null {
  const [branding, setBranding] = useState<PublicBranding | null>(cached);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    api<{ branding: PublicBranding }>("/settings/branding")
      .then((r) => {
        const next: PublicBranding = {
          ...r.branding,
          logoUrl: usableLogoUrl(r.branding?.logoUrl),
        };
        cached = next;
        if (!cancelled) setBranding(next);
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
