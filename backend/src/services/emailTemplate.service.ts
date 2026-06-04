import type { EmailTemplate, Prisma } from "@prisma/client";

import * as emailTemplateRepo from "../repositories/emailTemplate.repository.js";
import { badRequest, forbidden, notFound } from "../utils/http-error.js";
import { renderBodyToHtml } from "../utils/email-html.js";
import { extractVariables, renderEmail, type TemplateVars } from "../utils/template-render.js";
import { slugify } from "../utils/slugify.js";
import * as audit from "./audit.service.js";
import type { AuditActor } from "./audit.service.js";
import { resolveBrandVars, sendAndLog } from "./email.service.js";
import { findDefaultTemplate, requiredVariablesFor } from "./email-templates.defaults.js";

export interface PublicEmailTemplate {
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

function publicTemplate(t: EmailTemplate): PublicEmailTemplate {
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    category: t.category,
    subject: t.subject,
    htmlContent: t.htmlContent,
    textContent: t.textContent,
    variables: t.variables,
    enabled: t.enabled,
    isSystem: t.isSystem,
    version: t.version,
    updatedAt: t.updatedAt.toISOString(),
  };
}

// Realistic sample values for preview / test sends.
const SAMPLE_VALUES: Record<string, string> = {
  firstName: "Alex",
  lastName: "Morgan",
  email: "alex.morgan@example.com",
  roleName: "Project Manager",
  temporaryPassword: "Xy7$Kp2Rq9",
  resetPasswordLink: "https://app.example.com/reset-password?token=sample-token",
  loginUrl: "https://app.example.com/login",
  supportEmail: "support@example.com",
};

// Build the variable map for a preview/test render: real brand vars overlaid with
// sample values for the template's declared variables.
async function buildSampleVars(template: EmailTemplate): Promise<TemplateVars> {
  const vars: TemplateVars = { ...(await resolveBrandVars()) };
  for (const name of template.variables) {
    if (vars[name] == null || vars[name] === "") {
      vars[name] = SAMPLE_VALUES[name] ?? `[${name}]`;
    }
  }
  return vars;
}

export async function listTemplates(): Promise<PublicEmailTemplate[]> {
  return (await emailTemplateRepo.findMany()).map(publicTemplate);
}

export async function getTemplate(id: string): Promise<PublicEmailTemplate> {
  const t = await emailTemplateRepo.findById(id);
  if (!t) throw notFound("Email template not found.");
  return publicTemplate(t);
}

export interface CreateTemplateInput {
  name: string;
  category?: string;
  subject: string;
  // The editable plain-text message; the branded HTML is generated from it.
  textContent: string;
}

// Create a custom template from scratch (disabled by default). Variables are
// inferred from the content. Custom templates have no built-in default and are
// deletable.
export async function createTemplate(
  input: CreateTemplateInput,
  actor?: AuditActor,
): Promise<PublicEmailTemplate> {
  const name = input.name.trim();
  if (!name) throw badRequest("Template name is required.");

  const base = `custom.${slugify(name)}`;
  let key = base;
  let n = 2;
  while (await emailTemplateRepo.findByKey(key)) key = `${base}_${n++}`;

  const message = input.textContent;
  const created = await emailTemplateRepo.create({
    key,
    name,
    category: input.category?.trim() || "custom",
    subject: input.subject,
    htmlContent: renderBodyToHtml(message),
    textContent: message,
    variables: extractVariables(input.subject, message),
    enabled: false,
    isSystem: false,
    version: 1,
  });
  audit.record({
    actor,
    action: "email_template.created",
    targetType: "email_template",
    targetId: created.id,
    targetLabel: created.key,
  });
  return publicTemplate(created);
}

export interface UpdateTemplateInput {
  name?: string;
  category?: string;
  subject?: string;
  // The editable plain-text message; the branded HTML is regenerated from it.
  textContent?: string;
  enabled?: boolean;
}

export async function updateTemplate(
  id: string,
  input: UpdateTemplateInput,
  actor?: AuditActor,
): Promise<PublicEmailTemplate> {
  const t = await emailTemplateRepo.findById(id);
  if (!t) throw notFound("Email template not found.");

  const data: Prisma.EmailTemplateUpdateInput = { version: { increment: 1 } };
  if (typeof input.name === "string" && input.name.trim()) data.name = input.name.trim();
  if (typeof input.category === "string" && input.category.trim()) {
    data.category = input.category.trim();
  }
  if (typeof input.subject === "string") data.subject = input.subject;
  // The admin edits the message (textContent); the HTML is regenerated from it.
  if (typeof input.textContent === "string") {
    // Guard system templates: the email is generated from these tokens, so a
    // save that drops a required one (e.g. the reset link) would silently ship a
    // broken/unusable email. Reject it with a clear message instead.
    const required = requiredVariablesFor(t.key);
    if (required.length > 0) {
      const subject = typeof input.subject === "string" ? input.subject : t.subject;
      const present = new Set(extractVariables(subject, input.textContent));
      const missing = required.filter((v) => !present.has(v));
      if (missing.length > 0) {
        throw badRequest(
          `This template must include ${missing.map((v) => `{{${v}}}`).join(", ")} — add it back before saving.`,
        );
      }
    }
    data.textContent = input.textContent;
    data.htmlContent = renderBodyToHtml(input.textContent);
    // For custom templates the admin defines the variables, so keep the chips in
    // sync with what's actually used. System templates keep their declared set
    // (the events that provide those values are fixed in code).
    if (!t.isSystem) {
      const subject = typeof input.subject === "string" ? input.subject : t.subject;
      data.variables = extractVariables(subject, input.textContent);
    }
  }
  if (typeof input.enabled === "boolean") data.enabled = input.enabled;

  const updated = await emailTemplateRepo.update(id, data);
  audit.record({
    actor,
    action: "email_template.updated",
    targetType: "email_template",
    targetId: id,
    targetLabel: updated.key,
  });
  return publicTemplate(updated);
}

