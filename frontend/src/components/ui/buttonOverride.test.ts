import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── You cannot recolour a shared button by appending utilities ─────────────────────────────────
//
// Tailwind resolves competing utilities by CSS SOURCE order — the order they appear in the generated
// stylesheet — not by the order they appear in a `className` string. So this:
//
//     className={`${primaryBtn} bg-[var(--surface-2)] text-[var(--ink)]`}
//
// does not produce a grey button with dark text. `primaryBtn` carries `text-white`, and `text-white`
// wins, giving WHITE text on a near-white surface: a button that is present, focusable, clickable and
// invisible. Measured contrast on the two that shipped this way: ~1.04:1 against a required 4.5:1.
//
// Both were in the privacy-policy screen — one was Preview, the other was the CANCEL on an
// irreversible publish, i.e. the way out of the dialog was the control nobody could see.
//
// Nothing catches this. The markup is valid, the classes all exist, TypeScript and ESLint are happy,
// and the button renders at the right size in the right place. Only a human looking at the pixels —
// or this test — will notice.
//
// The fix is never to override: `secondaryBtn`, `ghostBtn` and `dangerBtn` already exist for the
// variants, and none of them has a colour to fight.

const SRC = join(process.cwd(), "src");

/** Comments blanked, offsets preserved, so prose ABOUT this rule is not mistaken for a violation. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/.*/g, (m) => " ".repeat(m.length));
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return entry.endsWith(".tsx") ? [full] : [];
  });
}

/** The shared button constants that hard-code a text or background colour. */
const COLOURED = ["primaryBtn", "dangerBtn", "secondaryBtn", "ghostBtn", "toolbarPrimaryBtn", "toolbarBtn"];

describe("shared button styles are used, not recoloured", () => {
  it("has no call site that appends a competing bg-/text- utility", () => {
    const pattern = new RegExp(String.raw`\$\{(${COLOURED.join("|")})\}([^\`]*)`, "g");

    const offenders = tsxFiles(SRC).flatMap((file) => {
      const src = code(readFileSync(file, "utf8"));
      const rel = file.replace(process.cwd(), "").split("\\").join("/");
      return [...src.matchAll(pattern)]
        // A trailing utility that sets colour is the bug. Layout extras (flex, gap, w-, inline-*)
        // are fine and common — they do not compete with anything the constant declares.
        .filter((m) => /(^|\s)(bg-|text-(?!xs|sm|base|lg|xl|left|right|center))/.test(m[2] ?? ""))
        .map((m) => `${rel}:${src.slice(0, m.index).split("\n").length} — ${m[1]} + "${(m[2] ?? "").trim()}"`);
    });

    expect(
      offenders,
      "these recolour a shared button by appending utilities. Tailwind resolves conflicts by CSS " +
        "source order, not class-string order, so the constant's own colour usually WINS and the " +
        "result is unreadable — twice already, white text on a near-white surface. Use secondaryBtn / " +
        "ghostBtn / dangerBtn instead of overriding primaryBtn.",
    ).toEqual([]);
  });

  // Guards the guard: the rule only matters while these constants actually pin a colour.
  it("the shared buttons really do hard-code colours", () => {
    const styles = readFileSync(join(SRC, "components", "ui", "styles.ts"), "utf8");
    expect(styles, "primaryBtn must pin its text colour for this rule to be needed").toMatch(
      /primaryBtn[\s\S]{0,300}text-white/,
    );
  });
});
