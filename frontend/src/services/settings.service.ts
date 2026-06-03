import { api } from "@/lib/api";
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
  logoUrl?: string;
  faviconUrl?: string;
  footerText?: string;
  loginHeadline?: string;
  loginSubtext?: string;
}

export function getSettings(): Promise<Settings> {
  return api<{ settings: Settings }>("/settings").then((r) => r.settings);
}

export function updateSettings(payload: SettingsUpdate): Promise<Settings> {
  return api<{ settings: Settings }>("/settings", {
    method: "PUT",
    body: payload,
  }).then((r) => r.settings);
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
