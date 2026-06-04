import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { cookies } from "next/headers";
import "./globals.css";

import { AuthProvider } from "@/providers/AuthProvider";
import { BrandingProvider } from "@/providers/BrandingProvider";
import { APPEARANCE_COOKIE, parseAppearance } from "@/lib/appearance";
import { brandTitle, fetchBranding } from "@/lib/branding";

// Dynamic title + favicon from the configured branding. fetchBranding is wrapped
// in React.cache, so this call and the RootLayout call below share one request.
export async function generateMetadata(): Promise<Metadata> {
  const branding = await fetchBranding();
  return {
    title: brandTitle(branding.brandName),
    description: `${branding.brandName} admin & analytics dashboard`,
    ...(branding.faviconUrl ? { icons: { icon: branding.faviconUrl } } : {}),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read the saved appearance on the server so the very first paint already has
  // the right theme/density/radius — no flash of the default theme. The accent is
  // the *global* brand color (from branding), not the per-device cookie, so it
  // matches the dashboard and sent emails.
  const store = await cookies();
  const appearance = parseAppearance(store.get(APPEARANCE_COOKIE)?.value);
  const branding = await fetchBranding();

  return (
    <html
      lang="en"
      data-theme={appearance.theme}
      data-density={appearance.density}
      style={
        {
          "--accent": branding.brandColor,
          "--radius": `${appearance.radius}px`,
        } as CSSProperties
      }
      suppressHydrationWarning
    >
      <body className="antialiased">
        <BrandingProvider branding={branding}>
          <AuthProvider>{children}</AuthProvider>
        </BrandingProvider>
      </body>
    </html>
  );
}
