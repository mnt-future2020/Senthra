import { describe, expect, it } from "vitest";

import { hireHistory, searchDamagedRows, toDamagedRows } from "./DamagedStockView";
import type { HireCustodyExit } from "@/types/rental";

const exit = (over: Partial<HireCustodyExit> = {}): HireCustodyExit => ({
  id: "x1",
  purchaseOrderRentalLineId: "l1",
  purchaseOrderId: "p1",
  poCode: "PO-0073",
  warehouseId: "w1",
  kind: "damage",
  qty: 2,
  itemName: "Fibre Tester",
  custodyState: "held_damaged",
  settlementState: "unsettled",
  reason: "Screen cracked on site",
  notes: null,
  photoUrl: "https://x/1.jpg",
  jobId: "j1",
  jobNumber: "JOB-2026-0041",
  engineerId: "e1",
  engineerName: "Kansha M",
  declaredBy: "wm@x.co",
  declaredAt: "2026-08-24T00:00:00.000Z",
  settledByReceiptId: null,
  settledAt: null,
  recoveredBy: null,
  recoveredAt: null,
  recoveryNotes: null,
  settledByCode: null,
  settledCharge: null,
  settledNotedAt: null,
  attachments: [],
  attachmentsReceiptId: null,
  sourceReceiptId: null,
  sourceCode: null,
  ...over,
});

// The adapter that puts hired damage in the SAME list as owned damage. The failure it fixes was two
// separate tables: a manager looking for the tester an engineer brought back broken opened this tab,
// saw only owned stock, and concluded nothing was wrong.
describe("toDamagedRow", () => {
  it("marks the row as rental so the table can say who owns it", () => {
    // The distinction has to survive into the row — the owned pool can be written off and restored, a
    // hire cannot, and the actions branch on exactly this.
    expect(toDamagedRows([exit()])[0]!.ownerType).toBe("rental");
  });

  it("carries the job, the engineer and the order the charge is settled on", () => {
    expect(toDamagedRows([exit()])[0]!).toMatchObject({
      jobNumber: "JOB-2026-0041",
      engineerName: "Kansha M",
      poCode: "PO-0073",
      quantity: 2,
      photoUrl: "https://x/1.jpg",
    });
  });

  it("prints a loss reason as words, not as the stored key", () => {
    const row = toDamagedRows([exit({ kind: "loss", reason: "site_theft" })])[0]!;
    expect(row.reason).toBe("Stolen from site or van");
  });

  it("shows the ITEM in the item column, like every owned row beside it", () => {
    // It used to print the EVENT there — "Damaged on hire" — because the record had no item name to
    // give. Two different facts in one column, which reads as a bug even when the numbers are right.
    expect(toDamagedRows([exit()])[0]!.itemName).toBe("Fibre Tester");
    expect(toDamagedRows([exit({ kind: "loss" })])[0]!.itemName).toBe("Fibre Tester");
  });

  it("says WHAT happened separately from what it was", () => {
    expect(toDamagedRows([exit({ kind: "loss" })])[0]!.exitKind).toBe("loss");
    expect(toDamagedRows([exit({ kind: "damage" })])[0]!.exitKind).toBe("damage");
  });

  it("leaves a damage reason exactly as the engineer typed it", () => {
    expect(toDamagedRows([exit({ reason: "Screen cracked on site" })])[0]!.reason).toBe("Screen cracked on site");
  });

  it("never claims an owned-stock identity", () => {
    // A rental row carrying an irmItemId would be picked up by the owned-pool actions — restore to
    // usable on somebody else's equipment, which has nowhere to restore it to.
    const row = toDamagedRows([exit()])[0]!;
    expect(row.irmItemId).toBeNull();
    expect(row.customerStockEntryId).toBeNull();
    expect(row.customerId).toBeNull();
  });
});

