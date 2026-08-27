import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Class-level guards on the public privacy surface, not unit tests.
 *
 * There is no DOM in this suite, so these read the source. Each one covers a property whose failure
 * is silent: markup rendering, a hardcoded policy creeping back into the page, or the two manual
 * publication switches being flipped as a side effect of something else.
 */

const SRC = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** Source with comment lines stripped — these guards search for code, and the comments discuss it. */
const codeOf = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("policy content is rendered as text, never as markup", () => {
  const renderer = codeOf(read("components/policy/PolicyBlocks.tsx"));

  it("the renderer never injects HTML", () => {
    expect(renderer).not.toContain("dangerouslySetInnerHTML");
  });

  it("no component in the app injects HTML", () => {
    // The whole content model rests on this being true app-wide: the moment one component does it,
    // "author-supplied text is safe" stops being a property of the system.
    for (const rel of [
      "components/policy/PolicyBlocks.tsx",
      "app/privacy/page.tsx",
      "components/dashboard/settings/legal/LegalSection.tsx",
    ]) {
      expect(codeOf(read(rel)), rel).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("renders every block kind the parser can emit", () => {
    for (const kind of ["heading", "list", "paragraph"]) {
      expect(renderer).toContain(`"${kind}"`);
    }
  });
});

describe("the public page shows only published content", () => {
  const page = read("app/privacy/page.tsx");

  it("reads the published policy through the public fetch", () => {
    expect(page).toContain("fetchPublishedPolicy");
  });

  it("never reaches the admin endpoint or a draft", () => {
    const code = codeOf(page);
    expect(code).not.toContain("draftBody");
    expect(code).not.toContain("policyService");
    expect(code).not.toContain("/admin");
  });

  it("carries no hardcoded policy prose — the content lives in the database", () => {
    const code = codeOf(page);
    // Phrases the previous hardcoded draft contained. Their return would mean policy text had been
    // put back into the deployable again, which is what the whole feature removed.
    for (const phrase of ["lawful basis", "Cloudinary", "Firebase", "controller", "To be confirmed"]) {
      expect(code.toLowerCase(), phrase).not.toContain(phrase.toLowerCase());
    }
  });

  it("renders an unavailable state when nothing is published", () => {
    expect(page).toContain("Not available yet");
  });
});

/**
 * The notice is PUBLIC now — linked from sign-in and indexable.
 *
 * This block used to assert the opposite, and was right to: /privacy then rendered policy text
 * hardcoded in the page, so an unapproved draft could have been announced to the world by a stray
 * edit. That page is gone. The content is now whatever an operator holding `policy.publish`
 * deliberately published, with no fallback and no prose in the deployable — the guards above pin
 * exactly that, and they are what makes linking safe.
 *
 * So the direction of the check flips rather than disappearing. What must not regress is no longer
 * "is it still hidden" but "is it still REACHABLE": a data-protection notice is only doing its job
 * if somebody at the point of collection can find it, and an unlinked, de-indexed notice silently
 * stops doing that while every test stays green.
 */
describe("the notice is reachable from where data is collected", () => {
  it("the sign-in screen links to it", () => {
    const auth = read("components/auth/AuthLayout.tsx");
    // The IMPORT is the machine-checkable half — a <Link> cannot render without it. The href is the
    // other half. Comments are stripped first, or the old restore snippet would satisfy this.
    const code = codeOf(auth);
    expect(code, "AuthLayout must import next/link to render the notice link").toMatch(
      /^import .*from "next\/link";$/m,
    );
    expect(code, "the sign-in footer must point at /privacy").toMatch(/href="\/privacy"/);
  });

  it("the page is not de-indexed", () => {
    // `robots: { index: false }` would keep the page out of search results. Harmless-looking, and it
    // was correct while the content was a draft; with a published notice it just makes the document
    // harder to find for no benefit.
    expect(codeOf(read("app/privacy/page.tsx"))).not.toContain("index: false");
  });
});

/**
 * Copy-to-draft must copy the SOURCE, never what the viewer is showing.
 *
 * The version viewer renders parsed blocks — headings styled, bullets as bullets. Copying that back
 * would paste a document stripped of its `#` and `-` markers and its paragraph breaks: structurally
 * different from the version it claims to be, and silently so, because it still reads correctly.
 *
 * The detail response carries both `body` (the immutable source) and `blocks` (the render). Only one
 * of them may reach the draft.
 */
describe("copying a historical version copies its SOURCE", () => {
  const section = codeOf(read("components/dashboard/settings/legal/LegalSection.tsx"));

  it("saves the raw body, not the rendered blocks", () => {
    expect(section, "copy-to-draft must save `detail.body`").toMatch(/saveDraft\(\s*viewing\.detail\.body/);
    expect(section, "`blocks` must never be written back into the draft").not.toMatch(/saveDraft\([^)]*\.blocks/);
  });

  it("routes through the existing draft save, so it inherits the revision guard", () => {
    // A bespoke copy endpoint would have needed its own concurrency and audit story. Reusing
    // saveDraft means there is nothing new to get wrong: it already refuses a stale revision.
    expect(section).toMatch(/saveDraft\(\s*viewing\.detail\.body,\s*policy\.draftRevision/);
  });

  it("does not publish, repoint, or otherwise touch a version", () => {
    const fn = section.slice(section.indexOf("const copyToDraft"), section.indexOf("const viewVersion"));
    expect(fn).not.toContain("publishPolicy");
    expect(fn).not.toContain("publishedVersionId");
  });

  // Label must describe what happens. "Restore"/"Make live"/"Revert" would all promise the live
  // version changes, which it does not — publishing stays a separate, permissioned act.
  it("is labelled for what it does", () => {
    const jsx = read("components/dashboard/settings/legal/LegalSection.tsx");
    expect(jsx).toContain("Copy to draft");
    for (const wrong of [">Restore<", ">Make live<", ">Revert<"]) {
      expect(jsx, `${wrong} would misdescribe the action`).not.toContain(wrong);
    }
  });

  it("is gated on policy.edit and never on policy.publish", () => {
    const block = section.slice(section.indexOf("onClick={copyToDraft}") - 400, section.indexOf("onClick={copyToDraft}") + 200);
    expect(block).toContain("canEdit");
    expect(block).not.toContain("canPublish");
  });
});

describe("the admin section is permission-gated", () => {
  const panel = read("components/dashboard/settings/SettingsPanel.tsx");
  const section = read("components/dashboard/settings/legal/LegalSection.tsx");

  it("requires policy.view to appear in Settings", () => {
    expect(panel).toContain('id: "legal"');
    expect(panel).toContain('requires: "policy.view"');
  });

  it("gates editing and publishing on their own permissions", () => {
    expect(section).toContain('can("policy.edit")');
    expect(section).toContain('can("policy.publish")');
  });

  it("does not treat edit as sufficient to publish", () => {
    // The publish control is bound to canPublish; if it ever read canEdit the split would be gone
    // in the UI even though the server still enforced it.
    const publishBlock = section.slice(section.indexOf("{canPublish && ("), section.indexOf("</button>", section.indexOf("{canPublish && (")));
    expect(publishBlock).not.toContain("canEdit");
  });
});
