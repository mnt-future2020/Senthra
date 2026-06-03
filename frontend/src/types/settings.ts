// Public branding (brand name, logo/favicon URLs, footer + login copy).
export interface Branding {
  brandName: string;
  logoUrl: string;
  faviconUrl: string;
  footerText: string;
  loginHeadline: string;
  loginSubtext: string;
}

// Public application settings as returned by the backend. Secret values are never
// included — only a `*Set` boolean indicating whether each secret is configured.
export interface Settings extends Branding {
  googleEnabled: boolean;
  googleClientId: string;
  googleClientSecretSet: boolean;
  smtpEnabled: boolean;
  smtpHost: string;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpFromName: string;
  smtpFromEmail: string;
  smtpPasswordSet: boolean;
  cloudinaryCloudName: string;
  cloudinaryApiKey: string;
  cloudinaryApiSecretSet: boolean;
  cloudinaryConfigured: boolean;
}
