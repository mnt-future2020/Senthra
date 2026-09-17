// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { anchorCovered, anchorObscured, anchorProbePoint, type Rect } from "./popoverPlacement";

// The other half of "may this panel stay open", split out because it needs a DOM: `anchorVisible`
// asks the WINDOW whether the trigger is on screen, and these two ask whether anything is painted
// on top of it. See anchorObscured's own comment for the bug that needed the second question — a
// purchase-order item dropdown left floating across the form's sticky header bar.

const rect = (left: number, top: number, w = 90, h = 42): Rect => ({
  left,
  right: left + w,
  top,
  bottom: top + h,
});

describe("anchorProbePoint — where to ask", () => {
  it("probes the middle of the trigger's bottom edge", () => {
    expect(anchorProbePoint(rect(326, 400))).toEqual({ x: 371, y: 440 });
  });

  // The bottom edge is the one the panel hangs from, so it is the one that has to be uncovered.
  // Probing the middle would call a trigger half-hidden behind a 77px header bar "fine" and open a
  // panel from a bottom edge nobody can see.
  it("does not probe the middle", () => {
    const r = rect(326, 400);
    expect(anchorProbePoint(r).y).toBeGreaterThan((r.top + r.bottom) / 2);
  });

  it("stays inside the trigger, so a shared border tests the trigger and not its neighbour", () => {
    const r = rect(326, 400);
    const { x, y } = anchorProbePoint(r);
    expect(y).toBeLessThan(r.bottom);
    expect(y).toBeGreaterThan(r.top);
    expect(x).toBeGreaterThan(r.left);
    expect(x).toBeLessThan(r.right);
  });

  it("rounds to whole pixels — elementFromPoint takes CSS pixels", () => {
    const { x, y } = anchorProbePoint({ left: 326.4, right: 702.6, top: 400.5, bottom: 442.5 });
    expect(Number.isInteger(x)).toBe(true);
    expect(Number.isInteger(y)).toBe(true);
  });
});

describe("anchorObscured — is anything painted over the trigger?", () => {
  const trigger = () => {
    const button = document.createElement("button");
    const label = document.createElement("span");
    button.appendChild(label);
    document.body.appendChild(button);
    return { button, label };
  };

  it("is not obscured when the hit lands on the trigger itself", () => {
    const { button } = trigger();
    expect(anchorObscured(button, button)).toBe(false);
  });

  // The trigger renders its label and a chevron; a hit-test at its bottom edge returns one of those,
  // not the button. Counting a child as "something else" would close every dropdown on first scroll.
  it("is not obscured when the hit lands on the trigger's own label", () => {
    const { button, label } = trigger();
    expect(anchorObscured(button, label)).toBe(false);
  });

  // A fractional rect can land the probe on the wrapper by a sub-pixel; that is still the trigger.
  it("is not obscured when the hit lands on a wrapper around the trigger", () => {
    const { button } = trigger();
    const wrap = document.createElement("div");
    wrap.appendChild(button);
    document.body.appendChild(wrap);
    expect(anchorObscured(button, wrap)).toBe(false);
  });

  // The reported bug: the form's sticky header is what the browser paints at the trigger's bottom
  // edge once the row has scrolled up behind it.
  it("is obscured when a sticky header is painted there instead", () => {
    const { button } = trigger();
    const header = document.createElement("div");
    document.body.appendChild(header);
    expect(anchorObscured(button, header)).toBe(true);
  });

  // Clipped by a scroll container's overflow, or scrolled clean off the window: either way nothing
  // of the trigger is painted at the point, and elementFromPoint says so with a null.
  it("is obscured when nothing is painted at the point at all", () => {
    const { button } = trigger();
    expect(anchorObscured(button, null)).toBe(true);
  });
});

// `anchorCovered` is the pair above joined to the live document, and the only piece that needs a
// browser to answer. It runs from a scroll handler, which is what makes the unanswerable case
// matter: jsdom has no `elementFromPoint` — it is not a function there — so a component test that
// scrolls with a dropdown open would take a TypeError instead of a verdict.
describe("anchorCovered — asking the document, safely", () => {
  const rect: Rect = { left: 326, right: 702, top: 400, bottom: 442 };
  const anchor = () => {
    const el = document.createElement("button");
    document.body.appendChild(el);
    return el;
  };
  type Probe = (x: number, y: number) => Element | null;
  // Cast through `unknown` to a shape where the method is OPTIONAL: `delete` needs that, and it is
  // also the honest type here, since the whole point is that jsdom ships without it.
  const withElementFromPoint = (fn: Probe | undefined, run: () => void) => {
    const doc = document as unknown as { elementFromPoint?: Probe };
    const had = "elementFromPoint" in doc;
    const prev = doc.elementFromPoint;
    if (fn) doc.elementFromPoint = fn;
    else delete doc.elementFromPoint;
    try {
      run();
    } finally {
      if (had) doc.elementFromPoint = prev;
      else delete doc.elementFromPoint;
    }
  };

  it("reports NOT covered when the environment has no elementFromPoint", () => {
    // jsdom as it actually is. The fallback has to be "not covered": dismissal then rests on
    // anchorVisible alone — the test that existed before — rather than every scroll closing
    // every panel in every DOM test.
    const el = anchor();
    withElementFromPoint(undefined, () => {
      expect(anchorCovered(el, rect)).toBe(false);
    });
  });

  it("probes the trigger's bottom edge and reports it uncovered when the hit is the trigger", () => {
    const el = anchor();
    const seen: Array<[number, number]> = [];
    withElementFromPoint(
      (x, y) => {
        seen.push([x, y]);
        return el;
      },
      () => {
        expect(anchorCovered(el, rect)).toBe(false);
      },
    );
    expect(seen).toEqual([[anchorProbePoint(rect).x, anchorProbePoint(rect).y]]);
  });

  it("reports covered when something else is painted at that point", () => {
    const el = anchor();
    const header = document.createElement("div");
    document.body.appendChild(header);
    withElementFromPoint(
      () => header,
      () => {
        expect(anchorCovered(el, rect)).toBe(true);
      },
    );
  });

  // The bug this argument exists for: a multi-select grows its control downward as chips wrap, which
  // happens with the menu still open. The 6px gap closes, the panel comes to lie across the bottom
  // edge of its own trigger, and the probe finds the PANEL there. Read as chrome, that closed the
  // menu on the second pick — the panel dismissing itself because it found itself.
  it("does not count the panel's own body as covering the trigger", () => {
    const el = anchor();
    const panel = document.createElement("div");
    const row = document.createElement("button");
    panel.appendChild(row);
    document.body.appendChild(panel);
    withElementFromPoint(
      () => row,
      () => {
        expect(anchorCovered(el, rect, panel)).toBe(false);
        // …and without being told which panel is its own, it still reads that hit as chrome.
        expect(anchorCovered(el, rect)).toBe(true);
      },
    );
  });

  it("still reports chrome as covering when a panel is passed", () => {
    const el = anchor();
    const panel = document.createElement("div");
    const header = document.createElement("div");
    document.body.append(panel, header);
    withElementFromPoint(
      () => header,
      () => {
        expect(anchorCovered(el, rect, panel)).toBe(true);
      },
    );
  });
});