// ── The History drill-down ─────────────────────────────────────────────────────────────────────
//
// Every row in this list gets one History button asking one question. Owned stock answers it from the
// damaged-stock ledger; a hire has no row in that ledger by design and answers from its own custody
// record. Same modal, different source — sending only rental rows off to another page made one row in
// the list behave unlike all the others.
describe("hireHistory", () => {
  const row = {
    id: "x1",
    warehouseId: "w1",
    warehouseName: null,
    ownerType: "rental" as const,
    irmItemId: null,
    customerStockEntryId: null,
    customerId: null,
    itemName: "Fibre Tester",
    quantity: 1,
    updatedAt: "2026-08-24T00:00:00.000Z",
    reason: null,
    photoUrl: null,
  };

  it("keeps the modal's own shape so it renders unchanged", () => {
    const h = hireHistory(row, [exit()]);
    expect(h).toMatchObject({ ownerType: "rental", itemName: "Fibre Tester", truncated: false });
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]).toMatchObject({ date: "2026-08-24T00:00:00.000Z", photoUrl: "https://x/1.jpg", actor: "wm@x.co" });
  });

  it("folds the context a reader needs months later into the notes line", () => {
    const [entry] = hireHistory(row, [exit()]).entries;
    // NOT the kind — the modal's own badge says that, and repeating it wasted the one line that
    // carries what nothing else does.
    expect(entry!.notes).not.toContain("Damaged while on hire");
    expect(entry!.notes).toContain("JOB-2026-0041");
    expect(entry!.notes).toContain("Kansha M");
  });

  // The money question is the one an accountant reads this for, and it used to be appended to `notes`
  // as prose. It is now a VALUE — the same fact, but one the modal can colour, count and exclude from
  // the running total, none of which a sentence inside a free-text line can be asked to do.
  it("carries where the record stands as a status, not as prose in the notes", () => {
    const [entry] = hireHistory(row, [exit()]).entries;
    expect(entry!.status).toBe("active");
    // Not said twice: the badge renders the status, so repeating it in the notes printed one fact in
    // two places on the same entry.
    expect(entry!.notes).not.toContain("not yet charged");
  });

  it("says so when the provider has already been charged", () => {
    const [entry] = hireHistory(row, [exit({ settlementState: "settled" })]).entries;
    expect(entry!.status).toBe("charged");
  });

  it("says so when a lost unit was later found", () => {
    const [entry] = hireHistory(row, [exit({ kind: "loss", reason: "site_theft", custodyState: "recovered", recoveredAt: "2026-09-01T00:00:00.000Z" })]).entries;
    expect(entry!.status).toBe("recovered");
    expect(entry!.reason).toBe("Stolen from site or van");
  });

  /**
   * "Total after this: N" is a claim about the STANDING TALLY, not about the event beside it. Set to
   * the entry's own quantity it made every report agree with itself and none of them agree with the
   * card above: three separate reports of one unit each printed "Total after this: 1" three times,
   * under a heading that said 3.
   */
  it("states the running total, not the entry's own quantity", () => {
    const entries = hireHistory({ ...row, quantity: 3 }, [
      exit({ id: "c", qty: 1, declaredAt: "2026-08-26T00:00:00.000Z" }),
      exit({ id: "b", qty: 1, declaredAt: "2026-08-25T00:00:00.000Z" }),
      exit({ id: "a", qty: 1, declaredAt: "2026-08-24T00:00:00.000Z" }),
    ]).entries;
    // Listed newest-first, as the API returns them — so the totals count DOWN the screen.
    expect(entries.map((e) => [e.id, e.balanceAfter])).toEqual([
      ["c", 3],
      ["b", 2],
      ["a", 1],
    ]);
  });

  // Accumulated oldest-first and read back by id, so the arithmetic cannot depend on the order the
  // list happens to arrive in — and the newest entry always lands on the card's own total.
  it("ends on the same total the card is built from, whatever order it is given", () => {
    const exits = [
      exit({ id: "a", qty: 2, declaredAt: "2026-08-24T00:00:00.000Z" }),
      exit({ id: "c", qty: 1, declaredAt: "2026-08-26T00:00:00.000Z" }),
      exit({ id: "b", qty: 3, declaredAt: "2026-08-25T00:00:00.000Z" }),
    ];
    const byId = new Map(hireHistory({ ...row, quantity: 6 }, exits).entries.map((e) => [e.id, e.balanceAfter]));
    expect([byId.get("a"), byId.get("b"), byId.get("c")]).toEqual([2, 5, 6]);
  });

  it("never reports a restore — a hire has nowhere to be restored to", () => {
    // The owned modal colours a negative delta as units rejoining usable stock. A hire goes back to the
    // provider broken; it does not rejoin anything of ours, and a green line would say it did.
    for (const e of hireHistory(row, [exit(), exit({ kind: "loss" })]).entries) {
      expect(e.type).toBe("write_off");
      expect(e.quantityDelta).toBeGreaterThan(0);
    }
  });
});

