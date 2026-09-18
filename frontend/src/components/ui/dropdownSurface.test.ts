import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { dropdownRadius, dropdownSurfaceCls } from "./styles";

// Every dropdown popup in the app is drawn on ONE surface, and its corner radius is the user's
// Appearance → Corner radius setting. That has to be an inline style: `var(--radius)` is a runtime
// value and Tailwind's `rounded-*` scale cannot read it. Six popups had `rounded-xl` hardcoded and
// sat frozen at 12px while the Select beside them moved between 6px and 26px — two dropdowns on one
// screen, opened a second apart, with visibly different corners.
//
// Checked from SOURCE because this suite has no DOM, and pinned by NAME because the rule is about
// the popups that exist, not about a pattern a heuristic might stop matching.

const SRC = join(process.cwd(), "src");
// A CRLF-safe stripper — see suggestInputKeys.test.ts for why `//.*$` cannot be used here.
const read = (rel: string) =>
  readFileSync(join(SRC, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");

const POPUPS = [
  // Base UI draws and positions this one for us, in its own portal.
  "components/ui/Select.tsx",
  // The profile menu at the foot of the sidebar. Missed by the first sweep precisely because it is
  // not a form control, which is why the list above is written out rather than inferred. It hangs off
  // the sidebar, which is fixed and full-height — not inside the page's scroll container — so it is
  // the one anchored popup with no scrolling chrome above it to collide with.
  "components/dashboard/shell/Sidebar.tsx",
  // Every field dropdown in the app is drawn by THIS now, so this is the file the radius rule has to
  // hold in for all of them.
  "components/ui/AnchoredPanel.tsx",
  // The panels and menus that place themselves: each portals to <body> and positions with
  // popoverPlacement, so they are not the bug AnchoredPanel exists to fix — but they were drawing
  // their own surface, and that IS the bug this file exists to fix. All thirteen had
  // `rounded-xl border border-[var(--border)] bg-[var(--surface)] … shadow-2xl` copied out by hand:
  // a duplicate of dropdownSurfaceCls with the radius frozen at 12px. Measured on Customers with
  // Appearance → Corner radius at 18px, a row menu came out 16px while the item dropdown beside it
  // came out 18px — two popups on one screen with different corners, which is exactly what the rule
  // at the top of this file was written to stop.
  "components/ui/FilterPopover.tsx",
  "components/ui/SitePicker.tsx",
  "components/dashboard/shell/AttentionMenu.tsx",
  "components/dashboard/customers/CustomersView.tsx",
  "components/dashboard/goods-in/GoodsReceiptsView.tsx",
  "components/dashboard/irm/IrmItemsView.tsx",
  "components/dashboard/jobs/JobsView.tsx",
  "components/dashboard/purchase-orders/PurchaseOrdersView.tsx",
  "components/dashboard/purchase-requests/PurchaseRequestsView.tsx",
  "components/dashboard/rentals/RentalItemsView.tsx",
  "components/dashboard/suppliers/SuppliersView.tsx",
  "components/dashboard/users-roles/users/UsersView.tsx",
  "components/dashboard/warehouses/WarehousesView.tsx",
];

// The controls that hand their popup to `AnchoredPanel` instead of rendering one.
//
// They each used to draw it themselves, as an `absolute` child of the field, and every one of them
// inherited the bug that cost: on the purchase-order form a dropdown whose row had scrolled up
// behind the sticky header bar stayed glued to the hidden trigger and painted across the header —
// and near the foot of the window the list simply ran off the bottom. The panel is portalled and
// placed now, and these files keep only their trigger and their list.
//
// So the radius rule moves with it — checked once, on AnchoredPanel, above. What is checked HERE is
// that none of these grew a second hand-rolled popup beside the shared one, because that copy would
// come without the placement and be straight back to covering the header.
const DELEGATED = [
  "components/ui/CreatableSelect.tsx",
  "components/ui/MultiSelect.tsx",
  // The searchable half of <Select>. It is NOT in POPUPS above: Base UI draws the plain select's
  // popup, but this one is an ordinary anchored combobox like the rest of this list.
  "components/ui/SearchableSelect.tsx",
  "components/ui/SuggestInput.tsx",
  "components/dashboard/irm/IrmItemPicker.tsx",
  "components/dashboard/stock/StockItemPicker.tsx",
  "components/dashboard/rentals/RentalItemPicker.tsx",
  "components/dashboard/users-roles/job-titles/JobTitleCombobox.tsx",
  "components/dashboard/users-roles/departments/DepartmentCombobox.tsx",
  "components/dashboard/warehouses/ExpectedDeliveries.tsx",
  "components/dashboard/home/QuickActions.tsx",
];

describe("the shared dropdown surface", () => {
  it("carries the border, ground and shadow, and nothing about geometry", () => {
    expect(dropdownSurfaceCls).toContain("border-[var(--border)]");
    expect(dropdownSurfaceCls).toContain("bg-[var(--surface)]");
    expect(dropdownSurfaceCls).toContain("shadow-2xl");
    // Position, width, padding and z-index belong to the call site — a full-width combobox list and
    // a right-aligned menu share this shell and nothing else.
    expect(dropdownSurfaceCls).not.toMatch(/\babsolute\b|\bz-|\bw-full\b|\bp-\d/);
  });

  it("takes its radius from the Appearance setting rather than a Tailwind step", () => {
    expect(dropdownRadius).toEqual({ borderRadius: "var(--radius)" });
    expect(dropdownSurfaceCls).not.toMatch(/rounded-/);
  });
});

describe.each(POPUPS)("%s", (rel) => {
  const code = read(rel);

  it("draws its popup on the shared surface", () => {
    expect(code, `${rel} must use dropdownSurfaceCls, not its own copy`).toContain("dropdownSurfaceCls");
    expect(code).toContain("dropdownRadius");
  });

  it("does not hardcode a popup radius alongside it", () => {
    // The popup is the element carrying the shared surface; a `rounded-*` on that same element is a
    // frozen corner that ignores the setting.
    const popupTags = [...code.matchAll(/[^\n]*dropdownSurfaceCls[^\n]*/g)].map((m) => m[0]);
    expect(popupTags.length, `${rel} no longer renders a popup`).toBeGreaterThan(0);
    for (const tag of popupTags) {
      expect(tag, `${rel}: hardcoded radius on the popup — ${tag.trim()}`).not.toMatch(/rounded-/);
    }
  });
});

// The sweep the named lists above cannot do: catch the NEXT hand-rolled popup, in a file nobody has
// thought to add here.
//
// Every popup in the app draws on `dropdownSurfaceCls`, which is what makes this checkable by
// grep — a new one either uses the shared surface (and shows up here) or hardcodes its own, which
// the radius rule has always been there to catch. Three components are allowed to reference it:
// AnchoredPanel, which draws the shell for everything anchored to a trigger; Select, whose popup Base
// UI positions in its own portal; and the sidebar profile menu, which hangs off fixed, full-height
// chrome with nothing above it to collide with.
describe("no fourth component draws its own popup", () => {
  it("keeps the shared surface in the three files entitled to it", () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) return walk(rel);
        return e.name.endsWith(".tsx") ? [rel] : [];
      });
    const files = walk("").filter((f) => read(f).includes("dropdownSurfaceCls"));
    expect(
      files.sort(),
      "a popup drawn outside AnchoredPanel gets none of its placement: it is clipped by the page's " +
        "scroll container, it can run off the bottom of the window, and it paints over the sticky " +
        "header once its trigger scrolls behind it. Render it through <AnchoredPanel> instead.",
    ).toEqual([...POPUPS].sort());
  });
});

