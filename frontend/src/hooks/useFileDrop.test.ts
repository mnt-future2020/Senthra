import { describe, expect, it } from "vitest";

import { decideDrag, dragCarriesFiles, dragTransition, dropRing } from "./useFileDrop";

// The hook itself is DOM plumbing and this repo has no DOM test environment (vitest runs in Node;
// jsdom is not installed and adding it for a handful of assertions is not worth a dependency). What
// IS pinned here is every decision in it that is a RULE rather than plumbing — which drags count as
// uploads, whether a drag is claimed, and what the target looks like — because those are where the
// bugs were.
//
// The claim these do NOT cover — that a dropped file runs the same validation as a chosen one — is
// structural rather than testable here: every surface passes its EXISTING pick handler to the hook,
// so there is only one function and nothing to diverge. It is verified in the browser.

describe("dragCarriesFiles", () => {
  it("recognises a file drag", () => {
    expect(dragCarriesFiles(["Files"])).toBe(true);
    // A real file drag from a desktop file manager carries more than just "Files".
    expect(dragCarriesFiles(["Files", "application/x-moz-file"])).toBe(true);
  });

  // Dragging selected text or a link across the form must not light the target — the drop would
  // yield no files and the ring would have promised something that then did nothing.
  it.each([
    ["selected text", ["text/plain"]],
    ["a link", ["text/uri-list", "text/plain"]],
    ["an HTML fragment", ["text/html"]],
    ["nothing", [] as string[]],
  ])("ignores %s", (_label, types) => {
    expect(dragCarriesFiles(types)).toBe(false);
  });

  // `dataTransfer` is optional on the event type, and a synthetic or partial event can arrive
  // without one. Reading through it must not throw inside a drag handler.
  it("treats a missing type list as not a file drag", () => {
    expect(dragCarriesFiles(undefined)).toBe(false);
  });
});

describe("dropRing", () => {
  // A RING, not a border. `ring` draws outside the box, so the target does not shift by 2px the
  // moment a file is dragged over it — which on a form with two pickers side by side would nudge
  // the whole row.
  it("adds a visible ring only while dragging", () => {
    expect(dropRing(true)).toContain("ring-2");
    expect(dropRing(false)).not.toContain("ring-2");
  });

  // The idle and active states must agree on every non-ring class, or the element changes shape when
  // a drag begins. Both keep the same corner radius.
  it("keeps the same geometry in both states", () => {
    expect(dropRing(true)).toContain("rounded-xl");
    expect(dropRing(false)).toContain("rounded-xl");
  });

  it("never uses a border, which would resize the element", () => {
    expect(dropRing(true)).not.toMatch(/\bborder\b/);
  });
});

// ── The disabled-drop regression ───────────────────────────────────────────────────────────────
//
// `onDragOver` used to read `if (disabled || !carriesFiles(e)) return;` BEFORE its preventDefault().
// An element that does not cancel dragover is not a drop target, so `drop` was never dispatched to
// it and the browser ran its own default instead: NAVIGATE THE TAB TO THE FILE. Dropping a second
// document while the first was still uploading therefore threw away a half-filled PRF or job form.
//
// The fix separates "claim this drag" from "accept this file", and these pin that separation. The
// invariant to protect: for a FILE drag, `claim` is true no matter what `disabled` says.
describe("decideDrag", () => {
  const FILES = ["Files"];

  it("claims a file drag and accepts it when enabled", () => {
    expect(decideDrag(FILES, false)).toEqual({ claim: true, effect: "copy", accept: true });
  });

  // THE regression. Claimed (so the browser cannot navigate) but not accepted (so nothing uploads).
  it("still claims a file drag when disabled, but does not accept it", () => {
    const d = decideDrag(FILES, true);
    expect(d.claim, "a disabled target must remain the drop target").toBe(true);
    expect(d.accept, "a disabled target must not take the file").toBe(false);
  });

  it("claims a file drag whether or not the target is disabled", () => {
    for (const disabled of [true, false]) {
      expect(decideDrag(FILES, disabled).claim, `disabled=${disabled}`).toBe(true);
    }
  });

  // The cursor tells the user before they let go, instead of the drop silently vanishing.
  it("shows no drop effect while disabled", () => {
    expect(decideDrag(FILES, true).effect).toBe("none");
    expect(decideDrag(FILES, false).effect).toBe("copy");
  });

  // A non-file drag is NOT claimed either way — cancelling a dragged link or selection would break
  // ordinary browsing, and there is no file to lose.
  it.each([
    ["selected text", ["text/plain"]],
    ["a link", ["text/uri-list", "text/plain"]],
    ["nothing", [] as string[]],
  ])("does not claim %s", (_l, types) => {
    for (const disabled of [true, false]) {
      expect(decideDrag(types, disabled)).toEqual({ claim: false, effect: "none", accept: false });
    }
  });

  it("does not claim a drag with no type list at all", () => {
    expect(decideDrag(undefined, false).claim).toBe(false);
  });

  // accept implies claim, always. A decision that accepted without claiming would take a file the
  // browser had already navigated away from.
  it.each([[FILES, true], [FILES, false], [["text/plain"], true], [["text/plain"], false]] as const)(
    "never accepts what it did not claim (%o, disabled=%s)",
    (types, disabled) => {
      const d = decideDrag(types, disabled);
      if (d.accept) expect(d.claim).toBe(true);
    },
  );
});

