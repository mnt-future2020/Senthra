// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { FOCUSABLE_SELECTOR, leavesPanel, tabOutTarget } from "./focusOrder";

// The regression these exist for, as it happened: moving the combobox panel into a portal put it
// after every other control in the document, so Tab out of the last row of an item picker halfway
// up the purchase-order form left the page instead of going on to Quantity.

/** A form with a field, its trigger, two later controls — and the panel portalled to the end. */
function page() {
  document.body.innerHTML = `
    <form>
      <input id="before" />
      <button id="trigger" role="combobox"><span id="label">Item</span></button>
      <input id="qty" />
      <input id="price" />
    </form>
    <div id="panel">
      <input id="search" />
      <button id="opt1">A</button>
      <button id="opt2">B</button>
    </div>`;
  const $ = (id: string) => document.getElementById(id)!;
  return {
    $,
    ordered: [...document.querySelectorAll(FOCUSABLE_SELECTOR)],
    anchor: $("trigger"),
    panel: $("panel"),
    inPanel: [...$("panel").querySelectorAll(FOCUSABLE_SELECTOR)],
  };
}

describe("FOCUSABLE_SELECTOR", () => {
  it("collects the controls in DOCUMENT order, panel last", () => {
    const { ordered } = page();
    expect(ordered.map((e) => e.id)).toEqual(["before", "trigger", "qty", "price", "search", "opt1", "opt2"]);
  });

  it("skips what the browser would skip", () => {
    document.body.innerHTML = `
      <button id="a"></button>
      <button id="b" disabled></button>
      <div id="c" tabindex="-1"></div>
      <div id="d" tabindex="0"></div>`;
    expect([...document.querySelectorAll(FOCUSABLE_SELECTOR)].map((e) => e.id)).toEqual(["a", "d"]);
  });
});

describe("tabOutTarget — Tab continues from the FIELD, not from the panel", () => {
  it("lands on the control after the trigger", () => {
    const { ordered, anchor, panel } = page();
    expect(tabOutTarget(ordered, anchor, panel, false)?.id).toBe("qty");
  });

  // The bug, stated as the thing that must not happen again: document order says the next stop after
  // the panel's last row is nothing at all.
  it("does NOT continue from the panel's position in the document", () => {
    const { ordered, anchor, panel, $ } = page();
    const naive = ordered[ordered.indexOf($("opt2")) + 1];
    expect(naive).toBeUndefined();
    expect(tabOutTarget(ordered, anchor, panel, false)).not.toBeNull();
  });

  it("goes back to the trigger on Shift+Tab", () => {
    const { ordered, anchor, panel } = page();
    expect(tabOutTarget(ordered, anchor, panel, true)?.id).toBe("trigger");
  });

  it("returns null when the trigger is the last control on the page", () => {
    document.body.innerHTML = `<button id="trigger"></button><div id="panel"><button id="opt"></button></div>`;
    const ordered = [...document.querySelectorAll(FOCUSABLE_SELECTOR)];
    const target = tabOutTarget(ordered, document.getElementById("trigger")!, document.getElementById("panel")!, false);
    expect(target).toBeNull(); // the caller focuses the trigger, so focus is never dropped
  });

  it("returns null for an anchor that is not in the list at all", () => {
    const { ordered, panel } = page();
    expect(tabOutTarget(ordered, document.createElement("button"), panel, false)).toBeNull();
  });
});

describe("leavesPanel — only the press that steps off the edge", () => {
  // Tab still walks the panel's own rows. Four of these six lists have no arrow-key navigation, so
  // Tab is the ONLY way a keyboard reaches their options — intercepting every press would lock them
  // out of the list entirely.
  it("is false in the middle of the panel", () => {
    const { inPanel, $ } = page();
    expect(leavesPanel(inPanel, $("search"), false)).toBe(false);
    expect(leavesPanel(inPanel, $("opt1"), false)).toBe(false);
  });

  it("is true on the last row going forward", () => {
    const { inPanel, $ } = page();
    expect(leavesPanel(inPanel, $("opt2"), false)).toBe(true);
  });

  it("is true on the first control going back", () => {
    const { inPanel, $ } = page();
    expect(leavesPanel(inPanel, $("search"), true)).toBe(true);
    expect(leavesPanel(inPanel, $("opt2"), true)).toBe(false);
  });

  // A panel with nothing focusable in it (a menu of `role=option` divs, say) has no edge to stand
  // on, so any Tab press is the one that leaves.
  it("is true when the panel holds nothing focusable", () => {
    expect(leavesPanel([], document.body, false)).toBe(true);
    expect(leavesPanel([], null, true)).toBe(true);
  });
});
