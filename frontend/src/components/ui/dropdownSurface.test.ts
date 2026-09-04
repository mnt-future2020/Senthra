import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
  "components/ui/Select.tsx",
  "components/ui/MultiSelect.tsx",
  "components/ui/CreatableSelect.tsx",
  "components/ui/SuggestInput.tsx",
  "components/dashboard/irm/IrmItemPicker.tsx",
  "components/dashboard/stock/StockItemPicker.tsx",
  "components/dashboard/rentals/RentalItemPicker.tsx",
  "components/dashboard/users-roles/job-titles/JobTitleCombobox.tsx",
  "components/dashboard/users-roles/departments/DepartmentCombobox.tsx",
  "components/dashboard/warehouses/ExpectedDeliveries.tsx",
  // The profile menu at the foot of the sidebar. Missed by the first sweep precisely because it is
  // not a form control, which is why the list above is written out rather than inferred.
  "components/dashboard/shell/Sidebar.tsx",
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
