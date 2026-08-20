import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── The footer has to sit INSIDE the card it belongs to ────────────────────────────────────────
//
// `<Pagination embedded>` renders a strip with a top border and NO background of its own — that is
// the whole point of the prop, and it only reads correctly when the card wraps the table AND the
// footer. Several screens closed the card around the table alone and dropped the footer after it, so
// "Total: 12 deliveries" floated on the page background under a stray hairline while the same footer
// on the IRM catalogue sat neatly inside the card. Same component, same props, two different
// screens — the difference was the markup around it.
//
// The tell is a card that is ITSELF the horizontal scroller: `overflow-x-auto rounded-2xl`. A card
// that scrolls sideways cannot host a footer (the footer would scroll away with the rows), so the
// footer has nowhere to go but outside. The correct shape puts `overflow-hidden` on the card and
// `overflow-x-auto` on an inner wrapper around the table only:
//
//   <div className="… overflow-hidden rounded-2xl border …">   ← the card
//     <div className="overflow-x-auto"> <table/> </div>        ← only the rows scroll
//     <Pagination embedded … />                                ← the card's own footer strip
//   </div>
//
// Asserted by scanning source because this is a LAYOUT invariant: it never throws, never fails a
// type check, and looks fine on any screen whose list happens to be short.

const COMPONENTS = join(process.cwd(), "src", "components");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return entry.endsWith(".tsx") ? [full] : [];
  });
}

describe("<Pagination embedded> lives inside its table's card", () => {
  it("never lets the card itself be the horizontal scroller", () => {
    const offenders = tsxFiles(COMPONENTS)
      .filter((file) => {
        const src = readFileSync(file, "utf8");
        return src.includes("<Pagination") && src.includes("embedded") && /overflow-x-auto rounded-2xl/.test(src);
      })
      .map((f) => f.replace(process.cwd(), "").replace(/\\/g, "/"));

    expect(
      offenders,
      "these screens scroll the CARD sideways, so the embedded footer had to be placed outside it — " +
        "move overflow-x-auto onto an inner wrapper around the table and let the card hold both",
    ).toEqual([]);
  });
});
