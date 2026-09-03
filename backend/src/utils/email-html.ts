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

// Force a raster PNG and cap a Cloudinary logo's height for email (retina 2x of the 40px display).
//
// `f_png` is not an optimisation — it is what makes the header work at all for the vector formats
// branding accepts. Gmail and Outlook don't render an SVG `<img>` (Apple Mail does), so an admin who
// uploads a vector wordmark would otherwise get a bare alt-text header in most inboxes. Rasterising
// at DELIVERY leaves the stored URL untouched, so the sidebar and login keep serving the crisp
// original. PNG rather than JPEG because a logo is normally transparent, and JPEG would replace that
// transparency with a white rectangle sitting on the brand-colour bar.
//
// Deliberately NOT f_auto: that serves webp/avif, which email clients don't reliably render. The PO
// PDF letterhead rasterises this same asset for its own reason (pdfkit embeds only PNG/JPEG — see
// `pdfSafeImageUrl`) and shares the `f_png` + `/upload/f_` guard convention. It does NOT share the
// height, and the two should not be made to: 400px is sized for print, 80px is retina for a 34px
// logo in a mail client. Keep the convention in step; leave the heights apart.
//
// The `/upload/f_` guard is what keeps this idempotent, and it must match the prefix written below:
// a guard on `h_` stops matching once the transform starts with `f_png`, which would apply the whole
// transform twice. No-op for non-Cloudinary URLs.
function emailLogoSrc(url: string): string {
  if (
    url.includes("res.cloudinary.com/") &&
    url.includes("/upload/") &&
    !url.includes("/upload/f_")
  ) {
    return url.replace("/upload/", "/upload/f_png,h_80,c_limit/");
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

// Build the email header row: the brand-colour bar showing EITHER the logo (if set)
// OR the brand name as text — never both. Most brand logos are wordmarks that already
// contain the name, so printing {{brandName}} beside the logo duplicates it. When a
// logo is present the brand name is carried as the image's `alt` (styled so it stays
// legible in clients that block images); otherwise the name renders as styled text,
// its colour auto-adapting to the accent. Returned as trusted HTML (dynamic parts
// escaped here) and injected via the {{emailHeaderRow}} token at send time.
export function buildEmailHeaderRow(
  brandName: string,
  logoUrl: string,
  brandColor: string = DEFAULT_BRAND_COLOR,
): string {
  const bg = safeBrandColor(brandColor);
  const fg = readableTextOn(bg);

  if (logoUrl) {
    // Logo only. The `alt` doubles as the fallback wordmark; the extra font/colour
    // styles on the <img> are what many clients apply to alt text when the image is
    // blocked, so the brand name stays readable on the accent bar either way.
    return `<tr>
              <td style="background:${escapeHtml(bg)};padding:18px 32px;">
                <img src="${escapeHtml(emailLogoSrc(logoUrl))}" alt="${escapeHtml(brandName)}" height="34" style="max-height:34px;width:auto;border:0;outline:none;text-decoration:none;display:block;color:${fg};font-size:16px;font-weight:800;" />
              </td>
            </tr>`;
  }

  const name = `<span style="font-size:18px;font-weight:800;color:${fg};letter-spacing:-0.2px;vertical-align:middle;">${escapeHtml(brandName)}</span>`;
  return `<tr>
            <td style="background:${escapeHtml(bg)};padding:22px 32px;">
              ${name}
            </td>
          </tr>`;
}

// Tokens whose value is a secret the recipient has to copy by hand. A line holding
// one of these ALONE (optionally behind a "Label:") is lifted out of the prose into
// a credential card, so the value sits on its own selectable line.
const CREDENTIAL_TOKENS = new Set(["temporaryPassword"]);

// Tokens that aren't secret but belong WITH the credentials when they sit right
// beside them (so "Email: … / Temporary password: …" reads as one block). On their
// own, elsewhere in a message, they stay ordinary prose. `mailto` marks a value we
// wrap in our own anchor — otherwise Gmail auto-links the address and restyles it
// as blue underlined text inside the card.
const COMPANION_TOKENS = new Map<string, { mailto: boolean }>([["email", { mailto: true }]]);

// Monospace so ambiguous glyphs stay distinguishable and the value reads as data.
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

// A whole line that is `Label: {{token}}` or a bare `{{token}}` — nothing else on it.
const CREDENTIAL_LINE = /^(?:([^:{}]{1,60}?)\s*:\s*)?\{\{\s*([\w.]+)\s*\}\}$/;

interface CredentialField {
  // The label the admin typed, printed above the value ("" when the line was a
  // bare token). Detection is by token, never by this text, so renaming or
  // translating the label can't break the card.
  label: string;
  token: string;
  secret: boolean;
  mailto: boolean;
}

function matchCredentialLine(line: string): CredentialField | null {
  const m = CREDENTIAL_LINE.exec(line.trim());
  if (!m) return null;
  const token = m[2];
  const companion = COMPANION_TOKENS.get(token);
  const secret = CREDENTIAL_TOKENS.has(token);
  if (!secret && !companion) return null;
  return {
    label: (m[1] ?? "").trim(),
    token,
    secret,
    mailto: companion?.mailto ?? false,
  };
}

// The value element: the token and NOTHING else, so a triple-click (desktop) or
// long-press (mobile) selects exactly the credential. `user-select:all` upgrades
// that to a single click in clients that honour it; the rest fall back to the
// line selection above. Email can't run JavaScript, so a copy button isn't possible.
function credentialValue(f: CredentialField): string {
  const size = f.secret ? "18px" : "15px";
  const weight = f.secret ? "700" : "500";
  const spacing = f.secret ? "letter-spacing:0.5px;" : "";
  const style =
    `font-family:${MONO};font-size:${size};font-weight:${weight};${spacing}` +
    `color:#1a1a2e;word-break:break-all;-webkit-user-select:all;user-select:all;`;
  const token = `{{${f.token}}}`;
  const inner = f.mailto
    ? `<a href="mailto:${token}" style="color:#1a1a2e;text-decoration:none;">${token}</a>`
    : token;
  return `<div style="${style}">${inner}</div>`;
}

// One bordered block holding a run of credential lines.
function credentialCard(fields: CredentialField[]): string {
  const rows = fields.map((f, i) => {
    const divider = i === 0 ? "" : "border-top:1px solid #e6e6f0;";
    const label = f.label
      ? `<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#8a8aa3;margin:0 0 6px;">${escapeHtml(f.label)}</div>`
      : "";
    return `<tr>
                  <td style="padding:14px 18px;${divider}">${label}${credentialValue(f)}</td>
                </tr>`;
  });
  return `<table class="credential-card" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;background:#f7f7fb;border:1px solid #e3e3ee;border-radius:10px;">
${rows.join("\n")}
                </table>`;
}

// Format one (already paragraph-split) block of the message into inline HTML.
function formatParagraph(paragraph: string): string {
  let html = escapeHtml(paragraph);

  // Make URL-ish tokens clickable, e.g. {{loginUrl}}, {{resetPasswordLink}}.
  html = html.replace(/\{\{\s*(\w*(?:[Uu]rl|[Ll]ink))\s*\}\}/g, (_m, name: string) => {
    const token = `{{${name}}}`;
    return `<a href="${token}" style="${LINK_STYLE}">${token}</a>`;
  });

  // A credential used mid-sentence can't get its own card, but it still renders as
  // a distinct monospace run so the value never blends into the prose.
  html = html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) =>
    CREDENTIAL_TOKENS.has(name)
      ? `<span style="font-family:${MONO};font-weight:700;-webkit-user-select:all;user-select:all;">{{${name}}}</span>`
      : match,
  );

  // Make literal URLs the admin typed clickable.
  html = html.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" style="${LINK_STYLE}">${url}</a>`,
  );

  // Single newlines inside a paragraph become line breaks.
  html = html.replace(/\n/g, "<br>");
  return `<p style="${P_STYLE}">${html}</p>`;
}

