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
 * The two switches that make the notice public. Publishing must not flip either — going public is a
 * decision someone takes by editing these files, not a consequence of a database write.
 */
describe("the manual publication switches are still off", () => {
  it("the page is noindexed", () => {
    expect(read("app/privacy/page.tsx")).toContain("robots: { index: false, follow: false }");
  });

  it("the sign-in screen does not link to it", () => {
    const auth = read("components/auth/AuthLayout.tsx");
    // The IMPORT is the machine-checkable fact: with no `next/link` import a <Link> cannot render,
    // whatever the file says elsewhere. (The restore snippet lives inside a JSX comment, so a naive
    // substring search finds it and proves nothing.)
    expect(auth).not.toMatch(/^import .*from "next\/link";$/m);
    // And no plain anchor either.
    expect(auth).not.toMatch(/<a\s[^>]*href="\/privacy"/);
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
