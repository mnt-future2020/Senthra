// An email template as returned by the backend.
export interface EmailTemplate {
  id: string;
  key: string;
  name: string;
  category: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  variables: string[];
  enabled: boolean;
  isSystem: boolean;
  version: number;
  updatedAt: string;
}

// A rendered template (sample variables substituted) for the live preview pane.
export interface EmailPreview {
  subject: string;
  html: string;
  text: string;
}
