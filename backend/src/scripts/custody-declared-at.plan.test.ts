import { describe, expect, it } from "vitest";

import { planDeclaredAtRepairs } from "./custody-declared-at.plan.js";

const LINE = "e".repeat(24);
/** The afternoon the exits backfill ran: every row it wrote carries this instant as its date. */
const MIGRATION = new Date("2026-08-24T08:32:39.438Z");

const exit = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  purchaseOrderRentalLineId: LINE,
  poCode: "PO-0072",
  itemName: "Fibre tester",
  sourceType: "backfill_field_damage",
  sourceId: LINE,
  declaredAt: MIGRATION,
  ...over,
});

describe("planDeclaredAtRepairs: damage a migration dated to its own run", () => {
  it("takes the date from the return that reported the damage", async () => {
    const found = new Date("2026-08-23T20:28:50.123Z");
    const { repairs } = planDeclaredAtRepairs([exit()], [{ purchaseOrderRentalLineId: LINE, createdAt: found }], []);
    expect(repairs).toEqual([expect.objectContaining({ id: "a1", from: MIGRATION, to: found })]);
  });

  it("takes the EARLIEST such return, which is the date the hire line itself claims", () => {
    const first = new Date("2026-08-23T20:28:50.123Z");
    const second = new Date("2026-08-23T21:09:25.178Z");
    const { repairs } = planDeclaredAtRepairs(
      [exit()],
      [
        { purchaseOrderRentalLineId: LINE, createdAt: second },
        { purchaseOrderRentalLineId: LINE, createdAt: first },
      ],
      [],
    );
    expect(repairs[0]!.to).toEqual(first);
  });

  it("ignores returns from AFTER the migration, which have records of their own", () => {
    // A later scan opened its own correctly-dated row. Dating the migrated row from it would move a
    // year of history onto last Tuesday.
    const later = new Date("2026-08-25T11:08:29.790Z");
    const { repairs, unexplained } = planDeclaredAtRepairs([exit()], [{ purchaseOrderRentalLineId: LINE, createdAt: later }], []);
    expect(repairs).toEqual([]);
    expect(unexplained.map((r) => r.id)).toEqual(["a1"]);
  });

  it("leaves a row alone rather than guessing when nothing evidences it", () => {
    const { repairs, unexplained } = planDeclaredAtRepairs([exit()], [], []);
    expect(repairs).toEqual([]);
    expect(unexplained).toHaveLength(1);
  });

  it("never reads evidence belonging to a different hire", () => {
    const { repairs } = planDeclaredAtRepairs(
      [exit()],
      [{ purchaseOrderRentalLineId: "f".repeat(24), createdAt: new Date("2026-08-23T20:28:50.123Z") }],
      [],
    );
    expect(repairs).toEqual([]);
  });
});

describe("planDeclaredAtRepairs: damage a migration lifted off a note", () => {
  const note = { id: "n1", deliveryDate: new Date("2026-08-14T00:00:00Z"), createdAt: new Date("2026-08-14T16:05:00Z") };
  const fromNote = (over: Record<string, unknown> = {}) => exit({ sourceType: "warehouse_damage_note", sourceId: "n1", ...over });

  // Rebuilt to be the instant the live path would have written, which is the note's own moment when
  // the note reports the day it was raised on.
  it("takes the note's own moment when the note reports the day it was written", () => {
    const { repairs } = planDeclaredAtRepairs([fromNote()], [], [note]);
    expect(repairs[0]!.to).toEqual(note.createdAt);
  });

  it("anchors at midday when the note reports an EARLIER day than it was written", () => {
    // Nobody recorded a time of day for the 14th, so midday says the date without inventing an hour —
    // and reads as the 14th in every timezone, which UTC midnight would not.
    const late = { ...note, createdAt: new Date("2026-08-20T09:00:00Z") };
    const { repairs } = planDeclaredAtRepairs([fromNote()], [], [late]);
    expect(repairs[0]!.to.toISOString()).toBe("2026-08-14T12:00:00.000Z");
  });

  it("leaves a record written WITH its note exactly where it is", () => {
    // The live path opens the record inside the note's own transaction, so the two are seconds apart
    // and that instant is the truth. Only a record stranded from its note is a migration artefact.
    const live = fromNote({ declaredAt: new Date("2026-08-14T16:05:02Z") });
    const plan = planDeclaredAtRepairs([live], [], [note]);
    expect(plan.repairs).toEqual([]);
    // …and it is not REPORTED either. "Nothing to do here" and "I could not date this" are different
    // answers, and a dry run that prints the first as the second buries the rows a human must look at.
    expect(plan.unexplained).toEqual([]);
  });

  it("leaves a record alone when its note is nowhere to be found", () => {
    const { repairs, unexplained } = planDeclaredAtRepairs([fromNote()], [], []);
    expect(repairs).toEqual([]);
    expect(unexplained).toHaveLength(1);
  });
});

