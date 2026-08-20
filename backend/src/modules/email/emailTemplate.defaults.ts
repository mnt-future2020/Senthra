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
    key: "rental_deadline_reminder",
    name: "Rental Deadline Reminder",
    category: "notification",
    subject: "Rental ending soon — {{itemName}} ({{poCode}})",
    variables: ["poCode", "itemName", "quantity", "hireEndDate", "brandName", "currentYear"],
    // The PO number and the date are what make the message actionable; without either it is noise.
    requiredVariables: ["poCode", "hireEndDate"],
    // INFORMATIONAL ONLY, and that is a constraint rather than a style choice: reminder delivery is
    // at-least-once (SMTP has no idempotency key), so a duplicate copy must do nothing the first
    // did not. No one-time credential, no action token, no link that changes state.
    body: `The hire below is due to end.

Purchase order: {{poCode}}
Item: {{itemName}} (x{{quantity}})
Hire ends: {{hireEndDate}}

Arrange the return, or extend the hire on the purchase order.`,
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
  {
    key: "po.submitted",
    name: "Purchase Order Submitted for Approval",
    category: "notification",
    subject: "Purchase Order {{poCode}} awaiting your approval",
    variables: [
      "approverName",
      "poCode",
      "supplierName",
      "grandTotal",
      "submittedBy",
      "brandName",
      "loginUrl",
      "currentYear",
    ],
    // The PO number identifies which order needs approval; it must stay in the message.
    requiredVariables: ["poCode"],
    body: `Hello {{approverName}},

Purchase Order {{poCode}} for {{supplierName}} ({{grandTotal}}) has been submitted for approval by {{submittedBy}} and is awaiting your decision.

Review and approve or reject it here: {{loginUrl}}

— {{brandName}}`,
  },
  {
    key: "prf.submitted",
    name: "Purchase Request Submitted for Finance Review",
    category: "notification",
    subject: "Purchase Request {{prfCode}} awaiting your review",
    variables: [
      "reviewerName",
      "prfCode",
      "supplierName",
      "estimatedCost",
      "requestedBy",
      "brandName",
      "loginUrl",
      "currentYear",
    ],
    // The PRF number identifies which request needs review; it must stay in the message.
    requiredVariables: ["prfCode"],
    body: `Hello {{reviewerName}},

Purchase Request {{prfCode}} for {{supplierName}} ({{estimatedCost}}) has been submitted by {{requestedBy}} and is awaiting your finance review.

Review and approve or reject it here: {{loginUrl}}

— {{brandName}}`,
  },
  {
    key: "prf.approved",
    name: "Purchase Request Approved",
    category: "notification",
    subject: "Purchase Request {{prfCode}} has been approved",
    variables: ["prfCode", "supplierName", "estimatedCost", "brandName", "loginUrl", "currentYear"],
    requiredVariables: ["prfCode"],
    body: `Hello,

Your Purchase Request {{prfCode}} for {{supplierName}} ({{estimatedCost}}) has been approved by Finance. A purchase order will be generated from it.

View it here: {{loginUrl}}

— {{brandName}}`,
  },
  {
    key: "prf.rejected",
    name: "Purchase Request Rejected",
    category: "notification",
    subject: "Purchase Request {{prfCode}} needs rework",
    variables: ["prfCode", "supplierName", "estimatedCost", "reason", "brandName", "loginUrl", "currentYear"],
    requiredVariables: ["prfCode"],
    body: `Hello,

Your Purchase Request {{prfCode}} for {{supplierName}} was not approved and has been returned to draft.

Reason: {{reason}}

Update and resubmit it here: {{loginUrl}}

— {{brandName}}`,
  },
  {
    key: "po.pm_assigned",
    name: "Purchase Order Routed to Project Manager",
    category: "notification",
    subject: "Purchase Order {{poCode}} awaiting your review and send",
    variables: [
      "pmName",
      "poCode",
      "supplierName",
      "grandTotal",
      "expectedDeliveryDate",
      "assignedBy",
      "brandName",
      "loginUrl",
      "currentYear",
    ],
    requiredVariables: ["poCode"],
    body: `Hello {{pmName}},

Purchase Order {{poCode}} for {{supplierName}} ({{grandTotal}}) has been routed to you by {{assignedBy}}. Please review it and send it to the supplier.

Review and send it here: {{loginUrl}}

— {{brandName}}`,
  },
  {
    key: "customer.stock_request.reviewed",
    name: "Customer Stock Request Decision",
    category: "notification",
    // {{status}} is "approved" or "rejected" — the sender supplies the outcome and a
    // matching {{decisionDetail}} line (approval note or rejection reason), since the
    // template engine has no conditionals.
    subject: "Your stock request has been {{status}}",
    variables: [
      "customerName",
      "contactPerson",
      "requestName",
      "status",
      "decisionDetail",
      "brandName",
      "loginUrl",
      "currentYear",
    ],
    // The outcome is the whole point of the email; it must stay in the message.
    requiredVariables: ["status"],
    body: `Hello {{contactPerson}},

Your stock request "{{requestName}}" has been {{status}}.

{{decisionDetail}}

You can view the latest status in your portal: {{loginUrl}}

— {{brandName}}`,
  },
  {
    key: "job.rejected",
    name: "Job Rejected by Engineer",
    category: "notification",
    subject: "Job {{jobNumber}} was declined by {{engineerName}}",
    variables: [
      "recipientName",
      "jobNumber",
      "jobName",
      "engineerName",
      "rejectReason",
      "brandName",
      "loginUrl",
      "currentYear",
    ],
    // The job number ties the email to the work that now needs reassigning.
    requiredVariables: ["jobNumber"],
    body: `Hello {{recipientName}},

Job {{jobNumber}} — {{jobName}} — has been declined by {{engineerName}} and needs to be reassigned.

Reason: {{rejectReason}}

Reassign or review it here: {{loginUrl}}

— {{brandName}}`,
  },
  {
    key: "auth.password_changed",
    name: "Password Changed Confirmation",
    category: "security",
    subject: "Your {{brandName}} password was changed",
    variables: ["firstName", "brandName", "supportEmail", "currentYear"],
    // A security confirmation carries no action link; nothing is strictly required
    // beyond the brand tokens, which are always injected.
    requiredVariables: [],
    body: `Hi {{firstName}},

This is a confirmation that your {{brandName}} password was just changed.

If you made this change, no action is needed. If you did NOT change your password, contact us immediately at {{supportEmail}}.

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
