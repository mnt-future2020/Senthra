import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { UOM_OPTIONS } from "../uom.js";
import { createRentalItemSchema } from "#modules/rental-item/rental-item.validation.js";

describe("UOM_OPTIONS — one vocabulary", () => {
  it("is the eight units every picker offers", () => {
    expect([...UOM_OPTIONS]).toEqual(["Each", "Metre", "Roll", "Pack", "Box", "Set", "Pair", "Reel"]);
  });

  // The frontend cannot import from the backend, so the list is spelled twice by necessity. That
  // makes it exactly the thing to pin: a picker offering a value the server refuses is a save button
  // that fails on a selection the UI presented as valid.
  it("matches the frontend's copy character for character", () => {
    const frontend = readFileSync(
      join(process.cwd(), "..", "frontend", "src", "lib", "uom.ts"),
      "utf8",
    );
    const match = /export const UOM_OPTIONS = \[([^\]]+)\]/.exec(frontend);
    expect(match, "frontend/src/lib/uom.ts must export UOM_OPTIONS").not.toBeNull();
    const theirs = [...match![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(theirs).toEqual([...UOM_OPTIONS]);
  });

  // The drift this replaces: the same eight values were copy-pasted into five files, which is how a
  // sixth screen ended up with a free-text box instead of a picker. Nothing may re-declare the list.
  it("is declared in exactly one place per app", () => {
    const LITERAL = /\["Each",\s*"Metre",\s*"Roll",\s*"Pack",\s*"Box",\s*"Set",\s*"Pair",\s*"Reel"\]/;
    const offenders: string[] = [];
    for (const [app, dir, allowed] of [
      ["backend", join(process.cwd(), "src"), join("utils", "uom.ts")],
      ["frontend", join(process.cwd(), "..", "frontend", "src"), join("lib", "uom.ts")],
    ] as const) {
      for (const file of walk(dir)) {
        if (file.endsWith(allowed) || file.includes("__tests__")) continue;
        if (LITERAL.test(readFileSync(file, "utf8"))) offenders.push(`${app}: ${file}`);
      }
    }
    expect(offenders, "re-declaring the unit list is how it drifts — import it instead").toEqual([]);
  });
});

/** Every .ts/.tsx under a directory. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("the rental master validates against it", () => {
  const valid = { name: "Fibre Tester", rentalCategoryId: "6a1d7f5bfa7d25704f02b963" };

  it.each([...UOM_OPTIONS])("accepts %s", (unit) => {
    expect(createRentalItemSchema.safeParse({ ...valid, baseUnit: unit }).success).toBe(true);
  });

  // The unit is snapshotted onto the PRF line, the PO line and the PDF the supplier reads, so a
  // free-text typo would become permanent on a document.
  it.each(["each", "EA", "Banana", ""])("refuses %s", (unit) => {
    expect(createRentalItemSchema.safeParse({ ...valid, baseUnit: unit }).success).toBe(false);
  });
});
