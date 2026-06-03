import { sendMail, type MailMessage } from "../lib/mailer.js";
import * as settingsRepo from "../repositories/settings.repository.js";
import { decryptSecret } from "../utils/crypto.js";

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
