// Public branding (brand name, logo/favicon URLs, footer + login copy).
export interface Branding {
  brandName: string;
  // Brand accent (hex). Drives the dashboard accent and the branding of sent emails.
  brandColor: string;
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
  // Code prefixed to new staff IDs (e.g. "SNT" → SNT-0007). Effective value
  // (default-filled by the backend). Only affects newly-created staff.
  employeeIdPrefix: string;
  // Company profile (legal identity for official documents) + regional formatting.
  // Default-filled by the backend (country/timezone/dateFormat/timeFormat).
  companyLegalName: string;
  companyRegNumber: string;
  vatNumber: string;
  companyAddressLine1: string;
  companyAddressLine2: string;
  companyCity: string;
  companyCounty: string;
  companyPostcode: string;
  companyCountry: string;
  companyPhone: string;
  companyEmail: string;
  websiteUrl: string;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
}
