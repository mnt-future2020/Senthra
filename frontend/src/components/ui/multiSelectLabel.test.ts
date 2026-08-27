import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── A <MultiSelect> inside a wrapping <label> cannot be used at all ────────────────────────────
//
// MultiSelect renders its option list INLINE, as a sibling of its own search input. Put the whole
// thing inside a <label> and every option becomes a label descendant — so clicking one makes the
// browser forward the activation to the label's control, which is MultiSelect's search input. The
// option's own handler runs for the real click and again for the forwarded one, so `toggle` fires
// twice: selected, then instantly deselected. Nothing ever sticks.
//
// This shipped on the scheduled-report form's Recipients picker, where it made the field impossible
// to fill and therefore the whole form impossible to save (Save is disabled until a recipient is
// chosen). It is invisible to TypeScript, to ESLint and to a component that renders perfectly:
// the options appear, they highlight on hover, and the click does nothing.
//
// The <Select>s beside it survive the same wrapper only because their popup is PORTALLED out of the
// label. That is why the bug looked so arbitrary — same shape, one works, one does not.
//
// The correct shape is a <div> with a sibling <label>/<span>, which is what UserForm already used.

const SRC = join(process.cwd(), "src");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return entry.endsWith(".tsx") ? [full] : [];
  });
}

/**
 * Comments BLANKED, not removed, so byte offsets (and therefore reported line numbers) still line up.
 *
 * These call sites are heavily commented and the comments discuss `<label>` by name — including the
 * one on the very call site this rule exists for. A scanner that reads prose as markup reports the
 * fixed code as broken, which is worse than no scanner at all.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/.*/g, (m) => " ".repeat(m.length));
}

/** True when `index` sits inside a still-open <label> — i.e. a <label> with no </label> before it. */
function insideOpenLabel(src: string, index: number): boolean {
  const before = src.slice(0, index);
  const lastOpen = before.lastIndexOf("<label");
  if (lastOpen === -1) return false;
  return !before.slice(lastOpen).includes("</label>");
}

describe("MultiSelect is never wrapped in a <label>", () => {
  it("has no call site whose options a label click would swallow", () => {
    const offenders = tsxFiles(SRC).flatMap((file) => {
      const src = code(readFileSync(file, "utf8"));
      const rel = file.replace(process.cwd(), "").split("\\").join("/");
      return [...src.matchAll(/<MultiSelect[\s/>]/g)]
        .filter((m) => insideOpenLabel(src, m.index!))
        .map((m) => `${rel}:${src.slice(0, m.index).split("\n").length}`);
    });

    expect(
      offenders,
      "these MultiSelects sit inside a wrapping <label>, so clicking an option is forwarded to the " +
        "label's control and toggles the value twice — the picker looks fine and cannot be used. " +
        "Use a <div> with a sibling label, as UserForm does.",
    ).toEqual([]);
  });

  // Guards the guard: if MultiSelect ever portals its popup (like Select does), the rule above stops
  // being necessary and this test should be deleted rather than left as folklore.
  it("still renders its option list inline, which is what makes the rule necessary", () => {
    const src = readFileSync(join(SRC, "components", "ui", "MultiSelect.tsx"), "utf8");
    expect(src).not.toContain("createPortal");
  });
});
