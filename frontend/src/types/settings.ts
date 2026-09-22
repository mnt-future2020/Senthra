// Public branding (brand name, logo/favicon URLs, footer + login copy).
export interface Branding {
  brandName: string;
  /**
   * Hostnames that serve files this app uploaded, so a stored attachment can be told apart from a
   * link somebody pasted.
   *
   * Public delivery hostnames only — no credential of any kind. It lives on BRANDING rather than
   * Settings because the engineer and customer portals render attachments and cannot read Settings.
   * Both providers are always listed: an asset stays on whichever one stored it.
   */
  uploadHosts: string[];
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
  // Which provider NEW uploads go to. Existing files stay where they were stored.
  storageProvider: "cloudinary" | "spaces";
  spacesEndpoint: string;
  spacesRegion: string;
  spacesBucket: string;
  spacesAccessKeyId: string;
  spacesCdnUrl: string;
  // Whether a secret is stored — never the secret itself.
  spacesSecretKeySet: boolean;
  spacesConfigured: boolean;
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
  // PO document branding — the PO PDF's OWN logo / accent colour, "" when unset (the PDF then uses the
  // app's logoUrl / brandColor above). Never applied to the app itself or to emails.
  poDocLogoUrl: string;
  poDocAccentColor: string;
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
  /** Global email 2FA. Off by default; Google Sign-In keeps working and is subject to it too. */
  emailTwoFactorEnabled: boolean;
}
