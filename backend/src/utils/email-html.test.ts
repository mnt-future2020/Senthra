import { describe, expect, it } from "vitest";

import { buildEmailHeaderRow, DEFAULT_BRAND_COLOR, renderBodyToHtml } from "./email-html.js";
import { renderEmail } from "./template-render.js";

// The generated email HTML is what recipients actually see, and the account-creation
// email carries a credential they must copy by hand. These guard the two things that
// can silently break it: the credential losing its own selectable line, and a value
// with HTML-significant characters escaping into markup.

function credentialCards(html: string): string[] {
  return [...html.matchAll(/<table class="credential-card"[\s\S]*?<\/table>/g)].map((m) => m[0]);
}

function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p style="[^"]*">([\s\S]*?)<\/p>/g)].map((m) => m[1]);
}

const ACCOUNT_BODY = `Welcome, {{firstName}} 👋

An account has been created for you on {{brandName}} with the role {{roleName}}.

Use the temporary password below to get started:
Email: {{email}}
Temporary password: {{temporaryPassword}}

Please keep this password safe.

— {{brandName}}`;

describe("renderBodyToHtml — credential card", () => {
  it("lifts the temporary-password line out of the prose into a credential card", () => {
    const html = renderBodyToHtml(ACCOUNT_BODY);
    const cards = credentialCards(html);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("{{temporaryPassword}}");
    // The token must no longer sit in a prose paragraph — that's what made it
    // impossible to select cleanly.
    expect(paragraphs(html).join("\n")).not.toContain("{{temporaryPassword}}");
  });

  it("gives the password its own line so a triple-click / long-press selects only it", () => {
    const card = credentialCards(renderBodyToHtml(ACCOUNT_BODY))[0];
    // The value element contains the token and nothing else, and opts into
    // whole-value selection for clients that honour it.
    expect(card).toMatch(/user-select:all;">\{\{temporaryPassword\}\}<\/div>/);
  });

  it("keeps the token unsubstituted so send-time escaping still applies", () => {
    const html = renderBodyToHtml(ACCOUNT_BODY);
    expect(html).toContain("{{temporaryPassword}}");
  });

  it("wraps a long password rather than overflowing a narrow screen", () => {
    const card = credentialCards(renderBodyToHtml(ACCOUNT_BODY))[0];
    expect(card).toContain("word-break:break-all");
  });

  it("pulls an adjacent email line into the same card", () => {
    const cards = credentialCards(renderBodyToHtml(ACCOUNT_BODY));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("{{email}}");
    // Pre-empts Gmail's auto-linking, which would otherwise restyle the address
    // as blue underlined text inside the card.
    expect(cards[0]).toContain('href="mailto:{{email}}"');
  });

  it("prints the label the admin typed, above the value", () => {
    const card = credentialCards(renderBodyToHtml(ACCOUNT_BODY))[0];
    expect(card).toContain("Temporary password");
    expect(card).toContain("Email");
  });

  it("detects the credential by token, not by the label text", () => {
    // An admin may rename or translate the label; the card must survive that.
    const card = credentialCards(
      renderBodyToHtml("Sifiri:\nKadavuchol: {{temporaryPassword}}"),
    )[0];
    expect(card).toContain("Kadavuchol");
    expect(card).toContain("{{temporaryPassword}}");
  });

  it("accepts a bare credential token on its own line, with no label", () => {
    const cards = credentialCards(renderBodyToHtml("Your password:\n\n{{temporaryPassword}}"));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("{{temporaryPassword}}");
  });

  it("escapes a label containing HTML-significant characters", () => {
    const card = credentialCards(renderBodyToHtml('Pass <b>"x"</b>: {{temporaryPassword}}'))[0];
    expect(card).toContain("&lt;b&gt;");
    expect(card).not.toContain("<b>");
  });

  it("leaves an email line that has no credential beside it as ordinary prose", () => {
    const html = renderBodyToHtml("We'll reply to you at\nEmail: {{email}}\nwithin one day.");
    expect(credentialCards(html)).toHaveLength(0);
    expect(paragraphs(html).join("\n")).toContain("{{email}}");
  });

  it("leaves a credential token used mid-sentence inline, but visually distinct", () => {
    const html = renderBodyToHtml("Sign in with {{temporaryPassword}} and change it after.");
    expect(credentialCards(html)).toHaveLength(0);
    const prose = paragraphs(html).join("\n");
    expect(prose).toContain("{{temporaryPassword}}");
    expect(prose).toContain("monospace");
  });

  it("keeps the surrounding paragraphs intact and in order", () => {
    const html = renderBodyToHtml(ACCOUNT_BODY);
    const prose = paragraphs(html);
    expect(prose[0]).toContain("{{firstName}}");
    expect(prose.at(-1)).toContain("— {{brandName}}");
    // The intro line of the credential paragraph stays prose, above the card.
    expect(html.indexOf("Use the temporary password below")).toBeLessThan(
      html.indexOf("credential-card"),
    );
  });

  it("leaves a template with no credential tokens untouched", () => {
    const html = renderBodyToHtml("Hello {{firstName}}\n\nYour order {{poCode}} shipped.");
    expect(credentialCards(html)).toHaveLength(0);
    expect(html).not.toContain("user-select");
    expect(paragraphs(html)).toHaveLength(2);
  });

  it("still renders links inside prose", () => {
    const html = renderBodyToHtml("Sign in here: {{loginUrl}}");
    expect(html).toContain('<a href="{{loginUrl}}"');
  });
});

describe("renderBodyToHtml + renderEmail — end to end", () => {
  it("escapes a password containing HTML-significant characters", () => {
    const message = "Email: {{email}}\nTemporary password: {{temporaryPassword}}";
    const { html } = renderEmail(
      { subject: "s", htmlContent: renderBodyToHtml(message), textContent: message },
      { temporaryPassword: `a<b>&"'`, email: "a@b.com", emailHeaderRow: "" },
    );

    expect(html).toContain("a&lt;b&gt;&amp;&quot;&#39;");
    expect(html).not.toContain("<b>&");
  });

  it("delivers the raw password in the plain-text part", () => {
    const message = "Temporary password: {{temporaryPassword}}";
    const { text } = renderEmail(
      { subject: "s", htmlContent: renderBodyToHtml(message), textContent: message },
      { temporaryPassword: `a<b>&"'` },
    );
    expect(text).toBe(`Temporary password: a<b>&"'`);
  });
});

// The header bar is the one part of every email that is assembled from admin-controlled
// settings rather than from a template, and `emailLogoSrc` is the only thing standing between
// an uploaded SVG and a logo-less inbox. Nothing here was covered before, so these pin the
// three ways it can silently break: the format transform going missing, the idempotency guard
// drifting out of sync with the prefix it guards, and a brand name escaping into markup.

const CLOUDINARY_PNG =
  "https://res.cloudinary.com/demo/image/upload/v1782297715/senthra/branding/logo.png";
const CLOUDINARY_SVG =
  "https://res.cloudinary.com/demo/image/upload/v1782297715/senthra/branding/logo.svg";

function imgSrc(html: string): string | null {
  return html.match(/<img [^>]*src="([^"]*)"/)?.[1] ?? null;
}

