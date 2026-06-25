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
    key: "customer.created",
    name: "Customer Account Created",
    category: "account",
    subject: "Your {{brandName}} customer portal access",
    variables: [
      "customerName",
      "contactPerson",
      "email",
      "temporaryPassword",
      "brandName",
      "loginUrl",
      "supportEmail",
      "currentYear",
    ],
    // Without the credentials the recipient can't access the portal at all.
    requiredVariables: ["email", "temporaryPassword"],
    body: `Hello {{contactPerson}} 👋

A read-only customer portal account has been created for {{customerName}} on {{brandName}}, where you can view your stock.

Use the temporary password below to sign in:
Email: {{email}}
Temporary password: {{temporaryPassword}}

Sign in here: {{loginUrl}}

You'll be asked to choose your own password on first login. Please keep these details safe.

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
  {
    key: "po.sent",
    name: "Purchase Order Sent",
    category: "notification",
    subject: "Purchase Order {{poCode}} from {{companyLegalName}}",
    variables: [
      "supplierName",
      "contactPerson",
      "poCode",
      "orderDate",
      "expectedDeliveryDate",
      "grandTotal",
      "companyLegalName",
      "brandName",
      "currentYear",
    ],
    // The PO number ties the email to its attached document; it must stay in the message.
    requiredVariables: ["poCode"],
    // Deliberately short — the full order (items, totals, addresses) lives in the attached PDF,
    // which is the source of truth. Never inline the whole PO in the body.
    body: `Hello {{supplierName}},

Please find attached Purchase Order {{poCode}}. The order details, items and totals are in the attached PDF.

If you have any questions, just reply to this email.

Regards,
{{companyLegalName}}`,
  },
  {
    key: "po.cancelled",
    name: "Purchase Order Cancelled",
    category: "notification",
    subject: "Purchase Order {{poCode}} has been cancelled",
    variables: ["supplierName", "contactPerson", "poCode", "companyLegalName", "brandName", "currentYear"],
    requiredVariables: ["poCode"],
    body: `Hello {{supplierName}},

Purchase Order {{poCode}} has been cancelled. Please disregard the original order.

If anything has already been dispatched, contact us before sending it.

Regards,
{{companyLegalName}}`,
  },
  {
    key: "job.assigned",
    name: "Job Assigned to Engineer",
    category: "notification",
    subject: "You've been assigned job {{jobNumber}}",
    variables: ["engineerName", "jobNumber", "jobName", "brandName", "loginUrl", "currentYear"],
    // The job number ties the email to the work; it must stay in the message.
    requiredVariables: ["jobNumber"],
    body: `Hello {{engineerName}},

You have been assigned job {{jobNumber}} — {{jobName}}.

Sign in to view the details and accept it: {{loginUrl}}

— {{brandName}}`,
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
