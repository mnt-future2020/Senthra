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
  // Display prefix for customer stock-entry barcodes (e.g. "CSE" → CSE-00006).
  // Effective value (default-filled by the backend). Only affects new barcodes.
  stockCodePrefix: string;
  // Display prefix for IRM catalogue item codes (e.g. "IRM" → IRM-0004).
  // Effective value (default-filled by the backend). Only affects new items.
  irmCodePrefix: string;
  // Display prefix for RENTAL catalogue item codes (e.g. "RNT" → RNT-0011).
  // Effective value (default-filled by the backend). Only affects new items — an existing code, and
  // therefore the barcode printed from it, never changes.
  rentalCodePrefix: string;
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
  // Engineer-to-engineer transfers: when true, the recipient must sign on receipt.
  engineerTransferRequireSignature: boolean;
  // After how many days engineer-held stock counts as overdue. The server applies the default, so
  // this is always a number — never null.
  overdueAfterDays: number;
}
