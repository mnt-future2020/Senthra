import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { toolbarInputCls } from "@/components/ui/styles";

// Declare-hire-lost writes off somebody else's equipment against a named person, so every one of its
// five controls has to be readable, reachable and captioned. Two things broke when the three native
// <select>s became <Select>:
//
//   1. The captions stopped being <label>s. A <Select> renders a <button> trigger, which a wrapping
//      <label> cannot associate with the way it does the number input below it — so the caption
//      stopped being clickable and the required mark dropped out of the accessible name. A <button>
//      IS a labelable element, so `htmlFor` pointing at the trigger's id restores both.
//   2. The dialog's own hand-rolled field class was `py-2` while `<Select size="sm">` is `py-2.5`,
//      leaving three controls a notch taller than the two beside them in one short form.
//
// Asserted from source: this suite has no DOM, so the alternative is asserting nothing.

const FILE = join(process.cwd(), "src", "components", "dashboard", "rentals", "DeclareHireLostModal.tsx");
// A CRLF-safe stripper — see suggestInputKeys.test.ts for why `//.*$` cannot be used here.
const CODE = readFileSync(FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");

describe("every caption names its control", () => {
  const CAPTIONS = ["Which hire", "Who was holding it", "Reason"];

  // Anchored on the caption as it is WRITTEN — "Reason" alone also matches `setReason`.
  const captionAt = (caption: string) => CODE.indexOf(`${caption} <span`);

  it.each(CAPTIONS)("%s is a <label>, not a bare <span>", (caption) => {
    const at = captionAt(caption);
    expect(at, `${caption} is no longer captioned in the dialog`).toBeGreaterThan(0);
    const openingTag = CODE.lastIndexOf("<label", at);
    const between = CODE.slice(openingTag, at);
    expect(between, `${caption} lost its <label>`).toMatch(/<label\s+htmlFor=\{/);
    expect(between, `${caption}'s label is not the nearest tag`).not.toContain("</label>");
  });

  it.each(CAPTIONS)("%s keeps the required mark inside the label, so it is part of the name", (caption) => {
    const at = captionAt(caption);
    expect(CODE.slice(at, at + 120)).toContain("text-[var(--neg)]");
  });

  it("gives each Select the id its label points at", () => {
    for (const id of ["hireId", "holderId", "reasonId"]) {
      expect(CODE, `${id} is not declared`).toContain(`const ${id} = React.useId()`);
      expect(CODE, `no label points at ${id}`).toContain(`htmlFor={${id}}`);
      expect(CODE, `no Select carries ${id}`).toContain(`id={${id}}`);
    }
  });

  // aria-label would WIN over the <label> element and drop the required mark from the name again.
  it("does not re-add an ariaLabel that would override the label element", () => {
    expect(CODE).not.toMatch(/ariaLabel="(Which hire|Who was holding it|Reason)"/);
  });

  // The quantity and notes fields wrap their control directly; nothing here should have changed them.
  it("leaves the two wrapping labels alone", () => {
    expect(CODE.match(/<label className="block">/g) ?? []).toHaveLength(2);
  });
});

describe("all five controls sit on one geometry", () => {
  // `<Select size="sm">` and `toolbarInputCls` are the same compact family — `rounded-lg`, `py-2.5`,
  // `text-xs`. The dialog used to hand-roll a near-copy that differed only in height.
  it("uses the shared compact input class rather than a local copy", () => {
    expect(CODE).toContain("toolbarInputCls");
    expect(CODE, "the hand-rolled fieldCls is what drifted").not.toContain("fieldCls");
  });

  it("that shared class matches the Select trigger's height", () => {
    expect(toolbarInputCls).toContain("py-2.5");
    expect(toolbarInputCls).toContain("rounded-lg");
    expect(toolbarInputCls).toContain("text-xs");
  });

  it("keeps the three Selects on the compact size", () => {
    expect(CODE.match(/size="sm"/g) ?? []).toHaveLength(3);
  });
});

describe("what must NOT have changed", () => {
  // The submit payload and its guard are business behaviour; this was a presentation fix.
  it("still guards submit on hire, holder, reason and quantity", () => {
    expect(CODE).toContain("!target || !hire || !chosen || !reason || quantity < 1 || quantity > max");
  });

  it("still posts the same declaration", () => {
    expect(CODE).toContain("rentalService.declareHireLost(hire.purchaseOrderId, hire.lineId, {");
    for (const field of ["engineerId:", "engineerName:", "quantity,", "reason,"]) {
      expect(CODE).toContain(field);
    }
  });

  it("still clears the form on every exit", () => {
    expect(CODE).toContain("const close = () => {");
    for (const setter of ["setLineId(\"\")", "setEngineerId(\"\")", "setQuantity(1)", "setReason(\"\")", "setNotes(\"\")"]) {
      expect(CODE).toContain(setter);
    }
  });
});