// ── One row per problem, not one row per report ────────────────────────────────────────────────
//
// Every other row in this list is a BALANCE — one line per item with a running quantity and the
// individual reports under History. Hired damage was listed event-by-event, so one hire reported three
// times filled three rows carrying the same item and the same words while the customer row beside it
// stayed a single line. Same list, two different meanings of "row".
describe("toDamagedRows — aggregation", () => {
  it("rolls several reports on one hire into a single row with the running total", () => {
    const rows = toDamagedRows([
      exit({ id: "a", qty: 1, declaredAt: "2026-08-01T00:00:00.000Z", reason: "first" }),
      exit({ id: "b", qty: 2, declaredAt: "2026-08-24T00:00:00.000Z", reason: "latest" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quantity: 3, reportCount: 2 });
  });

  it("speaks with the NEWEST report, like an owned balance shows its latest", () => {
    const rows = toDamagedRows([
      exit({ id: "a", declaredAt: "2026-08-01T00:00:00.000Z", reason: "older", photoUrl: "https://x/old.jpg" }),
      exit({ id: "b", declaredAt: "2026-08-24T00:00:00.000Z", reason: "newest", photoUrl: "https://x/new.jpg" }),
    ]);
    expect(rows[0]).toMatchObject({ reason: "newest", photoUrl: "https://x/new.jpg", updatedAt: "2026-08-24T00:00:00.000Z" });
  });

  it("keeps damage and loss on the SAME hire as two rows", () => {
    // One broken unit and one missing one are two different problems with two different exits, and a
    // combined "2" would describe neither.
    const rows = toDamagedRows([exit({ id: "a", kind: "damage" }), exit({ id: "b", kind: "loss" })]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.exitKind).sort()).toEqual(["damage", "loss"]);
  });

  it("keeps two different hires apart even when the item is the same", () => {
    const rows = toDamagedRows([
      exit({ id: "a", purchaseOrderRentalLineId: "l1", poCode: "PO-0054" }),
      exit({ id: "b", purchaseOrderRentalLineId: "l2", poCode: "PO-0073" }),
    ]);
    // Two orders, two providers, two invoices — merging them would put one supplier's damage on
    // another's account.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.poCode).sort()).toEqual(["PO-0054", "PO-0073"]);
  });

  it("keys the row on the hire line so History opens that hire's reports", () => {
    expect(toDamagedRows([exit()])[0]!.hireLineId).toBe("l1");
  });
});

// ── The search reaches a hired row by what identifies it ───────────────────────────────────────
//
// An owned row is found by its item name. A hired row's identity is mostly its CONTEXT — the order it
// sits on, the job it broke on, the engineer who had it — and none of that is in the item name, so
// searching for the thing the reader actually remembers found nothing.
describe("searchDamagedRows over hired rows", () => {
  const rows = [
    { itemName: "Fibre Tester", warehouseName: null, reason: "Screen cracked", poCode: "PO-0073", jobNumber: "JOB-2026-0041", engineerName: "Kansha M" },
    { itemName: "Cat6 Box", warehouseName: "Leeds", reason: "crushed", poCode: null, jobNumber: null, engineerName: null },
  ];

  it("finds a hire by its order code", () => {
    expect(searchDamagedRows(rows, "PO-0073")).toHaveLength(1);
  });

  it("finds a hire by the job it broke on", () => {
    expect(searchDamagedRows(rows, "2026-0041")).toHaveLength(1);
  });

  it("finds a hire by who was holding it", () => {
    expect(searchDamagedRows(rows, "kansha")).toHaveLength(1);
  });

  it("still finds an owned row by item and reason, and costs it nothing", () => {
    expect(searchDamagedRows(rows, "cat6")).toHaveLength(1);
    expect(searchDamagedRows(rows, "crushed")).toHaveLength(1);
  });

  it("returns everything for an empty term", () => {
    expect(searchDamagedRows(rows, "  ")).toHaveLength(2);
  });
});

// ── The pool holds DAMAGE, never loss ──────────────────────────────────────────────────────────
//
// Owned stock draws the line in exactly this place: a damaged unit gets a row in the damaged pool, a
// unit written off as LOST gets none — it becomes an event in the movement ledger instead. Hired kit
// listing its losses beside its damage made one source in this list obey a different rule from the
// other two, which is what a reader notices even when every number is right.
//
// The adapter still handles a loss faithfully, because the same rows feed the hire's own surfaces; what
// changed is that this pane no longer ASKS for them. These pin the shape either way.
describe("a loss is shaped correctly wherever it is asked for", () => {
  it("keeps its own kind rather than being flattened into damage", () => {
    const row = toDamagedRows([exit({ kind: "loss", reason: "site_theft" })])[0]!;
    expect(row.exitKind).toBe("loss");
    // The pool row and the drill-down must agree about which question they are answering — a loss under
    // a "Damage reported" badge was the exact confusion this replaced.
    expect(row.reason).toBe("Stolen from site or van");
  });

  it("never merges a loss into the damage total for the same hire", () => {
    const rows = toDamagedRows([
      exit({ id: "a", kind: "damage", qty: 2 }),
      exit({ id: "b", kind: "loss", qty: 1 }),
    ]);
    const damage = rows.find((r) => r.exitKind === "damage")!;
    const loss = rows.find((r) => r.exitKind === "loss")!;
    expect(damage.quantity).toBe(2);
    expect(loss.quantity).toBe(1);
  });
});
