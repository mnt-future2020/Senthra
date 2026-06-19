import { env } from "../../config/env.js";
import { sendMail, type MailAttachment, type MailMessage } from "../../lib/mailer.js";
import * as emailLogRepo from "./emailLog.repository.js";
import * as emailTemplateRepo from "./emailTemplate.repository.js";
import * as settingsRepo from "#modules/settings/settings.repository.js";
import { decryptSecret } from "../../utils/crypto.js";
import { buildEmailHeaderRow, renderBodyToHtml, safeBrandColor } from "../../utils/email-html.js";
import { renderEmail, type TemplateVars } from "../../utils/template-render.js";
import { findDefaultTemplate } from "./emailTemplate.defaults.js";

// Send an email using the SMTP settings configured in the dashboard (Settings ->
// Email). Throws if SMTP isn't configured, so callers can decide how to handle it.
export async function sendConfiguredEmail(message: MailMessage) {
  const s = await settingsRepo.findFirst();
  if (!s || !s.smtpHost || !s.smtpPort || !s.smtpFromEmail || !s.smtpPassword) {
    throw new Error("SMTP is not configured.");
  }
  return sendMail(
    {
      host: s.smtpHost,
      port: s.smtpPort,
      secure: s.smtpSecure,
      username: s.smtpUsername ?? "",
      password: decryptSecret(s.smtpPassword) ?? "",
      fromName: s.smtpFromName ?? "",
      fromEmail: s.smtpFromEmail,
    },
    message,
  );
}

// Brand-level variables injected into every templated email so individual
// callers only need to pass event-specific values. Caller-provided vars override.
export async function resolveBrandVars(): Promise<TemplateVars> {
  const s = await settingsRepo.getOrCreate();
  const brandName = s.brandName?.trim() || "Senthra";
  const logoUrl = s.logoUrl?.trim() || "";
  const brandColor = safeBrandColor(s.brandColor);
  return {
    brandName,
    brandColor,
    logoUrl,
    currentYear: new Date().getFullYear(),
    supportEmail: s.smtpFromEmail || "",
    loginUrl: `${env.FRONTEND_URL}/login`,
    // Trusted HTML (see RAW_HTML_KEYS in template-render) — the logo-aware header.
    emailHeaderRow: buildEmailHeaderRow(brandName, logoUrl, brandColor),
  };
}

type EmailLogStatus = "sent" | "failed" | "skipped";

interface EmailLogInput {
  to: string;
  subject: string;
  templateKey?: string | null;
  status: EmailLogStatus;
  error?: string;
  messageId?: string;
}

// Write a delivery-log row. Never throws — logging must not break a send.
async function logEmail(input: EmailLogInput): Promise<void> {
  try {
    await emailLogRepo.create({
      to: input.to,
      subject: input.subject,
      templateKey: input.templateKey ?? null,
      status: input.status,
      error: input.error ?? null,
      messageId: input.messageId ?? null,
    });
  } catch (e) {
    console.error("Email log write failed:", e instanceof Error ? e.message : e);
  }
}

interface SendTemplatedOptions {
  // Send even when the template is disabled. Used for transactional account /
  // security emails (account created, password reset) that must always go out.
  force?: boolean;
  // Files to attach (e.g. the Purchase Order PDF). Passed straight to the transport.
  attachments?: MailAttachment[];
}

// Render a stored template and send it. The DB row is the source of truth; the
// built-in default is used as a fallback if the row is missing (e.g. before the
// first seed). Every outcome (sent / failed / skipped) is written to the
// delivery log. Throws on send failure so fire-and-forget callers can `.catch`.
export async function sendTemplatedEmail(
  key: string,
  to: string,
  vars: TemplateVars = {},
  opts: SendTemplatedOptions = {},
): Promise<void> {
  const row = await emailTemplateRepo.findByKey(key);

  // The DB row is the source of truth; fall back to the built-in default (its
  // HTML generated from the message) if the row is somehow missing.
  let renderable: { subject: string; htmlContent: string; textContent: string };
  if (row) {
    // A disabled template is skipped unless the caller forces it.
    if (!row.enabled && !opts.force) {
      await logEmail({ to, subject: row.subject, templateKey: key, status: "skipped" });
      return;
    }
    renderable = {
      subject: row.subject,
      htmlContent: row.htmlContent,
      textContent: row.textContent,
    };
  } else {
    const def = findDefaultTemplate(key);
    if (!def) throw new Error(`Email template "${key}" not found.`);
    renderable = {
      subject: def.subject,
      htmlContent: renderBodyToHtml(def.body),
      textContent: def.body,
    };
  }

  const merged: TemplateVars = { ...(await resolveBrandVars()), ...vars };
  const rendered = renderEmail(renderable, merged);

  try {
    const info = await sendConfiguredEmail({
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      attachments: opts.attachments,
    });
    await logEmail({
      to,
      subject: rendered.subject,
      templateKey: key,
      status: "sent",
      messageId: info?.messageId,
    });
  } catch (e) {
    await logEmail({
      to,
      subject: rendered.subject,
      templateKey: key,
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

// Send an already-rendered email (used by the template "send test" action) and
// log the outcome. Surfaces SMTP errors to the caller for the UI to show.
export async function sendAndLog(
  message: MailMessage,
  templateKey?: string,
): Promise<{ messageId?: string }> {
  try {
    const info = await sendConfiguredEmail(message);
    await logEmail({
      to: message.to,
      subject: message.subject,
      templateKey: templateKey ?? null,
      status: "sent",
      messageId: info?.messageId,
    });
    return { messageId: info?.messageId };
  } catch (e) {
    await logEmail({
      to: message.to,
      subject: message.subject,
      templateKey: templateKey ?? null,
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}
