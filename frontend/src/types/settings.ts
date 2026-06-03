// Public application settings as returned by the backend. Secret values are never
// included — only a `*Set` boolean indicating whether each secret is configured.
export interface Settings {
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
}