// Render one paragraph, splitting off any run of credential lines into its own card.
function renderParagraph(paragraph: string): string {
  const lines = paragraph.split("\n");
  const fields = lines.map(matchCredentialLine);

  // Fast path: no secret anywhere in this paragraph → plain prose, byte-for-byte
  // what this renderer produced before credential cards existed.
  if (!fields.some((f) => f?.secret)) return formatParagraph(paragraph);

  // A run of companion-only lines isn't a credential block — demote it back to prose.
  for (let i = 0; i < fields.length; ) {
    if (!fields[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < fields.length && fields[j]) j++;
    if (!fields.slice(i, j).some((f) => f?.secret)) fields.fill(null, i, j);
    i = j;
  }

  const out: string[] = [];
  let prose: string[] = [];
  let card: CredentialField[] = [];
  const flushProse = () => {
    if (prose.length > 0) out.push(formatParagraph(prose.join("\n")));
    prose = [];
  };
  const flushCard = () => {
    if (card.length > 0) out.push(credentialCard(card));
    card = [];
  };

  fields.forEach((field, i) => {
    if (field) {
      flushProse();
      card.push(field);
    } else {
      flushCard();
      prose.push(lines[i]);
    }
  });
  flushProse();
  flushCard();

  return out.join("\n");
}

// Render a plain-text message into the branded HTML email. Blank lines separate
// paragraphs; single newlines become <br>.
export function renderBodyToHtml(message: string): string {
  const paragraphs = message
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n\s*\n/)
    .filter((p) => p.length > 0);

  const body = paragraphs.map(renderParagraph).join("\n");
  return frame(body);
}