// ── The state machine ──────────────────────────────────────────────────────────────────────────
//
// `dragTransition` is the whole of what the four handlers decide; the hook only applies it. Testing
// it directly is what makes the two regressions below provable without a DOM, and what stops the
// handlers drifting apart again — they no longer each hold a rule of their own.
describe("dragTransition", () => {
  const FILES = ["Files"];
  const TEXT = ["text/plain"];
  const URI = ["text/uri-list", "text/plain"];
  const PHASES = ["enter", "over", "leave", "drop"] as const;

  describe("claiming", () => {
    it("claims a file drag on every phase, enabled or disabled", () => {
      for (const phase of PHASES) {
        for (const disabled of [true, false]) {
          expect(dragTransition(phase, 0, FILES, disabled).claim, `${phase} disabled=${disabled}`).toBe(true);
        }
      }
    });

    // THE Job-form regression. `onDrop` used to call preventDefault() unconditionally, so a URL
    // dropped into an attachment LINK input bubbled up to the wrapper and was cancelled there — the
    // text never landed in the field. Cancelling in the bubble phase kills the input's own default
    // just as dead as cancelling on the input would.
    it.each([
      ["selected text", TEXT],
      ["a link", URI],
      ["an HTML fragment", ["text/html"]],
      ["nothing", [] as string[]],
      ["no type list at all", undefined],
    ])("never claims %s — on any phase, drop included", (_label, types) => {
      for (const phase of PHASES) {
        for (const disabled of [true, false]) {
          expect(dragTransition(phase, 0, types, disabled).claim, `${phase} disabled=${disabled}`).toBe(false);
        }
      }
    });

    // The same fact stated as what the user experiences: a URL dropped over the Job attachment list
    // is left entirely to the browser and the input under the cursor.
    it("leaves a dropped URL completely alone", () => {
      const out = dragTransition("drop", 0, URI, false);
      expect(out.claim, "must not preventDefault").toBe(false);
      expect(out.deliver, "must not reach the upload path").toBe(false);
    });

    // An unclaimed drag must not unwind a file drag's depth either — depth belongs to whoever
    // incremented it.
    it("does not touch the depth of a drag it did not claim", () => {
      expect(dragTransition("leave", 2, TEXT, false).depth).toBe(2);
      expect(dragTransition("drop", 2, TEXT, false).depth).toBe(2);
    });
  });

  describe("delivering", () => {
    it("delivers an enabled file drop", () => {
      expect(dragTransition("drop", 1, FILES, false)).toMatchObject({
        claim: true,
        deliver: true,
        depth: 0,
        over: false,
      });
    });

    // Claimed (so the browser cannot navigate the tab to the file and throw away a half-filled form)
    // but not delivered (so nothing uploads past a gate the click path enforces).
    it("claims but does not deliver a disabled file drop", () => {
      const out = dragTransition("drop", 1, FILES, true);
      expect(out.claim, "still the drop target — the browser must not navigate").toBe(true);
      expect(out.deliver, "but nothing is uploaded").toBe(false);
    });

    it("never delivers on a phase that is not a drop", () => {
      for (const phase of ["enter", "over", "leave"] as const) {
        expect(dragTransition(phase, 1, FILES, false).deliver, phase).toBe(false);
      }
    });
  });

  describe("depth", () => {
    // A drag over a child fires dragleave on the parent. Pairing them is what stops the ring
    // flickering off every time the cursor crosses the button inside the target.
    it("survives nested enter/leave pairs and ends not dragging", () => {
      let depth = 0;
      let over = false;
      for (const phase of ["enter", "enter", "enter", "leave", "leave", "leave"] as const) {
        const out = dragTransition(phase, depth, FILES, false);
        depth = out.depth;
        over = out.over;
      }
      expect(depth).toBe(0);
      expect(over, "the ring must be off once the drag has fully left").toBe(false);
    });

    it("stays lit while any nesting level remains", () => {
      const afterTwo = dragTransition("enter", 1, FILES, false);
      expect(afterTwo.depth).toBe(2);
      expect(dragTransition("leave", afterTwo.depth, FILES, false).over).toBe(true);
    });

    // A dragleave with no matching dragenter — the drag began over a child that mounted mid-drag.
    // Going negative would desynchronise every later pair.
    it("floors at zero", () => {
      expect(dragTransition("leave", 0, FILES, false).depth).toBe(0);
    });

    it("ends the drag outright on drop, however deep it was", () => {
      expect(dragTransition("drop", 3, FILES, false)).toMatchObject({ depth: 0, over: false });
    });
  });

  // ── THE mid-drag disable regression ──────────────────────────────────────────────────────────
  //
  // `onDragLeave` used to return early while disabled, so a target that disabled DURING a drag never
  // unwound its depth. The drag ended, the state said it had not, and the ring came back and stuck
  // the moment the target re-enabled. The fix is that enter and leave are both keyed on `claim`,
  // which for a file drag does not depend on `disabled` at all — so the pair balances no matter what
  // happens between them.
  describe("disabling mid-drag", () => {
    it("unwinds a drag that entered enabled and left disabled", () => {
      const entered = dragTransition("enter", 0, FILES, false);
      expect(entered).toMatchObject({ depth: 1, over: true });

      // ...the upload starts, or the count cap is reached: the target disables under the cursor.
      const left = dragTransition("leave", entered.depth, FILES, true);
      expect(left.depth, "depth must unwind even while disabled").toBe(0);
      expect(left.over, "and the drag must be over").toBe(false);
    });

    it("leaves nothing behind to resurrect when the target re-enables", () => {
      const entered = dragTransition("enter", 0, FILES, false);
      const left = dragTransition("leave", entered.depth, FILES, true);
      // Re-enabled, drag long gone. The next event must find a clean slate.
      const after = dragTransition("over", left.depth, FILES, false);
      expect(after.over, "no stale ring").toBe(false);
      expect(after.depth).toBe(0);
    });

    it("unwinds a drag that entered disabled and left enabled", () => {
      const entered = dragTransition("enter", 0, FILES, true);
      expect(entered.depth, "a disabled target still counts the drag it claimed").toBe(1);
      expect(dragTransition("leave", entered.depth, FILES, false).depth).toBe(0);
    });

    // A drop is the other way a drag ends while disabled, and no dragleave follows it — so the drop
    // has to clear the state by itself.
    it("clears the state on a disabled drop", () => {
      const entered = dragTransition("enter", 0, FILES, false);
      expect(dragTransition("drop", entered.depth, FILES, true)).toMatchObject({
        depth: 0,
        over: false,
        deliver: false,
      });
    });

    // The invariant behind all four: for a file drag, enter and leave agree on whether they count,
    // whatever `disabled` does in between. That is what makes them balance.
    it("counts enter and leave identically regardless of disabled", () => {
      for (const phase of ["enter", "leave"] as const) {
        expect(dragTransition(phase, 1, FILES, true).depth).toBe(dragTransition(phase, 1, FILES, false).depth);
      }
    });
  });

  describe("cursor", () => {
    it("offers copy only where the file will be taken", () => {
      expect(dragTransition("over", 1, FILES, false).effect).toBe("copy");
      expect(dragTransition("over", 1, FILES, true).effect).toBe("none");
    });
  });
});
