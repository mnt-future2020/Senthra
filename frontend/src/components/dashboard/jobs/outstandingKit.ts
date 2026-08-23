import type { JobKitLine } from "@/types/job";

// What the engineer is STILL holding for this job — the thing a planner needs to know before they
// cancel it.
//
// Cancelling moves no stock: the engineer keeps whatever is in their van, and the job drops into
// "Awaiting return" until it is scanned back in or written off. Nothing about the cancel dialog said
// so, so a job could be cancelled with a full kit out and no hint that anything was left to settle.
//
// `remaining` is the server's own figure (issued − used − returned, capped at the engineer's real
// holding), so this can't drift from what the kit table and Goods Management show.
//
// MISC lines are excluded: free-text lines are never stock-tracked, can't be scanned back and can't be
// written off, so counting them would inflate the warning with units nobody can return.
export interface OutstandingKit {
  units: number; // total units still out
  items: number; // how many kit lines they span
}

export function outstandingKit(kitLines: JobKitLine[]): OutstandingKit {
  const out = kitLines.filter((l) => l.lineType !== "misc" && l.remaining > 0);
  return { units: out.reduce((n, l) => n + l.remaining, 0), items: out.length };
}

// One sentence for the cancel dialog. Returns null when there is nothing out, so the caller renders no
// advisory at all rather than a reassuring "0 units" line.
//
// Non-blocking on purpose: cancelling is a business decision that happens on a phone call, while the
// return is a physical trip that happens days later. Blocking the cancel until the van arrives would
// leave the job live on the engineer's list, still reserving warehouse stock — and unclosable when the
// engineer is unreachable, on leave, or has left. So this informs; it never stops.
export function outstandingKitWarning(kitLines: JobKitLine[], engineerName: string | null): string | null {
  const { units, items } = outstandingKit(kitLines);
  if (units === 0) return null;
  const who = engineerName?.trim() || "The engineer";
  const what = `${units} unit${units === 1 ? "" : "s"}${items > 1 ? ` across ${items} items` : ""}`;
  // "or written off" is true of owned stock and FALSE of a hire: hired equipment is the provider's,
  // so an unreturned unit is a liability to settle with them, not a loss we can absorb. The reconcile
  // refuses to write one off, so offering it here as an option would describe an escape that does not
  // exist — and the sentence exists precisely to tell a planner what settling this job will take.
  const hired = kitLines.filter((l) => l.lineType === "rental" && l.remaining > 0);
  if (hired.length > 0) {
    const hiredUnits = hired.reduce((n, l) => n + l.remaining, 0);
    return (
      `${who} is still holding ${what}, including ${hiredUnits} rental unit${hiredUnits === 1 ? "" : "s"}. ` +
      `Cancelling doesn't return them. Rental items must be scanned back to the warehouse — they can't be written off, ` +
      `because they aren't ours to lose.`
    );
  }
  return `${who} is still holding ${what}. Cancelling doesn't return them — they must be scanned back in or written off.`;
}
