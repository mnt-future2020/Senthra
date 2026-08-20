import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── A sticky <thead> needs a z-index, or the rows scroll THROUGH it ────────────────────────────
//
// `position: sticky` takes the header out of the flow but not out of paint order. A <thead> and a
// <tbody> are siblings, and the body comes second — so with no stacking context of its own, the
// header is painted FIRST and every row that scrolls under it lands on top. The header keeps its
// background, the row keeps its text, and the two render on the same pixels: "HDN-0006" struck
// across "NOTE", which is exactly what a user reported on the Rentals → Movements table.
//
// It is invisible until somebody scrolls a list long enough to reach the header, which is why four
// rentals tables and an import modal shipped with it while fifteen other tables carried `z-10`.
//
// The fix is one class. This test is here because the failure mode is a screenshot, not an
// exception: nothing throws, nothing fails to type-check, and a short list looks perfect.

const COMPONENTS = join(process.cwd(), "src", "components");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return entry.endsWith(".tsx") ? [full] : [];
  });
}

describe("sticky table headers", () => {
  it("every sticky <thead> is given a z-index so rows pass under it", () => {
    const offenders = tsxFiles(COMPONENTS).flatMap((file) => {
      const src = readFileSync(file, "utf8");
      const rel = file.replace(process.cwd(), "").split("\\").join("/");
      // The whole opening tag, so a className built by a ternary is read too.
      return [...src.matchAll(/<thead[^>]*>/g)]
        .filter((m) => /sticky\s+top-0/.test(m[0]) && !/\bz-\d+\b/.test(m[0]))
        .map((m) => `${rel}:${src.slice(0, m.index).split("\n").length}`);
    });

    expect(
      offenders,
      "these sticky headers have no z-index, so table rows paint OVER them while scrolling — " +
        "add `z-10`, the class every other sticky thead in the app already carries",
    ).toEqual([]);
  });
});
