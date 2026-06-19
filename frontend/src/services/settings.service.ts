import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { Settings } from "@/types/settings";

// Fields accepted by the settings update + test-email endpoints. All optional —
// the backend only overwrites the keys that are present.
export interface SettingsUpdate {
  googleEnabled?: boolean;
  googleClientId?: string;
  googleClientSecret?: string;
  smtpEnabled?: boolean;
  smtpHost?: string;
  smtpPort?: string | number;
  smtpSecure?: boolean;
  smtpUsername?: string;
  smtpFromName?: string;
  smtpFromEmail?: string;
  smtpPassword?: string;
  cloudinaryCloudName?: string;
  cloudinaryApiKey?: string;
  cloudinaryApiSecret?: string;
  brandName?: string;
  brandColor?: string;
  logoUrl?: string;
  faviconUrl?: string;
  footerText?: string;
  loginHeadline?: string;
  loginSubtext?: string;
  employeeIdPrefix?: string;
  // Company profile + regional (all optional; empty string clears back to the backend default).
  companyLegalName?: string;
  companyRegNumber?: string;
  vatNumber?: string;
  companyAddressLine1?: string;
  companyAddressLine2?: string;
  companyCity?: string;
  companyCounty?: string;
  companyPostcode?: string;
  companyCountry?: string;
  companyPhone?: string;
  companyEmail?: string;
  websiteUrl?: string;
  timezone?: string;
  dateFormat?: string;
  timeFormat?: string;
}

// Stale-while-revalidate cache (module-level, survives route navigation): switching
// between settings sections / revisiting Settings serves the cached value instantly,
// refreshing in the background. Concurrent callers (Integrations + Cloudinary mount
// together) share one in-flight request instead of firing /settings twice.
let settingsCache: Settings | null = null;
let settingsInflight: Promise<Settings> | null = null;
registerClientCache(() => {
  settingsCache = null;
  settingsInflight = null;
});

export const getCachedSettings = (): Settings | null => settingsCache;

function revalidateSettings(): Promise<Settings> {
  if (settingsInflight) return settingsInflight;
  settingsInflight = api<{ settings: Settings }>("/settings")
    .then((r) => {
      settingsCache = r.settings;
      return r.settings;
    })
    .finally(() => {
      settingsInflight = null;
    });
  return settingsInflight;
}

export function getSettings(): Promise<Settings> {
  if (settingsCache) {
    void revalidateSettings(); // serve cache now, refresh for next time
    return Promise.resolve(settingsCache);
  }
  return revalidateSettings();
}

export function updateSettings(payload: SettingsUpdate): Promise<Settings> {
  return api<{ settings: Settings }>("/settings", {
    method: "PUT",
    body: payload,
  }).then((r) => {
    settingsCache = r.settings; // keep the cache fresh after a save
    return r.settings;
  });
}

// SMTP connect + send can take longer than a normal API call.
export function sendTestEmail(
  payload: SettingsUpdate & { to: string },
): Promise<{ message: string }> {
  return api<{ message: string }>("/settings/email/test", {
    method: "POST",
    body: payload,
    timeout: 45_000,
  });
}