describe.each(DELEGATED)("%s", (rel) => {
  const code = read(rel);

  it("hands its popup to AnchoredPanel", () => {
    expect(code, `${rel} must render its popup through AnchoredPanel`).toContain("<AnchoredPanel");
  });

  it("does not draw a popup of its own beside it", () => {
    // Both halves matter. The surface is how a hand-rolled popup is spotted; `absolute` is how the
    // one this replaced was positioned, and it is the positioning — not the styling — that put a
    // dropdown over the form's header bar.
    expect(code, `${rel}: a second popup drawn here would skip AnchoredPanel's placement`).not.toContain(
      "dropdownSurfaceCls",
    );
    expect(code, `${rel}: an absolutely positioned popup is the bug AnchoredPanel exists to fix`).not.toMatch(
      /className=\{?[`"][^`"]*\babsolute\b[^`"]*\bz-\d/,
    );
  });
});

// ── The themed scrollbar ───────────────────────────────────────────────────────────────────────
//
// globals.css styles every scrollbar in the app: 6px, transparent track, a rounded `var(--border)`
// thumb that follows the theme. Chrome throws ALL of that away for an element whose `scrollbar-width`
// is set, and draws its native bar instead — 10px, and light-coloured on the dark theme, because the
// app never declares `color-scheme: dark`.
//
// So `[scrollbar-width:thin]` is not a smaller scrollbar. It is a bigger, un-themed one, and having it
// on two of the dropdowns put two different scrollbars on one purchase-request form. Hiding the bar
// outright (`none`) is a different decision and stays allowed, for the two places that replace it with
// something else.
const MAY_HIDE_THEIR_SCROLLBAR = [
  // Base UI shows themed up/down chevrons at the popup's edges instead.
  "components/ui/Select.tsx",
  // A horizontal strip of tabs, with fades at its edges to say it scrolls.
  "components/ui/TabPills.tsx",
];

describe("the app's themed scrollbar", () => {
  it("is not overridden by any dropdown", () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) return walk(rel);
        return e.name.endsWith(".tsx") ? [rel] : [];
      });

    const offenders = walk("").filter((f) => /scrollbar-width:\s*thin/.test(read(f)));
    expect(
      offenders,
      "`scrollbar-width: thin` makes Chrome ignore the app's own scrollbar styling and draw a wider, " +
        "un-themed native bar — light-on-dark in the dark theme. Delete it; the global rule in " +
        "globals.css already gives this list a 6px themed bar.",
    ).toEqual([]);

    const hiders = walk("").filter((f) => /scrollbar-width:\s*none/.test(read(f)));
    expect(hiders.sort(), "hiding a scrollbar means replacing it with another affordance").toEqual(
      [...MAY_HIDE_THEIR_SCROLLBAR].sort(),
    );
  });
});