describe("planDeclaredAtRepairs: the rest of the rows", () => {
  it("carries a split onto whatever its parent is corrected to", () => {
    // A split shares its parent's date exactly — that is what makes the pair one report. Repairing
    // one and not the other would break them apart and put two dates on one fault.
    const found = new Date("2026-08-23T20:28:50.123Z");
    const parent = exit({ id: "a1" });
    const slice = exit({ id: "a2", sourceType: "damage_split_0", sourceId: "a1" });
    const { repairs } = planDeclaredAtRepairs([parent, slice], [{ purchaseOrderRentalLineId: LINE, createdAt: found }], []);
    expect(repairs.map((r) => [r.id, r.to.toISOString()])).toEqual([
      ["a1", found.toISOString()],
      ["a2", found.toISOString()],
    ]);
  });

  /**
   * FOUR WRITERS SPLIT A ROW, not one — and the key each stamps is different. Matching only
   * `<kind>_split_N` left two whole families behind: damage that went back with the kit
   * (`damage_custody_split_N`, from reconcileDamageCustodyTx) and units that turned up after being
   * declared gone (`loss_recovery_N`, from recoverHireLoss). Both copy `declaredAt` off their parent,
   * so both sat on the artefact date beside a parent that had just been corrected next to them.
   */
  it.each([
    ["damage_custody_split_0", "damage that went back with the kit"],
    ["loss_recovery_0", "a loss recovered in parts"],
    ["loss_split_2", "a note accepting part of a loss"],
  ])("carries a %s slice onto its parent's corrected date (%s)", (sourceType) => {
    const found = new Date("2026-08-23T20:28:50.123Z");
    const slice = exit({ id: "a2", sourceType, sourceId: "a1" });
    const { repairs } = planDeclaredAtRepairs([exit({ id: "a1" }), slice], [{ purchaseOrderRentalLineId: LINE, createdAt: found }], []);
    expect(repairs.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(repairs[1]!.to.toISOString()).toBe(found.toISOString());
  });

  // A slice can itself be sliced: a note settles part of an engineer's report, and a later collection
  // sends part of THAT back with the kit. One pass repaired the child and left the grandchild holding
  // the artefact date — the same drift, one level down.
  it("follows a chain of splits all the way down", () => {
    const found = new Date("2026-08-23T20:28:50.123Z");
    const rows = [
      exit({ id: "a3", sourceType: "damage_custody_split_0", sourceId: "a2" }),
      exit({ id: "a2", sourceType: "damage_split_0", sourceId: "a1" }),
      exit({ id: "a1" }),
    ];
    const { repairs } = planDeclaredAtRepairs(rows, [{ purchaseOrderRentalLineId: LINE, createdAt: found }], []);
    expect(new Set(repairs.map((r) => r.id))).toEqual(new Set(["a1", "a2", "a3"]));
    for (const r of repairs) expect(r.to.toISOString()).toBe(found.toISOString());
  });

  it("leaves a split whose parent needs no correction", () => {
    const slice = exit({ id: "a2", sourceType: "damage_split_0", sourceId: "a1" });
    expect(planDeclaredAtRepairs([exit({ id: "a1", sourceType: "goods_management_return" }), slice], [], []).repairs).toEqual([]);
  });

  it("never touches a record whose date was always its own", () => {
    // A return scan and a loss declaration ARE the declaration — their `now()` is the fact.
    const rows = [
      exit({ id: "a1", sourceType: "goods_management_return", sourceId: "m1" }),
      exit({ id: "a2", sourceType: "reconcile_loss", sourceId: "t1" }),
    ];
    expect(planDeclaredAtRepairs(rows, [{ purchaseOrderRentalLineId: LINE, createdAt: new Date("2026-08-01T00:00:00Z") }], []).repairs).toEqual([]);
  });

  it("plans nothing on a second run, having already moved the dates", () => {
    const found = new Date("2026-08-23T20:28:50.123Z");
    const sightings = [{ purchaseOrderRentalLineId: LINE, createdAt: found }];
    const repaired = exit({ declaredAt: found });
    expect(planDeclaredAtRepairs([repaired], sightings, []).repairs).toEqual([]);
    expect(planDeclaredAtRepairs([repaired], sightings, []).unexplained).toEqual([]);
  });
});
