import { describe, expect, it } from "vitest";

import { decideDrag, dragCarriesFiles, dragTransition, dropRing, isOverInSession, strayDragAction } from "./useFileDrop";

// The hook itself is DOM plumbing and this repo has no DOM test environment (vitest runs in Node;
// jsdom is not installed and adding it for a handful of assertions is not worth a dependency). What
// IS pinned here is every decision in it that is a RULE rather than plumbing — which drags count as
// uploads, whether a drag is claimed, and what the target looks like — because those are where the
// bugs were.
//
// The claim these do NOT cover — that a dropped file runs the same validation as a chosen one — is
// structural rather than testable here: every surface passes its EXISTING pick handler to the hook,
// so there is only one function and nothing to diverge. It is verified in the browser.

// `dragCarriesFiles` decides whether a drag is an upload at all. It gates the per-element handlers
// AND the app-wide swallow, so a regression here either stops every drop target working or starts
// eating the browser's own text and link drops across the whole app.
describe("dragCarriesFiles", () => {
  it("recognises a file drag", () => {
    expect(dragCarriesFiles(["Files"])).toBe(true);
    // A real file drag from a desktop file manager carries more than just "Files".
    expect(dragCarriesFiles(["Files", "application/x-moz-file"])).toBe(true);
  });

  // Dragging selected text or a link across the form must not light a target — and must not be
  // swallowed by the window guard either, or every text input in the app stops accepting drops.
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

  it("matches the type exactly rather than by prefix", () => {
    expect(dragCarriesFiles(["FilesX"])).toBe(false);
    expect(dragCarriesFiles(["files"])).toBe(false);
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

// ── The app-wide guard ─────────────────────────────────────────────────────────────────────────
//
// A drop target protects only the pixels it covers. Everywhere else on the page the BROWSER is the
// drop target, and its default for a file is to navigate the tab to it — on a half-filled purchase
// request, the whole form with no undo. Measured on the PRF create form: the strip was 547x38 inside
// a 547x83 group, so over half of the block being aimed at was a destructive miss.
//
// `strayDragAction` is that guard's whole decision, read in the BUBBLE phase at the window.
describe("strayDragAction", () => {
  const FILES = ["Files"];

  it("swallows a file drop that no target claimed", () => {
    expect(strayDragAction(FILES, false)).toBe("swallow");
  });

  // A real picker cancelled it on the way up; second-guessing that would fight the surface.
  it("leaves a file drop that a target already claimed", () => {
    expect(strayDragAction(FILES, true)).toBe("ignore");
  });

  // THE rule that keeps the browser usable. Dragging a URL into the job form's attachment-link
  // input, or text into any field, is the browser's business — swallowing it app-wide would break
  // every text input on every page at once.
  it.each([
    ["selected text", ["text/plain"]],
    ["a link", ["text/uri-list", "text/plain"]],
    ["an HTML fragment", ["text/html"]],
    ["nothing", [] as string[]],
    ["no type list", undefined],
  ])("never swallows %s, claimed or not", (_label, types) => {
    for (const claimed of [true, false]) {
      expect(strayDragAction(types, claimed), `claimed=${claimed}`).toBe("ignore");
    }
  });

  // Stated as the invariant that matters: the only thing ever swallowed is an unclaimed FILE drag.
  it("swallows nothing except an unclaimed file drag", () => {
    const cases: [readonly string[] | undefined, boolean][] = [
      [FILES, true], [FILES, false],
      [["text/plain"], true], [["text/plain"], false],
      [undefined, true], [undefined, false],
    ];
    for (const [types, claimed] of cases) {
      const swallowed = strayDragAction(types, claimed) === "swallow";
      expect(swallowed).toBe(dragCarriesFiles(types) && !claimed);
    }
  });
});

// ── The three affordance states ────────────────────────────────────────────────────────────────
//
// idle → armed → over. `armed` is the answer to "I cannot see where to drop": the picker stays a
// plain button at rest and outlines itself only while a drag is actually in flight, so it costs no
// height in either state.
describe("dropRing states", () => {
  const idle = dropRing(false, false);
  const armed = dropRing(false, true);
  const over = dropRing(true, false);

  it("shows nothing at rest", () => {
    expect(idle).not.toMatch(/outline-(2|\[)/);
  });

  it("outlines dashed when armed but not yet hovered", () => {
    expect(armed).toContain("outline-dashed");
    expect(armed).not.toContain("outline-solid");
  });

  it("outlines solid and thicker when the file is over this target", () => {
    expect(over).toContain("outline-solid");
    expect(over).toContain("outline-[3px]");
    expect(over).not.toContain("outline-dashed");
  });

  // Mutually exclusive, so two outlines never fight. `over` wins — it is the more specific
  // statement, and with two groups side by side it is what disambiguates them.
  it("prefers the hovered state over the armed one", () => {
    const both = dropRing(true, true);
    expect(both).toContain("outline-solid");
    expect(both).not.toContain("outline-dashed");
  });

  /**
   * THE structural rule, and the bug it closes.
   *
   * This string is appended to elements that already carry their own classes — the PO and PRF
   * attachment cards bring `bg-[var(--surface)]` and `rounded-2xl`. It once also emitted
   * `bg-[var(--surface-2)]/50` and `rounded-xl`, so two rules set the same property on one element
   * and the winner was whichever Tailwind happened to emit last. Restricting this helper to
   * `outline-*` makes that collision impossible rather than merely fixed.
   */
  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "only ever emits outline utilities (dragging=%s armed=%s)",
    (dragging, armedState) => {
      const classes = dropRing(dragging, armedState).split(/\s+/).filter(Boolean);
      for (const c of classes) {
        expect(c, `${c} touches a property the host element owns`).toMatch(/^(outline-|transition-|duration-)/);
      }
    },
  );

  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "never sets a background or a radius (dragging=%s armed=%s)",
    (dragging, armedState) => {
      const cls = dropRing(dragging, armedState);
      expect(cls).not.toMatch(/bg-/);
      expect(cls).not.toMatch(/rounded/);
    },
  );

  // No state may change the element's SIZE, or the form reflows the moment a drag starts. `outline`
  // paints outside the box and reserves no space; `border` would not.
  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "never resizes the element (dragging=%s armed=%s)",
    (dragging, armedState) => {
      expect(dropRing(dragging, armedState)).not.toMatch(/border(-|)/);
    },
  );

  /**
   * THE clipping bug, pinned.
   *
   * A positive `outline-offset` paints outside the element's box, where an ancestor with
   * `overflow: auto` clips it. Every drop target here has one — the PO/PRF tab panel is
   * `overflow-auto` and flush with the card on three sides — so a positive offset was clipped on
   * top, left and right and left a single line under the card. Inside the box, nothing can clip it.
   */
  it.each([[false, true], [true, false], [true, true]])(
    "draws the outline INSIDE the box so a scroll container cannot clip it (dragging=%s armed=%s)",
    (dragging, armedState) => {
      const offset = dropRing(dragging, armedState).match(/outline-offset-\[(-?\d+)px\]/);
      expect(offset, "an outlined state must declare an explicit offset").not.toBeNull();
      expect(Number(offset![1]), "offset must be negative — a positive one gets clipped").toBeLessThan(0);
    },
  );

  // Back-compat: every existing call site passes one argument.
  it("defaults to not-armed when called with one argument", () => {
    expect(dropRing(false)).toBe(idle);
    expect(dropRing(true)).toBe(over);
  });
});

// ── Stale state cannot cross a drag ────────────────────────────────────────────────────────────
//
// The browser promises no closing event. Escape, or a release over another window, fires neither
// `dragleave` nor `drop` on the element the file was last over, so that element keeps saying "the
// file is over me" for the rest of the page's life.
//
// Hiding it while no drag is in flight was not enough, and this is the sequence that proved it:
// hover the Quote group, press Escape, then start a SECOND drag and hover the OTHER group — both
// groups showed the solid "over" outline at once, on a form where that outline is the only thing
// telling you which of the two will receive the file.
//
// Numbering the drags makes it structural: state from session N is simply not a match in N+1.
describe("isOverInSession", () => {
  it("is over when the recorded session is the one in flight", () => {
    expect(isOverInSession(4, 4)).toBe(true);
  });

  // THE regression, as one assertion.
  it("is NOT over when the record belongs to an earlier drag", () => {
    expect(isOverInSession(4, 5)).toBe(false);
  });

  it("is not over when no drag is in flight", () => {
    expect(isOverInSession(4, 0)).toBe(false);
    expect(isOverInSession(0, 0)).toBe(false);
  });

  it("is not over when the element was never entered in this drag", () => {
    expect(isOverInSession(0, 5)).toBe(false);
  });

  // Every element that did not record THIS session reads as not-over, whatever it is carrying —
  // which is what stops two side-by-side groups both claiming the file.
  it("matches only the exact session in flight", () => {
    const current = 7;
    for (const recorded of [0, 1, 5, 6, 8, 99]) {
      expect(isOverInSession(recorded, current), `recorded=${recorded}`).toBe(false);
    }
    expect(isOverInSession(current, current)).toBe(true);
  });
});
