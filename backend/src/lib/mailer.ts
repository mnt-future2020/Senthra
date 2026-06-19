import nodemailer, { type Transporter } from "nodemailer";

// Plain SMTP configuration consumed by the transport. Nullable settings from the
// database are normalized to empty strings by callers before reaching here.
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromName: string;
  fromEmail: string;
}

// A file attached to an email. `content` is the raw bytes (Buffer) or a string; nodemailer
// streams it as-is. Used for the Purchase Order PDF (and future document attachments).
export interface MailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: MailAttachment[];
}

// Build a nodemailer transport from a plain SMTP config object.
// `secure: true` uses implicit TLS (port 465); `false` upgrades via STARTTLS (587).
export function buildTransport(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port),
    secure: Boolean(cfg.secure),
    auth:
      cfg.username || cfg.password
        ? { user: cfg.username, pass: cfg.password }
        : undefined,
    // TLS certificates are verified by default (production-safe). Do NOT disable
    // verification — it would allow MITM attacks. Use a properly-issued cert.
  });
}

// Format the "From" header — `"Name" <email>` when a name is set, else the address.
function formatFrom(cfg: SmtpConfig): string {
  return cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail;
}

// Verify the SMTP credentials/connection without sending anything.
export async function verifyTransport(cfg: SmtpConfig): Promise<boolean> {
  const transport = buildTransport(cfg);
  await transport.verify();
  return true;
}

// Send an email using the given SMTP config.
export function sendMail(cfg: SmtpConfig, message: MailMessage) {
  const transport = buildTransport(cfg);
  return transport.sendMail({ from: formatFrom(cfg), ...message });
}
