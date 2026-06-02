import { prisma } from "./prisma.js";
import { sendMail } from "./mailer.js";
import { decryptSecret } from "./secrets.js";

// Send an email using the SMTP settings configured in the dashboard Settings → Email.
// Throws if SMTP isn't configured, so callers can decide how to handle it.
export async function sendConfiguredEmail({ to, subject, text, html }) {
  const s = await prisma.settings.findFirst();
  if (!s || !s.smtpHost || !s.smtpPort || !s.smtpFromEmail || !s.smtpPassword) {
    throw new Error("SMTP is not configured.");
  }
  const cfg = {
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpSecure,
    username: s.smtpUsername,
    password: decryptSecret(s.smtpPassword),
    fromName: s.smtpFromName,
    fromEmail: s.smtpFromEmail,
  };
  return sendMail(cfg, { to, subject, text, html });
}
