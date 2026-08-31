import { describe, expect, it } from "vitest";

import { damageReportCap } from "./hireActions";

// ONE RULE: what this report may claim is the ordinary cap MINUS whatever a report already on file is
// holding out of the pool.
//
// A hire line is a count with no unit identity: the custody record carries a quantity and no serial,
// and the supplier's asset tags are stored on the note as evidence text that nothing matches on. So
// "1 damaged" typed on a report and "1 damaged" already open on the same line are the same number and
// two different facts.
//
// The form used to cap against units never TALLIED as damaged, while the service allocated against
// units with an OPEN REPORT — different populations. A genuinely new broken unit fell into the gap:
// absorbed into the older report, so ONE quarantine covered TWO broken units, the second stayed
// issuable and went out to the next engineer, and the provider was told 1 instead of 2.
//
// Subtracting instead of allocating is what let the "same damage or new damage?" question disappear:
// a report here can only mean "more damage was found", and an event already on file is acted on
// through its own record. These mirror reportHireDamage.

const open = (units: number, quarantined = units) => ({ quarantined });

describe("damageReportCap", () => {
  // THE CONTEXT READ IS OPTIONAL, AND THIS IS WHAT MAKES IT SAFE TO BE.
  //
  // Filling `openDamage` costs a `rentals.view` read; filing a damage note does not. A floor role that
  // may report damage but may not read the order's rental history got a 403 on that call, and the form
  // turned it into a page-level error — locking exactly those people out of the one thing they were
  // there to do. Any transient failure did the same.
  //
  // So a missing answer degrades to the ORDINARY cap rather than to no form. That is safe in the only
  // direction that matters: the fallback is never smaller than the true cap, so nothing legitimate is
  // refused, and anything it lets through is refused by the server — which re-reads the real figure
  // inside the note's own transaction and is the authority either way.
  describe("when the already-reported context could not be read", () => {
    it("falls back to the ordinary cap rather than to zero", () => {
      // Zero would be a silent lockout: a form that refuses every line and blames the engineer.
      expect(damageReportCap(4, undefined)).toBe(4);
    });

    it("never invents headroom — the fallback is the remainder and nothing more", () => {
      expect(damageReportCap(0, undefined)).toBe(0);
    });
  });

  it("is the ordinary cap when nothing is already recorded", () => {
    expect(damageReportCap(3, undefined)).toBe(3);
    expect(damageReportCap(3, open(0, 0))).toBe(3);
  });

  it("subtracts what an open report is already holding", () => {
    // 3 damageable, 1 held by the engineer's report → 2 units nobody has reported.
    expect(damageReportCap(3, open(1))).toBe(2);
  });

  it("reaches zero rather than borrowing the open report", () => {
    // One unit on hire, one open report about it. There is no second unit for this report to be about,
    // and the old code answered exactly this case by silently merging.
    expect(damageReportCap(1, open(1))).toBe(0);
  });

  it("counts a DISMISSED report as still holding its unit", () => {
    // Dismissing drops the CLAIM, not the damage: the unit stays quarantined because it is still
    // broken. A fresh event for it would be the same double quarantine through another door.
    expect(damageReportCap(1, { quarantined: 1 })).toBe(0);
    expect(damageReportCap(3, { quarantined: 2 })).toBe(1);
  });

  it("does not care how the held units are split between open and dismissed", () => {
    // Only the physical total matters to this figure — which report they sit on decides who can act on
    // them, not how many more can be reported. The split used to ride along as its own field; nothing
    // read it, and this is the property that says why it was never needed.
    expect(damageReportCap(5, { quarantined: 2 })).toBe(3);
  });

  it("never returns a negative cap, however stale the figures are", () => {
    // A screen left open while the reports moved on must offer nothing, not offer a negative.
    expect(damageReportCap(1, open(5))).toBe(0);
    expect(damageReportCap(0, open(2))).toBe(0);
  });

  it("keeps the units it offers and the units already held from ever overlapping", () => {
    // THE INVARIANT, as arithmetic: what may be claimed plus what is already quarantined never exceeds
    // what the line can physically account for. That is what makes double-quarantining impossible
    // rather than merely unlikely — and it holds without anyone being asked a question.
    for (const remainder of [0, 1, 2, 5, 50]) {
      for (const units of [0, 1, 2]) {
        for (const extra of [0, 1, 3]) {
          const o = { units, quarantined: units + extra };
          expect(damageReportCap(remainder, o) + o.quarantined).toBeLessThanOrEqual(
            Math.max(remainder, o.quarantined),
          );
        }
      }
    }
  });
});