export async function setEnabled(
  id: string,
  enabled: boolean,
  actor?: AuditActor,
): Promise<PublicEmailTemplate> {
  const t = await emailTemplateRepo.findById(id);
  if (!t) throw notFound("Email template not found.");
  const updated = await emailTemplateRepo.update(id, { enabled });
  audit.record({
    actor,
    action: enabled ? "email_template.enabled" : "email_template.disabled",
    targetType: "email_template",
    targetId: id,
    targetLabel: t.key,
  });
  return publicTemplate(updated);
}

export async function duplicateTemplate(
  id: string,
  actor?: AuditActor,
): Promise<PublicEmailTemplate> {
  const t = await emailTemplateRepo.findById(id);
  if (!t) throw notFound("Email template not found.");

  let key = `${t.key}.copy`;
  let n = 2;
  while (await emailTemplateRepo.findByKey(key)) key = `${t.key}.copy${n++}`;

  const created = await emailTemplateRepo.create({
    key,
    name: `${t.name} (copy)`,
    category: t.category,
    subject: t.subject,
    htmlContent: t.htmlContent,
    textContent: t.textContent,
    variables: t.variables,
    enabled: false,
    isSystem: false,
    version: 1,
  });
  audit.record({
    actor,
    action: "email_template.duplicated",
    targetType: "email_template",
    targetId: created.id,
    targetLabel: created.key,
  });
  return publicTemplate(created);
}

export async function restoreDefault(
  id: string,
  actor?: AuditActor,
): Promise<PublicEmailTemplate> {
  const t = await emailTemplateRepo.findById(id);
  if (!t) throw notFound("Email template not found.");
  const def = findDefaultTemplate(t.key);
  if (!def) throw badRequest("This template has no built-in default to restore.");

  const updated = await emailTemplateRepo.update(id, {
    name: def.name,
    category: def.category,
    subject: def.subject,
    htmlContent: renderBodyToHtml(def.body),
    textContent: def.body,
    variables: def.variables,
    version: { increment: 1 },
  });
  audit.record({
    actor,
    action: "email_template.restored",
    targetType: "email_template",
    targetId: id,
    targetLabel: t.key,
  });
  return publicTemplate(updated);
}

export async function deleteTemplate(id: string, actor?: AuditActor): Promise<void> {
  const t = await emailTemplateRepo.findById(id);
  if (!t) throw notFound("Email template not found.");
  if (t.isSystem) {
    throw forbidden("System templates can't be deleted — disable or restore it instead.");
  }
  await emailTemplateRepo.remove(id);
  audit.record({
    actor,
    action: "email_template.deleted",
    targetType: "email_template",
    targetId: id,
    targetLabel: t.key,
  });
}

export interface PreviewInput {
  subject?: string;
  // The unsaved message; the branded HTML is generated from it for the preview.
  textContent?: string;
}

// Render a template with sample variables. Accepts the unsaved message so the
// editor can preview live edits. Returns the rendered subject/html/text.
export async function previewTemplate(
  id: string,
  overrides: PreviewInput = {},
): Promise<{ subject: string; html: string; text: string }> {
  const t = await emailTemplateRepo.findById(id);
  if (!t) throw notFound("Email template not found.");
  const message = overrides.textContent ?? t.textContent;
  const vars = await buildSampleVars(t);
  return renderEmail(
    {
      subject: overrides.subject ?? t.subject,
      htmlContent: renderBodyToHtml(message),
      textContent: message,
    },
    vars,
  );
}

export async function sendTestTemplate(
  id: string,
  to: string,
): Promise<{ message: string }> {
  const t = await emailTemplateRepo.findById(id);
  if (!t) throw notFound("Email template not found.");
  const recipient = to.trim();
  if (!recipient) throw badRequest("Recipient email is required.");

  const vars = await buildSampleVars(t);
  const rendered = renderEmail(
    { subject: t.subject, htmlContent: t.htmlContent, textContent: t.textContent },
    vars,
  );

  try {
    await sendAndLog(
      {
        to: recipient,
        subject: `[TEST] ${rendered.subject}`,
        html: rendered.html,
        text: rendered.text,
      },
      t.key,
    );
    return { message: `Test email sent to ${recipient}.` };
  } catch (e) {
    throw badRequest(`Could not send: ${e instanceof Error ? e.message : "SMTP error."}`);
  }
}
