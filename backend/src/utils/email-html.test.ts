import { describe, expect, it } from "vitest";

import { renderBodyToHtml } from "./email-html.js";
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
