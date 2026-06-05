import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { EmailPreview, EmailTemplate } from "@/types/emailTemplate";

// Typed wrappers around the backend /email-templates endpoints.

export interface UpdateTemplatePayload {
  name?: string;
  category?: string;
  subject?: string;
  // The editable plain-text message; the branded HTML is generated from it.
  textContent?: string;
  enabled?: boolean;
}

export interface PreviewPayload {
  subject?: string;
  textContent?: string;
}

// Cached so the templates list renders instantly on revisit instead of flashing a
// skeleton; the section still refetches to revalidate (and after any edit).
let templatesCache: EmailTemplate[] | null = null;
registerClientCache(() => {
  templatesCache = null;
});
export const getCachedTemplates = (): EmailTemplate[] | null => templatesCache;

export function listTemplates(): Promise<EmailTemplate[]> {
  return api<{ templates: EmailTemplate[] }>("/email-templates").then((r) => {
    templatesCache = r.templates;
    return r.templates;
  });
}

export function getTemplate(id: string): Promise<EmailTemplate> {
  return api<{ template: EmailTemplate }>(`/email-templates/${id}`).then((r) => r.template);
}

export function updateTemplate(
  id: string,
  payload: UpdateTemplatePayload,
): Promise<EmailTemplate> {
  return api<{ template: EmailTemplate }>(`/email-templates/${id}`, {
    method: "PUT",
    body: payload,
  }).then((r) => r.template);
}

export function setEnabled(id: string, enabled: boolean): Promise<EmailTemplate> {
  return api<{ template: EmailTemplate }>(`/email-templates/${id}/enabled`, {
    method: "PATCH",
    body: { enabled },
  }).then((r) => r.template);
}

export function duplicateTemplate(id: string): Promise<EmailTemplate> {
  return api<{ template: EmailTemplate }>(`/email-templates/${id}/duplicate`, {
    method: "POST",
  }).then((r) => r.template);
}

export function restoreDefault(id: string): Promise<EmailTemplate> {
  return api<{ template: EmailTemplate }>(`/email-templates/${id}/restore`, {
    method: "POST",
  }).then((r) => r.template);
}

export function deleteTemplate(id: string): Promise<void> {
  return api(`/email-templates/${id}`, { method: "DELETE" }).then(() => undefined);
}

export function previewTemplate(
  id: string,
  payload: PreviewPayload = {},
): Promise<EmailPreview> {
  return api<{ preview: EmailPreview }>(`/email-templates/${id}/preview`, {
    method: "POST",
    body: payload,
  }).then((r) => r.preview);
}

// SMTP send can take longer than a normal call.
export function sendTest(id: string, to: string): Promise<{ message: string }> {
  return api<{ message: string }>(`/email-templates/${id}/test`, {
    method: "POST",
    body: { to },
    timeout: 45_000,
  });
}
