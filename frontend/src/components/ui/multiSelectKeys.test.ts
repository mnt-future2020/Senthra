import { describe, expect, it } from "vitest";

import { multiSelectKey, type MultiSelectKeyState } from "./multiSelectKeys";

// The keyboard contract of a shared control, asserted without a DOM — this suite is Node-only, so a
// decision left inside a React handler is a decision nothing can test. It regressed once already:
// Escape inside a dialog closed the DIALOG, throwing away a half-filled form.

const state = (over: Partial<MultiSelectKeyState> = {}): MultiSelectKeyState => ({
  open: true,
  active: 0,
  count: 3,
  query: "",
  selectedCount: 0,
  ...over,
});

describe("Escape belongs to the innermost layer that can act on it", () => {
  // THE regression. <Modal> listens for Escape on the document, so one press used to close the menu
  // AND the dialog behind it. A nested dismissible has to consume the key it handles.
  it("closes the menu and stops the event when the menu is open", () => {
    const r = multiSelectKey("Escape", state({ open: true }));
    expect(r.action).toEqual({ type: "close" });
    expect(r.stopPropagation, "the parent dialog must not also see this Escape").toBe(true);
    expect(r.preventDefault).toBe(true);
  });

  // The mirror case, and just as important: with the menu already closed, Escape must reach the
  // dialog — otherwise a MultiSelect anywhere inside makes that dialog un-dismissable by keyboard.
  it("lets Escape through when the menu is already closed", () => {
    const r = multiSelectKey("Escape", state({ open: false }));
    expect(r.action).toEqual({ type: "none" });
    expect(r.stopPropagation).toBe(false);
    expect(r.preventDefault).toBe(false);
  });

  // So two presses dismiss both layers, in the order the user sees them.
  it("takes two presses to leave a dialog: menu first, then the dialog", () => {
    expect(multiSelectKey("Escape", state({ open: true })).action).toEqual({ type: "close" });
    expect(multiSelectKey("Escape", state({ open: false })).stopPropagation).toBe(false);
  });
});

describe("Enter toggles the highlighted option", () => {
  it("toggles whatever is active", () => {
    const r = multiSelectKey("Enter", state({ active: 2 }));
    expect(r.action).toEqual({ type: "toggle" });
    expect(r.preventDefault).toBe(true);
  });

  it("works when the query has narrowed the list to one option", () => {
    // The exact shape a user reaches by typing a name: one match, highlighted at index 0.
    expect(multiSelectKey("Enter", state({ count: 1, active: 0, query: "financetest" })).action).toEqual({
      type: "toggle",
    });
  });

  // Nothing to toggle means Enter must fall through — inside a form that is the submit the user meant.
  it("does nothing, and consumes nothing, when there is no option to act on", () => {
    expect(multiSelectKey("Enter", state({ open: false })).action).toEqual({ type: "none" });
    expect(multiSelectKey("Enter", state({ count: 0 })).action).toEqual({ type: "none" });
    expect(multiSelectKey("Enter", state({ count: 0 })).preventDefault).toBe(false);
  });

  // Never stops propagation: Enter is not a dismissal, and swallowing it would break a submit above.
  it("never stops the event", () => {
    expect(multiSelectKey("Enter", state()).stopPropagation).toBe(false);
    expect(multiSelectKey("Enter", state({ count: 0 })).stopPropagation).toBe(false);
  });
});

describe("arrow navigation", () => {
  it("opens the menu on the first press rather than moving inside a closed one", () => {
    expect(multiSelectKey("ArrowDown", state({ open: false })).action).toEqual({ type: "open" });
    expect(multiSelectKey("ArrowUp", state({ open: false })).action).toEqual({ type: "open" });
  });

  it("moves down and up within the list", () => {
    expect(multiSelectKey("ArrowDown", state({ active: 0 })).action).toEqual({ type: "move", index: 1 });
    expect(multiSelectKey("ArrowUp", state({ active: 2 })).action).toEqual({ type: "move", index: 1 });
  });

  // Clamped rather than wrapping: a list that jumps from the bottom back to the top loses the user's
  // place, and this control is often read top-to-bottom while typing.
  it("stops at the ends instead of wrapping", () => {
    expect(multiSelectKey("ArrowDown", state({ active: 2, count: 3 })).action).toEqual({ type: "move", index: 2 });
    expect(multiSelectKey("ArrowUp", state({ active: 0 })).action).toEqual({ type: "move", index: 0 });
  });

  it("suppresses the caret movement the browser would otherwise do", () => {
    expect(multiSelectKey("ArrowDown", state()).preventDefault).toBe(true);
    expect(multiSelectKey("ArrowUp", state()).preventDefault).toBe(true);
  });
});

describe("Backspace removes the last chip only when the search box is empty", () => {
  it("removes the last chip on an empty query", () => {
    expect(multiSelectKey("Backspace", state({ query: "", selectedCount: 2 })).action).toEqual({ type: "removeLast" });
  });

  it("edits the text instead when there is a query, or nothing is selected", () => {
    expect(multiSelectKey("Backspace", state({ query: "fin", selectedCount: 2 })).action).toEqual({ type: "none" });
    expect(multiSelectKey("Backspace", state({ query: "", selectedCount: 0 })).action).toEqual({ type: "none" });
  });

  // Never prevented: the keypress still has to delete a character in every other case.
  it("never suppresses the browser's own handling", () => {
    expect(multiSelectKey("Backspace", state({ selectedCount: 2 })).preventDefault).toBe(false);
  });
});

describe("everything else is left alone", () => {
  it("ignores ordinary typing and navigation keys", () => {
    for (const k of ["a", "Tab", "Home", " ", "ArrowLeft", "Shift"]) {
      const r = multiSelectKey(k, state());
      expect(r.action, `${k} must not be intercepted`).toEqual({ type: "none" });
      expect(r.preventDefault).toBe(false);
      expect(r.stopPropagation).toBe(false);
    }
  });

  // Tab in particular: <Modal> traps focus with it, so intercepting it would break the trap.
  it("never consumes Tab, which the dialog's focus trap needs", () => {
    expect(multiSelectKey("Tab", state({ open: true })).stopPropagation).toBe(false);
  });
});
