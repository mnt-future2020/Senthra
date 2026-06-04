// Render email templates by substituting {{variable}} tokens.
//
// Variable VALUES are HTML-escaped when rendering the HTML body, so a
// user-supplied value (e.g. a name containing "<") can never inject markup or
// break an attribute. The subject and plain-text parts are not HTML, so their
// values are substituted raw. Unknown tokens render as an empty string.

export type TemplateVars = Record<string, string | number | null | undefined>;

export interface RenderableTemplate {
  subject: string;
  htmlContent: string;
  textContent: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// Matches {{key}} and {{ key }} (keys may contain letters, digits, _ and .).
const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;

// Escape a value for safe insertion into HTML text or a double-quoted attribute.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function substitute(
  template: string,
  vars: TemplateVars,
  escape: boolean,
  rawKeys?: Set<string>,
): string {
  return template.replace(TOKEN, (_match, key: string) => {
    const raw = vars[key];
    const value = raw == null ? "" : String(raw);
    const shouldEscape = escape && !rawKeys?.has(key);
    return shouldEscape ? escapeHtml(value) : value;
  });
}

// List the distinct {{variables}} referenced across the given template parts.
export function extractVariables(...parts: string[]): string[] {
  const found = new Set<string>();
  for (const part of parts) {
    for (const match of part.matchAll(TOKEN)) found.add(match[1]);
  }
  return [...found];
}

// System tokens whose value is trusted HTML we build ourselves (e.g. the branded
// header with the logo) — these are NOT HTML-escaped when rendering the body.
const RAW_HTML_KEYS = new Set(["emailHeaderRow"]);

export function renderEmail(template: RenderableTemplate, vars: TemplateVars): RenderedEmail {
  return {
    subject: substitute(template.subject, vars, false),
    html: substitute(template.htmlContent, vars, true, RAW_HTML_KEYS),
    text: substitute(template.textContent, vars, false),
  };
}
