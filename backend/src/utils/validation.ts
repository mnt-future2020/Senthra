import { z } from "zod";

// Validation primitives shared by every account type (admin/staff/customer) so the
// rules are defined once and can't drift between modules. Module-specific fields
// (status enums, postcode/website, profile dates) stay in each module's validation.

// Email shape — intentionally lenient; real deliverability is proven by the invite /
// reset email, not the regex. Explicitly forbids ` , ; < > ` so a stored address can't
// smuggle a second recipient (comma/semicolon address-lists) or header brackets into a
// downstream `to:` field (e.g. the PO-to-supplier email).
export const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;

// UK phone only (client is a UK telecom field-services business): national "0" +
// 9–10 digits, or international "+44" with an optional "(0)" + 9–10 digits, after
// stripping spaces/hyphens/parens. Mirrored on the front-end (defence in depth).
export const UK_PHONE_RE = /^(?:\+440?|0)\d{9,10}$/;
export const isValidPhone = (v: string): boolean => UK_PHONE_RE.test(v.replace(/[\s()-]/g, ""));

// Required email field with a customizable "required" message.
export const emailField = (required = "Email is required.") =>
  z
    .string({ error: required })
    .trim()
    .min(1, required)
    .refine((v) => EMAIL_RE.test(v), "Enter a valid email address.");

// Optional phone field: an empty string is allowed (the service treats it as
// "clear"); any non-empty value must be a valid UK number.
export const optionalPhoneField = z
  .string()
  .trim()
  .max(40)
  .refine((v) => v === "" || isValidPhone(v), "Enter a valid phone number.")
  .optional();
