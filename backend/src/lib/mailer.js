import nodemailer from "nodemailer";

// Build a nodemailer transport from a plain SMTP config object.
// `secure: true` uses implicit TLS (port 465); `false` upgrades via STARTTLS (587).
export function buildTransport(cfg) {
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
function formatFrom(cfg) {
  if (cfg.fromName) return `"${cfg.fromName}" <${cfg.fromEmail}>`;
  return cfg.fromEmail;
}

// Verify the SMTP credentials/connection without sending anything.
export async function verifyTransport(cfg) {
  const transport = buildTransport(cfg);
  await transport.verify();
  return true;
}

// Send an email using the given SMTP config.
export async function sendMail(cfg, { to, subject, text, html }) {
  const transport = buildTransport(cfg);
  return transport.sendMail({ from: formatFrom(cfg), to, subject, text, html });
}
