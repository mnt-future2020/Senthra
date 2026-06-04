// Built-in default email templates.
//
// Each template is defined as a plain-text `body` (the editable "message"). The
// branded HTML is generated from it (utils/email-html.ts) — admins never write
// HTML, they just edit the message. No product name is hardcoded: the brand is
// always the {{brandName}} token, resolved from Settings at send time.

export interface EmailTemplateDefault {
  key: string;
  name: string;
  category: "account" | "security" | "notification";
  subject: string;
  // Variables the system provides for this event (drives the editor's chips).
  variables: string[];
  // Tokens that MUST remain in the (subject + body) for the email to be usable.
  // Editing a system template that drops one of these is rejected, so an admin
  // can't accidentally ship, e.g., a password-reset email with no reset link.
  requiredVariables: string[];
  // The editable plain-text message (with {{tokens}}).
  body: string;
}

export const DEFAULT_EMAIL_TEMPLATES: EmailTemplateDefault[] = [
  {
    key: "user.created",
    name: "User Created",
    category: "account",
    subject: "Your {{brandName}} account has been created",
    variables: [
      "firstName",
      "lastName",
      "email",
      "roleName",
      "temporaryPassword",
      "brandName",
      "loginUrl",
      "supportEmail",
      "currentYear",
    ],
    // Without the credentials the recipient can't access the account at all.
    requiredVariables: ["email", "temporaryPassword"],
    body: `Welcome, {{firstName}} 👋

An account has been created for you on {{brandName}} with the role {{roleName}}.

Use the temporary password below to get started:
Email: {{email}}
Temporary password: {{temporaryPassword}}

Please keep this password safe. Sign-in access is being set up — once it's enabled you'll be asked to choose your own password on first login.

— {{brandName}}`,
  },
  {
    key: "auth.password_reset",
    name: "Password Reset",
    category: "security",
    subject: "Reset your {{brandName}} password",
    variables: ["firstName", "resetPasswordLink", "brandName", "currentYear"],
    // Without the link the email is useless and silently locks users out.
    requiredVariables: ["resetPasswordLink"],
    body: `Hi {{firstName}},

We received a request to reset your {{brandName}} password.

Reset it here: {{resetPasswordLink}}

This link is valid for 1 hour. If you didn't request this, you can safely ignore this email.`,
  },
];

export function findDefaultTemplate(key: string): EmailTemplateDefault | undefined {
  return DEFAULT_EMAIL_TEMPLATES.find((t) => t.key === key);
}

// Tokens that must stay present in a system template's content. Empty for keys
// with no built-in default (custom templates impose no requirement).
export function requiredVariablesFor(key: string): string[] {
  return findDefaultTemplate(key)?.requiredVariables ?? [];
}
