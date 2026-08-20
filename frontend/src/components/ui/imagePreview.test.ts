import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── An enlarged photo has to be bounded in BOTH directions ─────────────────────────────────────
//
// The attachment grid's preview bounded the height and left the width to `w-auto`, so a phone photo
// opened at its natural 3000px inside a 512px modal and spilled straight out of it. Height alone is
// not a constraint: the dimension that overflows is whichever one you forgot.
//
// `ImageLightbox` is the app's answer — max-h + max-w + object-contain, portalled, Escape-safe on
// top of a modal — so a second hand-rolled preview is both a bug and a duplicate. This scans source
// because it is a LAYOUT invariant: it never throws, never fails a type check, and looks fine on any
// image small enough to fit.

const COMPONENTS = join(process.cwd(), "src", "components");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return entry.endsWith(".tsx") ? [full] : [];
  });
}

/** Every `className="…"` on an <img …> tag, however the attributes are ordered or wrapped. */
function imgClassNames(src: string): string[] {
  return [...src.matchAll(/<img\b[\s\S]*?\/>/g)]
    .map((m) => m[0].match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/))
    .map((m) => m?.[1] ?? m?.[2] ?? "")
    .filter(Boolean);
}

describe("an enlarged image is bounded in both directions", () => {
  it("never caps the height without also capping the width", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(COMPONENTS)) {
      for (const cls of imgClassNames(readFileSync(file, "utf8"))) {
        // Only previews — a thumbnail sized by its container (h-full/w-full, aspect-*) caps nothing
        // and needs nothing.
        if (!/max-h-/.test(cls)) continue;
        const boundedWidth = /max-w-|w-full/.test(cls);
        if (!boundedWidth) offenders.push(`${file.replace(process.cwd(), "").replace(/\\/g, "/")}  →  ${cls}`);
      }
    }
    expect(
      offenders,
      "these images cap their height and let the width run to the source's natural size, which " +
        "overflows whatever box they are in — add max-w-* (and object-contain), or use ImageLightbox",
    ).toEqual([]);
  });
});
