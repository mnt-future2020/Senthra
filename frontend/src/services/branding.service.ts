import { api } from "@/lib/api";
import type { Branding, Settings } from "@/types/settings";

// Public — used by the login page / anywhere outside auth.
export function getBranding(): Promise<Branding> {
  return api<{ branding: Branding }>("/settings/branding").then((r) => r.branding);
}

// Upload a logo/favicon (data URI) → Cloudinary; returns the URL + updated settings.
export function uploadBrandingImage(
  type: "logo" | "favicon",
  image: string,
): Promise<{ url: string; settings: Settings }> {
  return api<{ url: string; settings: Settings }>("/settings/branding/upload", {
    method: "POST",
    body: { type, image },
    // Cloudinary upload can take a little longer than a normal request.
    timeout: 60_000,
  });
}
