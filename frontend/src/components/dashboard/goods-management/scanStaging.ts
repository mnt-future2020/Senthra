// What a scan does to the panel's staged list — extracted from JobScanPanel so the rule that a scan
// lands ONCE, on the right card, is testable on its own.
//
// It got its own module the day a rental return proved it was not one rule but three: which cards a
// single scan resolves to, which card is which (identity), and which of them the scan counts against.
// Inline in a 900-line component, the three were one `find` and a clamp, and the clamp quietly capped a
// two-hire kit line at one hire's worth of units.

import type { ScanMatch } from "@/types/goodsManagement";

export interface ScanLine {
  key: string; // stable unique key for React list
  match: ScanMatch;
  qty: number; // ISSUE: quantity to issue (unused on return)
  goodQty: number; // RETURN: good portion
  damagedQty: number; // RETURN: damaged portion
  damagePhotoDataUrl?: string; // data URI — kept for the preview image only
  damagePhotoUrl?: string; // Cloudinary-hosted URL sent to backend
  damagePhotoUploading?: boolean; // true while the upload is in flight
  damageReason?: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/** The ceiling for one card: what may still be issued on it, or what may still come back on it. */
export function capOf(match: ScanMatch, isIssue: boolean) {
  return isIssue ? match.remainingIssuable : match.heldByEngineer;
}

/**
 * Identity of a staged card — what a re-scan bumps instead of duplicating.
 *
 * A RENTAL is keyed by its HIRE, not by its item or kit line: the same tester can be out on two
 * different orders at once, each with its own deadline and its own return cap, and a movement line
 * names exactly one of them. Keyed by the kit line alone, the two collapsed into a single card capped
 * at the FIRST hire's units — so a line issued 2 off two POs could never stage more than 1, and the
 * second unit was unreachable until the first had been posted and the panel re-scanned.
 */
export function lineKey(match: ScanMatch) {
  if (match.source === "rental" && match.purchaseOrderRentalLineId) {
    return `${match.jobKitLineId ?? match.rentalItemId}:${match.purchaseOrderRentalLineId}`;
  }
  return match.irmItemId ?? match.customerStockEntryId ?? match.jobKitLineId ?? match.itemName;
}

/**
 * The cards ONE scan resolves to, in the order the scan should fill them.
 *
 * Almost always exactly one. The exception is a rental, where the server reports every hire this line
 * touches (`hires`) because a single catalogue code can stand for units sitting on several different
 * orders. Going OUT that is the allocator's split — 12 testers drawn 4 + 4 + 3 + 1 off four POs.
 * Coming BACK it is what the engineer is holding off each. Either way the operator, standing at the
 * counter with the kit in front of them, should not have to post and re-scan to discover the rest.
 *
 * Each card carries its own hire and its own cap, and the server has already spent those caps against
 * what the kit line needs or owes — so what this stages is exactly what the post will accept.
 */
export function expandMatch(match: ScanMatch, isIssue: boolean): ScanMatch[] {
  if (match.source !== "rental" || !match.hires || match.hires.length <= 1) return [match];
  return match.hires.map((h) => ({
    ...match,
    purchaseOrderRentalLineId: h.purchaseOrderRentalLineId,
    hire: { poCode: h.poCode, hireEndDate: h.hireEndDate, itemName: match.itemName, overdue: h.overdue },
    // `qty` is this hire's share either way; which field it lands in is what the direction decides.
    // `available` is the hire's own stock, NOT its share — see the note on ScanHire.
    ...(isIssue
      ? { remainingIssuable: h.qty, available: h.available ?? match.available }
      : { heldByEngineer: h.qty }),
  }));
}

/**
 * Apply one scan to the staged list.
 *
 * Two steps, and they are separate on purpose:
 *
 * 1. Every card the scan resolved to is put on the list, so the operator sees the whole line at once.
 *    The extras arrive EMPTY — a scan is one physical unit, and inventing quantities for the others
 *    would put units on a movement nobody counted. The stepper dials them up.
 * 2. The scan itself is counted ONCE, against the first card with room, in the server's order — so a
 *    return fills the soonest deadline first, the same rule the binding follows.
 *
 * When every card is already full the scan is a no-op, which is what the clamp it replaced did.
 *
 * `staged` must already be filtered to cards with capacity (see capOf) — a zero-cap match is a
 * different conversation with the user, and the caller has the toast for it.
 */
/**
 * The staged cards that will actually become movement lines.
 *
 * A card left at zero is an OFFER the operator declined, not a line — which is a rule the extra hire
 * cards force, because they arrive empty by design. Posting them would send `qty: 0` and the server
 * rejects the whole movement over it (`qty` is min 1); refusing to post until every card is filled
 * would make a scan that offers three hires impossible to complete unless the job wanted all three.
 *
 * The panel's Post button counts these and disables itself on an empty result, so declining every
 * offer cannot silently post nothing.
 */
export function postableLines(lines: ScanLine[], isIssue: boolean): ScanLine[] {
  return lines.filter((l) => (isIssue ? l.qty : l.goodQty + l.damagedQty) > 0);
}

/** One item's staged cards, gathered so the panel can head them with a total instead of repeating a name. */
export interface ScanGroup {
  key: string;
  itemName: string;
  lines: ScanLine[];
  /** Units entered across the group so far. */
  staged: number;
  /** The most the group may move — the kit line's need or its outstanding, split across its hires. */
  cap: number;
}

/**
 * Gather staged cards by KIT LINE, first-scanned first.
 *
 * Only a fanned-out rental ever produces a group bigger than one: an IRM or customer item is a single
 * card per kit line, and a job's kit list cannot hold the same item at the same warehouse twice. So
 * this is the multi-hire case and nothing else, which is why the panel can head a group of >1 with
 * "N hires" without checking the source.
 */
export function groupLines(lines: ScanLine[], isIssue: boolean): ScanGroup[] {
  const out: ScanGroup[] = [];
  const byKey = new Map<string, ScanGroup>();
  for (const l of lines) {
    const key = l.match.jobKitLineId ?? lineKey(l.match);
    let g = byKey.get(key);
    if (!g) {
      g = { key, itemName: l.match.itemName, lines: [], staged: 0, cap: 0 };
      byKey.set(key, g);
      out.push(g);
    }
    g.lines.push(l);
    g.staged += isIssue ? l.qty : l.goodQty + l.damagedQty;
    g.cap += capOf(l.match, isIssue);
  }
  return out;
}

/**
 * Whether a group of this size arrives folded away.
 *
 * Below the threshold the cards ARE the clearest presentation — each names its hire and its deadline,
 * and the operator sees the whole line without touching anything. Past it the repetition becomes the
 * problem: six cards all reading "Fibre Tester" look like a bug rather than a breakdown, and the Post
 * button ends up somewhere below the fold. Folded, the group is one line with a total, and opening it
 * gets the same cards back.
 */
export const COLLAPSE_ABOVE = 3;

export function collapsesByDefault(size: number): boolean {
  return size > COLLAPSE_ABOVE;
}

export function stageScan(prev: ScanLine[], staged: ScanMatch[], isIssue: boolean, now: number): ScanLine[] {
  const next = [...prev];
  staged.forEach((m, i) => {
    const at = next.findIndex((l) => lineKey(l.match) === lineKey(m));
    if (at < 0) {
      next.push({ key: `${lineKey(m)}-${now}-${i}`, match: m, qty: 0, goodQty: 0, damagedQty: 0 });
      return;
    }
    // ALREADY STAGED — take the newer answer rather than keeping the one from the first scan.
    //
    // Cards sit staged far longer now that one scan fans a line across its hires, and the world moves
    // underneath them: another warehouse issues off the same hire, the engineer hands units back at
    // another depot, a deadline passes. A re-scan is the operator asking again, so it has to bring the
    // answer with it — a stale cap does not fail politely, it 409s the POST and takes down every other
    // line in the movement with it.
    //
    // Quantities are clamped to the newer cap, DAMAGE FIRST: those units carry a photograph and a
    // written reason, so the good portion is what gives way.
    const l = next[at];
    const cap = capOf(m, isIssue);
    const damagedQty = clamp(l.damagedQty, 0, cap);
    next[at] = {
      ...l,
      match: m,
      qty: clamp(l.qty, 0, cap),
      goodQty: clamp(l.goodQty, 0, cap - damagedQty),
      damagedQty,
    };
  });
  for (const m of staged) {
    const i = next.findIndex((l) => lineKey(l.match) === lineKey(m));
    const l = next[i];
    const cap = capOf(l.match, isIssue);
    if ((isIssue ? l.qty : l.goodQty + l.damagedQty) >= cap) continue;
    next[i] = isIssue
      ? { ...l, qty: clamp(l.qty + 1, 1, cap) }
      : // Keep good + damaged ≤ held.
        { ...l, goodQty: clamp(l.goodQty + 1, 0, cap - l.damagedQty) };
    break;
  }
  return next;
}
