import { escapeHtml } from "./template-render.js";

// Turns a plain-text "message" (what a non-technical admin types) into branded,
// email-client-safe HTML. The admin never writes HTML — they just type, and this
// wraps their words in a fixed, professional frame.
//
// Tokens like {{firstName}} pass through untouched (escapeHtml doesn't affect
// `{` / `}`) and are substituted at send time. Variable VALUES are escaped then,
// so this stays safe even though the structural HTML below is raw.

// The brand accent used across the app and in emails. The default matches the
// dashboard's default accent; the configured value comes from Settings.
export const DEFAULT_BRAND_COLOR = "#7b6ef0";

// Validate a stored/incoming brand color, falling back to the default. Keeps a
// malformed value from ever reaching an inline style attribute.
export function safeBrandColor(value: string | null | undefined): string {
  const v = value?.trim();
  // Only valid CSS hex lengths (3/4/6/8 digits) — keeps a malformed value from
  // ever reaching an inline style or the dashboard's `--accent` property.
  return v && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)
    ? v
    : DEFAULT_BRAND_COLOR;
}

// Links use a {{brandColor}} token (resolved from Settings at send time, like
// {{brandName}}), so changing the brand accent restyles emails without having to
// re-save every template.
const LINK_STYLE = "color:{{brandColor}};text-decoration:underline;";
const P_STYLE = "font-size:14px;line-height:1.65;color:#3a3a52;margin:0 0 16px;";

// Fixed, inline-styled, table-based frame (renders consistently across email
// clients). Brand name + year are tokens resolved at send time.
function frame(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a2e;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
            {{emailHeaderRow}}
            <tr>
              <td style="padding:32px;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;border-top:1px solid #ececf3;">
                <span style="font-size:12px;color:#9a9ab0;">&copy; {{currentYear}} {{brandName}}. All rights reserved.</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Cap a Cloudinary logo's height for email (retina 2x of the 40px display) and
// keep the original format — email clients don't reliably render webp/avif, so
// we avoid f_auto here. No-op for non-Cloudinary URLs.
function emailLogoSrc(url: string): string {
  if (
    url.includes("res.cloudinary.com/") &&
    url.includes("/upload/") &&
    !url.includes("/upload/h_")
  ) {
    return url.replace("/upload/", "/upload/h_80,c_limit/");
  }
  return url;
}

// Pick a legible text colour (near-black or white) to place ON the brand colour,
// from its perceived luminance — so the header name stays readable whatever
// accent the admin picks.
function readableTextOn(hex: string): string {
  let h = hex.replace("#", "");
  // Expand shorthand (#rgb / #rgba → #rrggbb / #rrggbbaa).
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length < 6) return "#ffffff";
  // Drop any alpha channel — only RGB drives perceived luminance.
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#1a1a2e" : "#ffffff";
}

// Build the email header row: the brand-colour bar showing the logo (if set)
// alongside the brand name. The name's colour auto-adapts to the accent for
// legibility. Returned as trusted HTML (dynamic parts escaped here) and injected
// via the {{emailHeaderRow}} token at send time, so logo + colour stay dynamic.
export function buildEmailHeaderRow(
  brandName: string,
  logoUrl: string,
  brandColor: string = DEFAULT_BRAND_COLOR,
): string {
  const bg = safeBrandColor(brandColor);
  const name = `<span style="font-size:18px;font-weight:800;color:${readableTextOn(bg)};letter-spacing:-0.2px;vertical-align:middle;">${escapeHtml(brandName)}</span>`;

  if (logoUrl) {
    return `<tr>
              <td style="background:${escapeHtml(bg)};padding:16px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="vertical-align:middle;padding-right:12px;">
                      <img src="${escapeHtml(emailLogoSrc(logoUrl))}" alt="${escapeHtml(brandName)}" height="34" style="max-height:34px;width:auto;border:0;outline:none;text-decoration:none;display:block;" />
                    </td>
                    <td style="vertical-align:middle;">${name}</td>
                  </tr>
                </table>
              </td>
            </tr>`;
  }
  return `<tr>
            <td style="background:${escapeHtml(bg)};padding:22px 32px;">
              ${name}
            </td>
          </tr>`;
}

// Format one (already paragraph-split) block of the message into inline HTML.
function formatParagraph(paragraph: string): string {
  let html = escapeHtml(paragraph);

  // Make URL-ish tokens clickable, e.g. {{loginUrl}}, {{resetPasswordLink}}.
  html = html.replace(/\{\{\s*(\w*(?:[Uu]rl|[Ll]ink))\s*\}\}/g, (_m, name: string) => {
    const token = `{{${name}}}`;
    return `<a href="${token}" style="${LINK_STYLE}">${token}</a>`;
  });

  // Make literal URLs the admin typed clickable.
  html = html.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" style="${LINK_STYLE}">${url}</a>`,
  );

  // Single newlines inside a paragraph become line breaks.
  html = html.replace(/\n/g, "<br>");
  return `<p style="${P_STYLE}">${html}</p>`;
}

// Render a plain-text message into the branded HTML email. Blank lines separate
// paragraphs; single newlines become <br>.
export function renderBodyToHtml(message: string): string {
  const paragraphs = message
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n\s*\n/)
    .filter((p) => p.length > 0);

  const body = paragraphs.map(formatParagraph).join("\n");
  return frame(body);
}
