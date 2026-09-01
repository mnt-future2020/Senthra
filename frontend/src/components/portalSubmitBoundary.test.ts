import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ── A portalled form must not submit the page it was declared inside ──────────────────────────
//
// `createPortal` moves a subtree's MARKUP to <body>. It does not move its EVENTS: React dispatches
// along the React tree, so a <form> inside a portal still bubbles its submit up to whatever page
// <form> the portal was declared inside, and runs that page's submit handler.
//
// That is not hypothetical. `IrmItemCreateOverlay` is opened from an item line INSIDE
// PurchaseRequestForm's <form>, so clicking "Create item" also submitted the purchase request —
// saving it and navigating away while the item was still being created. `RentalItemCreateOverlay`
// had the identical defect on the rental lines of the same form. Modal.tsx and ConfirmDialog.tsx
// already carried the guard, which is the strongest evidence this recurs: someone hit it, fixed it
// in two places, and the next two portals written did not inherit the lesson.
//
// So the rule is checked from SOURCE, over every portal, rather than pinned to the two that were
// broken. A test naming only those two would pass forever while the third overlay someone adds
// ships the same bug — and the bug is invisible in review, because the portal genuinely does move
// the markup out of the form, which is exactly what makes it look safe.

const COMPONENTS = join(process.cwd(), "src", "components");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(full);
    return e.isFile() && e.name.endsWith(".tsx") ? [full] : [];
  });
}

/**
 * Comments stripped BEFORE anything is matched, and that is load-bearing here rather than tidy.
 *
 * The guard these files carry is heavily commented — house style — and those comments NAME
 * `stopPropagation` and `preventDefault` in prose while explaining the trap. A matcher that read raw
 * source would therefore pass a file that only TALKS about the guard without having one, which is
 * precisely the failure this test exists to catch.
 */
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

/**
 * Does this portal render a form ITSELF — its own `<form>`, or a `<…Form>` component?
 *
 * Deliberately narrow. An earlier version also matched any file mentioning `{children}`, reasoning
 * that a caller might pass a form in; that swept in every list View that portals a dropdown or an
 * action bar, and demanded a submit guard on surfaces with no form anywhere near them. A rule that
 * fires on things that cannot break is a rule the next developer deletes. The shared containers that
 * DO hold arbitrary children (Modal, ConfirmDialog) are pinned by name instead, below.
 */
const carriesAForm = (src: string) => /<form[\s>]/.test(src) || /<[A-Z][A-Za-z]*Form[\s/>]/.test(src);

const STOPS_SUBMIT = /onSubmit=\{\s*\(\s*e\s*\)\s*=>\s*e\.stopPropagation\(\)\s*\}/;
const STOPS_RESET = /onReset=\{\s*\(\s*e\s*\)\s*=>\s*e\.stopPropagation\(\)\s*\}/;

const portals = tsxFiles(COMPONENTS)
  .map((path) => ({ path, src: stripComments(readFileSync(path, "utf8")) }))
  .filter(({ src }) => src.includes("createPortal"))
  .map(({ path, src }) => ({
    // Posix-style so the expectations below read the same on Windows and CI.
    name: relative(COMPONENTS, path).split(sep).join("/"),
    src,
    hasForm: carriesAForm(src),
    guards: STOPS_SUBMIT.test(src),
  }));

describe("portalled forms are isolated from the page form they were declared inside", () => {
  // Guards the guard. If a refactor renames these files or drops `createPortal`, the rule below
  // would quietly have nothing to check and still report success.
  it("finds the portals it is meant to police", () => {
    expect(portals.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        "ui/Modal.tsx",
        "ui/ConfirmDialog.tsx",
        "dashboard/irm/IrmItemCreateOverlay.tsx",
        "dashboard/rentals/RentalItemCreateOverlay.tsx",
      ]),
    );
    // The two create-overlays render a form directly. Two is the floor, so a heuristic that silently
    // stopped matching cannot pass this test by finding nothing to check.
    expect(portals.filter((p) => p.hasForm).length).toBeGreaterThanOrEqual(2);
  });

  // Modal and ConfirmDialog carry no form of their own — Modal renders whatever the caller passes,
  // ConfirmDialog a fixed message plus two buttons — so the source rule above cannot reach them. They
  // guard regardless, on every caller's behalf, which is why any modal in the app is already safe.
  // Pinned by name so the convention the two overlays were just made to follow cannot itself be
  // tidied away underneath them.
  it.each(["ui/Modal.tsx", "ui/ConfirmDialog.tsx"])("%s, a shared dialog primitive, guards", (name) => {
    const dialog = portals.find((p) => p.name === name);
    expect(dialog, `${name} is no longer a portal`).toBeDefined();
    expect(dialog!.guards).toBe(true);
  });

  it.each(portals.filter((p) => p.hasForm).map((p) => p.name))("%s stops submit propagation", (name) => {
    expect(portals.find((p) => p.name === name)!.guards).toBe(true);
  });

  // THE REGRESSION, named. Both overlays are opened from inside PurchaseRequestForm's <form> — the
  // IRM one from an item line, the rental one from a rental line — so an unguarded submit there
  // saves and navigates the purchase request out from under the user.
  it.each([
    ["dashboard/irm/IrmItemCreateOverlay.tsx", "IrmItemForm"],
    ["dashboard/rentals/RentalItemCreateOverlay.tsx", "RentalItemForm"],
  ])("%s isolates %s from the purchase request form", (name, formComponent) => {
    const overlay = portals.find((p) => p.name === name);
    expect(overlay, `${name} is no longer a portal`).toBeDefined();
    expect(overlay!.src).toContain(`<${formComponent}`);
    expect(overlay!.guards).toBe(true);
    // `reset` travels the same path and would clear the page form instead of the overlay's.
    expect(STOPS_RESET.test(overlay!.src)).toBe(true);
  });

  // preventDefault suppresses the browser's navigation. It does NOT stop the event reaching the
  // parent form's handler, so it is not a substitute — and reaching for it is the natural wrong
  // instinct when this bug is first seen.
  it.each(portals.filter((p) => p.hasForm).map((p) => p.name))(
    "%s does not rely on preventDefault instead",
    (name) => {
      const src = portals.find((p) => p.name === name)!.src;
      const preventDefaultOnly =
        /onSubmit=\{\s*\(\s*e\s*\)\s*=>\s*e\.preventDefault\(\)\s*\}/.test(src) && !STOPS_SUBMIT.test(src);
      expect(preventDefaultOnly).toBe(false);
    },
  );
});
