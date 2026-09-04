// The "you already have one of these open" advisory, as a pure function — ported from the web's
// engineer/openLineAdvisory.ts so both surfaces say the same sentence about the same clash.
//
// TWO THINGS were wrong with the sentence this replaces, and both came from one cause: a single
// string served BOTH composers.
//
//   "Heads up — you already have an open request for: CAT6 U/UTP Cable, 305m box (VSR-0037),
//    Cat6 U/UTP Cable 305m Box (VSR-0037). You can still send this one."
//
//  • It spoke of a "request" you "send" on the RETURN screen, where nothing is sent and nothing is
//    requested — the engineer is handing kit back.
//  • It named every clashing item AND its reference inline, so its LENGTH grew with the cart. On a
//    handset, where the card is narrower than the web's, that is the difference between a two-line
//    warning and a five-line one pushing the form off screen.
//
// Hence: a fixed-length primary sentence (it says how many, never which), and the references demoted
// to a secondary line. Adding a third clashing item now costs no height at all.

/** One selected line that clashes with something already open. */
export interface OpenLineClash {
  name: string;
  /** The open request/return this item is already on, e.g. "VSR-0037". */
  code: string | undefined;
}

export interface OpenLineAdvisory {
  /** The banner sentence. Fixed length — never lists items, never carries a reference. */
  text: string;
  /** Compact second line naming what clashed. Undefined when there is nothing useful to add. */
  detail?: string;
}

// At most this many names are spelled out before the detail line switches to "+N more". Two keeps
// the line inside the card's width for realistic item names, which is what stops the second line
// wrapping into a third.
const MAX_NAMED = 2;

function label(c: OpenLineClash): string {
  return c.code ? `${c.name} (${c.code})` : c.name;
}

/**
 * Wording for the open-line advisory on either composer.
 *
 * `kind` picks the vocabulary, and that is the whole reason it is a parameter: a return is not a
 * request and is not sent. "include it here" is the action the engineer is actually taking — the
 * item joins THIS return alongside the one already open.
 *
 * Returns null when there is nothing to say, so the caller renders no banner and the form keeps its
 * height.
 */
export function openLineAdvisory(
  clashes: readonly OpenLineClash[],
  kind: "restock" | "return",
): OpenLineAdvisory | null {
  if (clashes.length === 0) return null;

  const one = clashes.length === 1;
  const noun = kind === "return" ? "return" : "request";
  // Singular vs plural rather than "1 item": "this item" reads as the row the engineer just touched,
  // which is exactly what it is.
  const subject = one
    ? `Open ${noun} already exists for this item.`
    : `Open ${noun}s already exist for ${clashes.length} of these items.`;
  const action =
    kind === "return"
      ? one
        ? "You can still include it here."
        : "You can still include them here."
      : one
        ? "You can still send this one."
        : "You can still send them here.";

  const all = clashes.map(label);
  const detail =
    all.length <= MAX_NAMED
      ? all.join(" · ")
      : `${all.slice(0, MAX_NAMED).join(" · ")} +${all.length - MAX_NAMED} more`;

  return { text: `${subject} ${action}`, detail };
}
