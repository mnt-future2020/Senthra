import { api, LONG_WRITE_TIMEOUT } from "@/lib/api";
import type { Branding, Settings } from "@/types/settings";

// Public — used by the login page / anywhere outside auth.
export function getBranding(): Promise<Branding> {
  return api<{ branding: Branding }>("/settings/branding").then((r) => r.branding);
}

// Upload a logo/favicon (data URI) → Cloudinary; returns the URL + updated settings. "po_logo" is the
// purchase order document's own logo (Settings → Purchase Orders) — it leaves the app branding alone.
export function uploadBrandingImage(
  type: "logo" | "favicon" | "po_logo",
  image: string,
): Promise<{ url: string; settings: Settings }> {
  return api<{ url: string; settings: Settings }>("/settings/branding/upload", {
    method: "POST",
    body: { type, image },
    // Cloudinary upload can take a little longer than a normal request.
    timeout: LONG_WRITE_TIMEOUT,
  });
}
