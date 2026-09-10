// Defaults for the public login-screen copy and footer, and the rule for what actually gets stored.
//
// The Branding form loads the EFFECTIVE (default-filled) values and posts every text field back on
// save. A naive write therefore freezes whichever default was current at that moment into the
// Settings row, and a later change to the default never reaches that install. That is how
// "Sign in to access your admin dashboard…" got stuck: it was retired because the login screen serves
// every staff role and every customer, not only admins — yet any install that had saved branding once
// kept showing it. Two rules keep a default a default:
//   • write — a value equal to a default (current or retired) is stored as null;
//   • read  — a stored retired default counts as unset, which repairs rows frozen before this rule.
//
// Mirrored by DEFAULT_BRANDING in frontend/src/lib/branding.ts (its fallback when this API is
// unreachable) — change both together.

interface LoginCopyField {
  fallback: string;
  // Earlier defaults that may already be frozen into existing rows. APPEND when a default changes —
  // never edit or remove an entry, or the rows it froze start showing it again.
  retired: readonly string[];
}

export const DEFAULT_LOGIN_HEADLINE = "Effortlessly manage your business and operations.";
export const DEFAULT_LOGIN_SUBTEXT =
  "Sign in to access your dashboard and run everything from one place.";

const LOGIN_HEADLINE: LoginCopyField = { fallback: DEFAULT_LOGIN_HEADLINE, retired: [] };
const LOGIN_SUBTEXT: LoginCopyField = {
  fallback: DEFAULT_LOGIN_SUBTEXT,
  retired: ["Sign in to access your admin dashboard and run everything from one place."],
};

function isDefault(field: LoginCopyField, value: string): boolean {
  return value === field.fallback || field.retired.includes(value);
}

// Stored value → what the login screen shows.
function resolve(field: LoginCopyField, stored: string | null | undefined): string {
  const value = (stored ?? "").trim();
  return value && !field.retired.includes(value) ? value : field.fallback;
}

// Submitted value → what the Settings row stores (null = "follow the default").
function toStored(field: LoginCopyField, input: string): string | null {
  const value = input.trim();
  return value && !isDefault(field, value) ? value : null;
}

export const resolveLoginHeadline = (stored: string | null | undefined) => resolve(LOGIN_HEADLINE, stored);
export const resolveLoginSubtext = (stored: string | null | undefined) => resolve(LOGIN_SUBTEXT, stored);
export const storedLoginHeadline = (input: string) => toStored(LOGIN_HEADLINE, input);
export const storedLoginSubtext = (input: string) => toStored(LOGIN_SUBTEXT, input);

// --- Brand name + footer ---------------------------------------------------------------------------
//
// The footer default carries the YEAR and the BRAND NAME, so unlike the login copy it cannot be
// matched as one fixed string. It is recognised by its shape instead — "© <year> <name>. All rights
// reserved." — where <name> is a brand name this install has used. Freezing it was worse than
// freezing the login copy: the year went stale every January, and a rebrand (the new brand name and
// the echoed footer arrive in the SAME save) stored "© 2026 Senthra" under the client's own brand.
//
// Only BRAND names are matched, never an arbitrary name: "© 2024 Electra Networks Limited. All rights
// reserved." under the brand "Electra" is a deliberate legal-name footer and is kept as typed.

export const DEFAULT_BRAND_NAME = "Senthra";

export function resolveBrandName(stored: string | null | undefined): string {
  return (stored ?? "").trim() || DEFAULT_BRAND_NAME;
}

export function defaultFooterText(brandName: string, year: number = new Date().getFullYear()): string {
  return `© ${year} ${brandName}. All rights reserved.`;
}

const DEFAULT_FOOTER_SHAPE = /^©\s*\d{4}\s+(.+?)\.\s+All rights reserved\.$/;

// Is `value` the default footer, for any year, of one of `brandNames`? The install default name
// always counts — it is the name every row was frozen under before its first rename.
function isDefaultFooter(value: string, brandNames: readonly string[]): boolean {
  const name = DEFAULT_FOOTER_SHAPE.exec(value)?.[1]?.trim();
  return name !== undefined && (name === DEFAULT_BRAND_NAME || brandNames.includes(name));
}

// Stored footer → what the login screen shows, under the current brand name.
export function resolveFooterText(stored: string | null | undefined, brandName: string): string {
  const value = (stored ?? "").trim();
  return value && !isDefaultFooter(value, [brandName]) ? value : defaultFooterText(brandName);
}

// Submitted footer → what the Settings row stores (null = "follow the default"). `brandNames` must
// hold the brand name both before AND after the save: a rename posts the new name together with the
// footer the form rendered under the old one.
export function storedFooterText(input: string, brandNames: readonly string[]): string | null {
  const value = input.trim();
  return value && !isDefaultFooter(value, brandNames) ? value : null;
}
