import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { compactListToolbarCls, listToolbarCls } from "./styles";

// ── A row of controls that becomes horizontal at `sm` must be allowed to wrap ──────────────────
//
// The bug this pins is invisible in every unit test and on every desktop: a row written with
// `sm:flex-row` but WITHOUT `sm:flex-wrap` cannot reflow, so once its controls stop fitting it
// pushes the last of them out of its box. `#app` clips the overflow above `sm`, so there is no
// scrollbar and no way to reach what fell off — on Customers and Warehouses that was the "Add
// customer" / "Add warehouse" button, the page's primary action.
//
// Measured in Chrome against the app's compiled CSS at a 768px viewport (where `sm:flex-row` is live
// and the sidebar has taken 256px), the rows overflowed their card by:
//
//     Warehouses 199px · Portal Jobs 190px · Suppliers 182px · IRM Items 142px
//     Rental Items 92px · Customers 78px · Damaged Stock 26px
//
// ── Why the rule is no longer "looks like a toolbar CARD" ──────────────────────────────────────
//
// The first version of this guard required `rounded-xl` + `bg-[var(--surface)]` — the signature of a
// toolbar card — and scanned only double-quoted `className="…"`. It therefore could not see the two
// shapes that were still broken:
//
//   • Damaged Stock's filter row, which is not a card at all. It has no surface, no border and no
//     padding, because it sits directly on the page above the table's card. Measured at 768px it
//     still needed 474px inside a 448px box, and its first child is a `shrink-0` pill group, so the
//     whole squeeze landed on the search box and Export.
//   • DetailHeader and Pagination, whose classes are template literals.
//
// So the marker is now what these rows actually have in common, card or not: `shrink-0` (page
// furniture pinned above a scrolling list) + `flex-col` + `sm:flex-row`. `sm:justify-between` is NOT
// an exemption — RolesView is a justify-between row and it overflowed like the rest.
//
// LIMITS, stated rather than discovered later. This is a source scan, not a compiler: a row whose
// classes are assembled by `cn()` or held in a variable is invisible to it, and inside a template
// literal a class in ONE branch of a ternary reads as always present. It is a floor, not a proof.

const SRC = join(process.cwd(), "src");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

/** `className="…"` and `className={`…`}` — the two forms this codebase writes.
 *  No `s` flag: the negated character classes already span newlines, and these attributes are
 *  routinely written across several lines. */
const CLASS_ATTR = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;

/** What makes a row one of these: pinned furniture that turns horizontal at `sm`. */
const MARKERS = ["shrink-0", "flex-col", "sm:flex-row"];

function rowsThatCannotWrap(): string[] {
  const offenders: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(CLASS_ATTR)) {
      const cls = (match[1] ?? match[2] ?? "").split(/\s+/).join(" ");
      if (!MARKERS.every((m) => cls.includes(m))) continue;
      if (cls.includes("flex-wrap")) continue;
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${file.slice(SRC.length + 1).split(sep).join("/")}:${line}`);
    }
  }
  return offenders;
}

/** Every row the rule matches, wrapping or not — so the test can prove it is actually looking. */
function allMatchedRows(): string[] {
  const found: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(CLASS_ATTR)) {
      const cls = (match[1] ?? match[2] ?? "").split(/\s+/).join(" ");
      if (MARKERS.every((m) => cls.includes(m))) {
        found.push(file.slice(SRC.length + 1).split(sep).join("/"));
      }
    }
  }
  return found;
}

describe("list toolbars", () => {
  it("every pinned row that becomes horizontal at sm can wrap", () => {
    expect(rowsThatCannotWrap()).toEqual([]);
  });

  it("actually sees the rows it claims to check", () => {
    // Without this, deleting a marker would empty the offender list and the test above would pass by
    // checking nothing at all.
    const matched = allMatchedRows();
    expect(matched.length).toBeGreaterThan(15);
  });

  it("covers the shapes the first version of this guard missed", () => {
    const matched = allMatchedRows();
    // A filter ROW with no card around it — the Damaged Stock regression.
    expect(matched).toContain("components/dashboard/goods-management/DamagedStockView.tsx");
    // Template-literal classNames.
    expect(matched).toContain("components/ui/DetailHeader.tsx");
    expect(matched).toContain("components/ui/Pagination.tsx");
    // And the hand-written toolbar cards it always caught, including a `justify-between` one.
    expect(matched).toContain("components/dashboard/users-roles/roles/RolesView.tsx");
    expect(matched).toContain("components/dashboard/users-roles/users/UsersView.tsx");
  });

  it("does NOT see a page that uses the shared constant — which is the division of labour", () => {
    // WarehousesView writes `className={listToolbarCls}`, an identifier, so the scan above cannot
    // read it and must not pretend to. That page is covered by the constant's own test below
    // instead. Pinned so the gap is a documented split rather than a hole someone finds later.
    const source = readFileSync(join(SRC, "components/dashboard/warehouses/WarehousesView.tsx"), "utf8");
    expect(source).toContain("className={listToolbarCls}");
    expect(allMatchedRows()).not.toContain("components/dashboard/warehouses/WarehousesView.tsx");
  });

  it("reads both className forms", () => {
    const quoted = [...`<div className="a shrink-0 flex-col sm:flex-row b" />`.matchAll(CLASS_ATTR)];
    const templated = [...`<div className={\`a shrink-0 flex-col sm:flex-row \${x}\`} />`.matchAll(CLASS_ATTR)];
    expect(quoted[0][1]).toContain("sm:flex-row");
    expect(templated[0][2]).toContain("sm:flex-row");
  });

  it("both shared toolbar constants carry the wrap", () => {
    for (const cls of [listToolbarCls, compactListToolbarCls]) {
      expect(cls.split(" ")).toContain("sm:flex-wrap");
      expect(cls.split(" ")).toContain("sm:flex-row");
    }
  });

  it("the two densities differ ONLY in gap and padding", () => {
    const strip = (c: string) => c.split(" ").filter((t) => !/^(gap|p)-/.test(t)).sort();
    expect(strip(listToolbarCls)).toEqual(strip(compactListToolbarCls));
    expect(listToolbarCls).toContain("gap-3");
    expect(listToolbarCls).toContain("p-4");
    expect(compactListToolbarCls).toContain("gap-2");
    expect(compactListToolbarCls).toContain("p-3");
  });
});