describe("buildEmailHeaderRow — logo delivery", () => {
  it("forces a raster PNG and caps the height for a Cloudinary logo", () => {
    const src = imgSrc(buildEmailHeaderRow("Senthra", CLOUDINARY_PNG));
    expect(src).toBe(
      "https://res.cloudinary.com/demo/image/upload/f_png,h_80,c_limit/v1782297715/senthra/branding/logo.png",
    );
  });

  it("rasterises an SVG logo, which Gmail and Outlook would otherwise not render", () => {
    const src = imgSrc(buildEmailHeaderRow("Senthra", CLOUDINARY_SVG));
    // The transform, not the stored extension, is what decides the delivered bytes — Cloudinary
    // rasterises on `f_png`. The `.svg` suffix staying in the path is expected.
    expect(src).toContain("/upload/f_png,h_80,c_limit/");
  });

  it("is idempotent — an already-transformed URL is not transformed twice", () => {
    const once = imgSrc(buildEmailHeaderRow("Senthra", CLOUDINARY_PNG))!;
    // Feeding the output back in is what a guard checking the wrong prefix would fail. Stored
    // URLs are untransformed today, so only this test would catch that drift.
    expect(imgSrc(buildEmailHeaderRow("Senthra", once))).toBe(once);
    expect(once.match(/f_png/g)).toHaveLength(1);
  });

  it("leaves a non-Cloudinary logo URL untouched", () => {
    const url = "https://cdn.example.com/logo.png";
    expect(imgSrc(buildEmailHeaderRow("Senthra", url))).toBe(url);
  });

  it("carries the brand name as alt text so a blocked image still reads as the brand", () => {
    const html = buildEmailHeaderRow("Senthra", CLOUDINARY_PNG);
    expect(html).toContain('alt="Senthra"');
    // Logo OR name, never both — most logos are wordmarks that already contain the name.
    expect(html).not.toContain("<span");
  });

  it("escapes a brand name containing HTML-significant characters", () => {
    const html = buildEmailHeaderRow(`A<b>&"c`, CLOUDINARY_PNG);
    expect(html).toContain("A&lt;b&gt;&amp;&quot;c");
    expect(html).not.toContain("<b>");
  });
});

describe("buildEmailHeaderRow — text fallback", () => {
  it("renders the brand name as text when no logo is set", () => {
    const html = buildEmailHeaderRow("Senthra", "");
    expect(html).not.toContain("<img");
    expect(html).toContain("Senthra");
  });

  it("falls back to the default accent for a malformed brand colour", () => {
    expect(buildEmailHeaderRow("Senthra", "", "javascript:alert(1)")).toContain(
      `background:${DEFAULT_BRAND_COLOR}`,
    );
  });

  it("picks a dark wordmark on a light bar and a light one on a dark bar", () => {
    expect(buildEmailHeaderRow("Senthra", "", "#ffffff")).toContain("color:#1a1a2e");
    expect(buildEmailHeaderRow("Senthra", "", "#101020")).toContain("color:#ffffff");
  });
});
