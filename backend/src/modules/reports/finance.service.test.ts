import { beforeEach, describe, expect, it, vi } from "vitest";

// The repository is stubbed so these tests are about the ARITHMETIC and the ATTRIBUTION rules — the
// two things that decide whether a finance report is right. Query shape is covered separately.
const repo = vi.hoisted(() => ({
  findFinancePoHeaders: vi.fn(),
  findFinanceLines: vi.fn(),
  findFinanceRentalLines: vi.fn(),
  findJobProjects: vi.fn(),
  sumSupplierCharges: vi.fn(),
  countExcluded: vi.fn(),
}));
vi.mock("./finance.repository.js", () => repo);
vi.mock("#modules/settings/settings.service.js", () => ({ getCompanyTimezone: async () => "Europe/London" }));
vi.mock("../../lib/warehouse-access.js", () => ({ warehouseScopeFilter: () => undefined }));

import { getFinanceSummary } from "./finance.service.js";
import { UNATTRIBUTED_PROJECT_KEY, UNATTRIBUTED_PROJECT_LABEL } from "./reports.constants.js";

const NOW = new Date("2026-09-15T10:00:00.000Z");
const ACTOR = { id: "u1", type: "user" as const, email: "fd@x.co", permissions: ["*"] };

const po = (over: Record<string, unknown> = {}) => ({
  id: "po1",
  code: "PO-0001",
  status: "sent",
  orderDate: new Date("2026-09-04T00:00:00.000Z"),
  supplierId: "sup1",
  supplierName: "Acme Ltd",
  warehouseId: "wh1",
  jobId: null,
  ...over,
});

const line = (over: Record<string, unknown> = {}) => ({
  purchaseOrderId: "po1",
  irmItemId: "irm1",
  itemName: "SFP-LX",
  sku: "IRM-SFP-LX",
  quantity: 10,
  receivedQuantity: 0,
  unitPricePence: 5000,
  vatRate: 20,
  lineTotalPence: 50000,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repo.findFinancePoHeaders.mockResolvedValue([po()]);
  repo.findFinanceLines.mockResolvedValue([line()]);
  repo.findFinanceRentalLines.mockResolvedValue([]);
  repo.findJobProjects.mockResolvedValue(new Map());
  repo.sumSupplierCharges.mockResolvedValue({ damagePence: 0, damageLines: 0, lossPence: 0, lossLines: 0 });
  repo.countExcluded.mockResolvedValue({ draft: 0, cancelled: 0 });
});

describe("IRM spend comes from PO LINES, never the header", () => {
  it("sums lineTotalPence and derives VAT per line", async () => {
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.totals).toEqual({ netPence: 50_000, vatPence: 10_000, grossPence: 60_000 });
  });

  // The trap this whole module was built around: PurchaseOrder.grandTotalPence is fed
  // [...lineRows, ...rentalItems] by computeTotals, so an order carrying hire has a header total
  // LARGER than its IRM value. A report reading the header would over-state IRM by the hire value.
  it("EXCLUDES rental lines from IRM totals on a mixed PO", async () => {
    repo.findFinanceRentalLines.mockResolvedValue([
      { purchaseOrderId: "po1", rentalItemId: "r1", itemName: "Tester", quantity: 1, lineTotalPence: 90_000, vatRate: 20, extensionChargePence: 0 },
    ]);
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.totals.netPence).toBe(50_000); // NOT 140_000
    expect(s.rental.hireNetPence).toBe(90_000);
  });

  it("reports a rental-only PO as zero IRM spend, not as spend", async () => {
    repo.findFinanceLines.mockResolvedValue([]);
    repo.findFinanceRentalLines.mockResolvedValue([
      { purchaseOrderId: "po1", rentalItemId: "r1", itemName: "Tester", quantity: 1, lineTotalPence: 90_000, vatRate: 20, extensionChargePence: 0 },
    ]);
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.totals.netPence).toBe(0);
    expect(s.rental.hireNetPence).toBe(90_000);
    // The order still counts as a purchase order — it exists and was raised.
    expect(s.tracking.poCount).toBe(1);
  });
});

describe("VAT rounds PER LINE, matching computeTotals exactly", () => {
  // The invariant: Σ round(line) must be used, NOT round(Σ line). With three lines of 3.33 at 20%
  // the two differ, which is precisely how an export stops reconciling to the purchase orders.
  it("differs from bucket-rounding, and takes the per-line answer", async () => {
    repo.findFinanceLines.mockResolvedValue([
      line({ lineTotalPence: 333, vatRate: 20 }),
      line({ lineTotalPence: 333, vatRate: 20 }),
      line({ lineTotalPence: 333, vatRate: 20 }),
    ]);
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    // per line: round(66.6) = 67, ×3 = 201.   bucket: round(999 × 0.2) = round(199.8) = 200.
    expect(s.totals.vatPence).toBe(201);
    expect(s.totals.vatPence).not.toBe(200);
  });

  it("ties out to a PO's own stored header VAT for an IRM-only order", async () => {
    // Mirrors computeTotals over the same lines — this is the tie-out that keeps the report
    // reconcilable against the purchase order document.
    const lines = [line({ lineTotalPence: 12_345, vatRate: 20 }), line({ lineTotalPence: 6_789, vatRate: 5 })];
    repo.findFinanceLines.mockResolvedValue(lines);
    const headerVat = lines.reduce((n, l) => n + Math.round((l.lineTotalPence * l.vatRate) / 100), 0);
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.totals.vatPence).toBe(headerVat);
  });
});

describe("PO tracking — ordered vs received", () => {
  it("values received from the live receivedQuantity on the line", async () => {
    repo.findFinanceLines.mockResolvedValue([line({ quantity: 10, receivedQuantity: 4, unitPricePence: 5000 })]);
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.tracking.orderedPence).toBe(50_000);
    expect(s.tracking.receivedPence).toBe(20_000);
    expect(s.tracking.outstandingPence).toBe(30_000);
    expect(s.tracking.partiallyReceivedLines).toBe(1);
  });

  it("a fully received line leaves nothing outstanding and is not 'partial'", async () => {
    repo.findFinanceLines.mockResolvedValue([line({ quantity: 10, receivedQuantity: 10 })]);
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.tracking.outstandingPence).toBe(0);
    expect(s.tracking.partiallyReceivedLines).toBe(0);
  });

  // Both readings of "PO raised" are visible: the headline counts the full committed lifecycle, and
  // the not-yet-issued slice is reported beside it so the narrower reading is one subtraction away.
  it("reports approved-but-not-sent separately without removing it from the headline", async () => {
    repo.findFinancePoHeaders.mockResolvedValue([po(), po({ id: "po2", code: "PO-0002", status: "approved" })]);
    repo.findFinanceLines.mockResolvedValue([line(), line({ purchaseOrderId: "po2", lineTotalPence: 10_000 })]);
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.totals.netPence).toBe(60_000);
    expect(s.tracking.preIssuePoCount).toBe(1);
    expect(s.tracking.preIssueNetPence).toBe(10_000);
  });
});

describe("project attribution — job→project, and never projectRef", () => {
  it("groups under the project when the PO names a job", async () => {
    repo.findFinancePoHeaders.mockResolvedValue([po({ jobId: "job1" })]);
    repo.findJobProjects.mockResolvedValue(
      new Map([["job1", { jobId: "job1", jobNumber: "JOB-2026-0001", projectId: "prj1", projectName: "BT Core Migration" }]]),
    );
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.byProject).toHaveLength(1);
    expect(s.byProject[0]).toMatchObject({ key: "prj1", label: "BT Core Migration", netPence: 50_000 });
  });

  // A replenishment PO has no job at all (reorder-generated PRFs carry none). Its spend is real and
  // must be visible — dropping it would make the project breakdown disagree with the headline total.
  it("puts a PO with no job in Unattributed rather than dropping it", async () => {
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.byProject[0]).toMatchObject({ key: UNATTRIBUTED_PROJECT_KEY, label: UNATTRIBUTED_PROJECT_LABEL });
    expect(s.byProject[0]!.netPence).toBe(s.totals.netPence);
  });

  it("project rows always sum back to the headline total", async () => {
    repo.findFinancePoHeaders.mockResolvedValue([po({ jobId: "job1" }), po({ id: "po2", code: "PO-0002" })]);
    repo.findFinanceLines.mockResolvedValue([line(), line({ purchaseOrderId: "po2", lineTotalPence: 25_000 })]);
    repo.findJobProjects.mockResolvedValue(
      new Map([["job1", { jobId: "job1", jobNumber: "J1", projectId: "prj1", projectName: "P1" }]]),
    );
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.byProject.reduce((n, r) => n + r.netPence, 0)).toBe(s.totals.netPence);
    expect(s.byProject.map((r) => r.key).sort()).toEqual([UNATTRIBUTED_PROJECT_KEY, "prj1"].sort());
  });

  // projectRef is unnormalised free text — "Fibre Rollout" / "fibre rollout" / "FR-2026" would be
  // three projects to a GROUP BY. The service must never read it, whatever a header carries.
  it("ignores projectRef entirely", async () => {
    repo.findFinancePoHeaders.mockResolvedValue([po({ projectRef: "Fibre Rollout" } as never)]);
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.byProject.map((r) => r.label)).toEqual([UNATTRIBUTED_PROJECT_LABEL]);
  });
});

describe("aggregation integrity", () => {
  // A PO with 5 lines is ONE purchase order. Counting it per line would inflate every "POs" column.
  it("counts a multi-line PO once per breakdown row", async () => {
    repo.findFinanceLines.mockResolvedValue([line(), line({ irmItemId: "irm2", itemName: "Cable" }), line({ irmItemId: "irm3", itemName: "Patch" })]);
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.bySupplier).toHaveLength(1);
    expect(s.bySupplier[0]).toMatchObject({ poCount: 1, lineCount: 3 });
    expect(s.byItem).toHaveLength(3);
  });

  it("supplier and item breakdowns each sum to the headline total", async () => {
    repo.findFinancePoHeaders.mockResolvedValue([po(), po({ id: "po2", supplierId: "sup2", supplierName: "Beta" })]);
    repo.findFinanceLines.mockResolvedValue([line(), line({ purchaseOrderId: "po2", irmItemId: "irm2", lineTotalPence: 30_000 })]);
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.bySupplier.reduce((n, r) => n + r.netPence, 0)).toBe(s.totals.netPence);
    expect(s.byItem.reduce((n, r) => n + r.netPence, 0)).toBe(s.totals.netPence);
  });

  it("returns zeroed totals rather than throwing when nothing matches", async () => {
    repo.findFinancePoHeaders.mockResolvedValue([]);
    repo.findFinanceLines.mockResolvedValue([]);
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.totals).toEqual({ netPence: 0, vatPence: 0, grossPence: 0 });
    expect(s.bySupplier).toEqual([]);
    expect(s.trend.points.every((p) => p.netPence === 0)).toBe(true);
  });
});

describe("the reporting basis is stated, not assumed", () => {
  it("echoes the statuses counted and the ones excluded", async () => {
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.basis.excluded).toEqual(["draft", "cancelled"]);
    expect(s.basis.statuses).not.toContain("draft");
    expect(s.basis.statuses).not.toContain("cancelled");
    expect(s.basis.dateField).toBe("orderDate");
  });

  // Excluded orders are surfaced as context. A headline that silently omits £40k of cancelled orders
  // with no acknowledgement anywhere is how a finance reader loses trust in the report.
  it("reports draft and cancelled counts as context", async () => {
    repo.countExcluded.mockResolvedValue({ draft: 3, cancelled: 2 });
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.excluded).toEqual({ draftPoCount: 3, cancelledPoCount: 2 });
  });
});

describe("rental money stays out of IRM spend", () => {
  it("keeps hire, extensions and damage as three separate figures", async () => {
    repo.findFinanceRentalLines.mockResolvedValue([
      { purchaseOrderId: "po1", rentalItemId: "r1", itemName: "Tester", quantity: 1, lineTotalPence: 40_000, vatRate: 20, extensionChargePence: 5_000 },
    ]);
    repo.sumSupplierCharges.mockResolvedValue({ damagePence: 1_500, damageLines: 2, lossPence: 0, lossLines: 0 });
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.rental).toEqual({
      hireNetPence: 40_000,
      hireVatPence: 8_000,
      hireLineCount: 1,
      extensionChargePence: 5_000,
      damageChargePence: 1_500,
      damageChargeLines: 2,
      lossChargePence: 0,
      lossChargeLines: 0,
    });
    // None of it reaches the IRM figure.
    expect(s.totals.netPence).toBe(50_000);
  });
});

// ── Supplier DAMAGE and LOSS charges are different financial events ────────────────────────────
//
// Both write `damageChargePence` (the column predates the loss direction), so a report that did not
// split on the note's own direction would state that a missing tester was merely broken — the exact
// conflation the rental module keeps two note directions to avoid. This was a real defect: the first
// Finance build summed the column with no direction filter and labelled the whole thing "damage".
describe("damage and loss charges are reported separately", () => {
  it("keeps them as two figures, and out of IRM spend entirely", async () => {
    repo.sumSupplierCharges.mockResolvedValue({ damagePence: 1_500, damageLines: 2, lossPence: 42_000, lossLines: 1 });
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.rental.damageChargePence).toBe(1_500);
    expect(s.rental.damageChargeLines).toBe(2);
    expect(s.rental.lossChargePence).toBe(42_000);
    expect(s.rental.lossChargeLines).toBe(1);
    // Neither reaches the IRM headline, and neither is folded into the other.
    expect(s.totals.netPence).toBe(50_000);
    expect(s.rental.damageChargePence).not.toBe(s.rental.damageChargePence + s.rental.lossChargePence);
  });

  // A period whose only supplier charge is a replacement cost must not report a damage figure — the
  // two answer different questions and a reader acts on them differently.
  it("a loss-only period reports zero damage", async () => {
    repo.sumSupplierCharges.mockResolvedValue({ damagePence: 0, damageLines: 0, lossPence: 42_000, lossLines: 1 });
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.rental.damageChargePence).toBe(0);
    expect(s.rental.lossChargePence).toBe(42_000);
  });
});

// ── Every figure on the page is measured over the SAME set of orders ───────────────────────────
//
// `sumSupplierCharges` and `countExcluded` took only the date range. Every other read took the range
// AND the caller's warehouse/supplier scope, so the damage, loss and excluded-order figures were
// company-wide while the money beside them was narrowed — two answers to different questions,
// presented as one report, with nothing on screen to say they disagreed.
describe("scoping reaches every figure, not just the money", () => {
  it("passes the caller's scope to the supplier-charge and excluded reads", async () => {
    await getFinanceSummary(ACTOR, { period: "month", supplierId: "sup9" }, NOW);

    const scope = { warehouseIds: undefined, supplierId: "sup9" };
    expect(repo.findFinancePoHeaders).toHaveBeenCalledWith(expect.anything(), scope);
    expect(repo.sumSupplierCharges, "damage/loss must be narrowed like the spend beside it").toHaveBeenCalledWith(
      expect.anything(),
      scope,
    );
    expect(repo.countExcluded, "'12 drafts excluded' is only true of the same orders").toHaveBeenCalledWith(
      expect.anything(),
      scope,
    );
  });

  // The scope every read receives must be one object, not three that happen to agree today.
  it("gives all three reads the identical scope", async () => {
    await getFinanceSummary(ACTOR, { period: "month", supplierId: "sup9" }, NOW);
    const [, headerScope] = repo.findFinancePoHeaders.mock.calls[0]!;
    expect(repo.sumSupplierCharges.mock.calls[0]![1]).toEqual(headerScope);
    expect(repo.countExcluded.mock.calls[0]![1]).toEqual(headerScope);
  });
});

// ── A capped breakdown still has to add up ────────────────────────────────────────────────────
//
// A year by item runs to thousands of rows — more than a screen shows or a reader uses. Dropping the
// tail would leave a table whose column no longer totals to the headline above it, and reconciling
// those two figures is the first thing a finance reader does. So the remainder is FOLDED into one
// row: the total still ties, and the collapse is visible on the page.
describe("breakdown row cap folds the tail rather than dropping it", () => {
  const manySuppliers = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      po({ id: `po${i}`, code: `PO-${i}`, supplierId: `sup${i}`, supplierName: `Supplier ${i}` }),
    );

  beforeEach(() => {
    repo.findFinancePoHeaders.mockResolvedValue(manySuppliers(10));
    repo.findFinanceLines.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) =>
        line({ purchaseOrderId: `po${i}`, quantity: 1, unitPricePence: 100 * (i + 1), lineTotalPence: 100 * (i + 1) }),
      ),
    );
  });

  it("returns every row when no limit is asked for — the export path", async () => {
    const s = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    expect(s.bySupplier).toHaveLength(10);
  });

  it("folds the tail into one row whose money ties back to the uncapped total", async () => {
    const full = await getFinanceSummary(ACTOR, { period: "month" }, NOW);
    const capped = await getFinanceSummary(ACTOR, { period: "month", breakdownLimit: 3 }, NOW);

    // Three real rows plus the fold.
    expect(capped.bySupplier).toHaveLength(4);
    const sum = (rows: { netPence: number }[]) => rows.reduce((t, r) => t + r.netPence, 0);
    expect(sum(capped.bySupplier)).toBe(sum(full.bySupplier));
    expect(sum(capped.bySupplier)).toBe(capped.totals.netPence);
  });

  it("names the fold so a reader knows detail was collapsed, not lost", async () => {
    const s = await getFinanceSummary(ACTOR, { period: "month", breakdownLimit: 3 }, NOW);
    const fold = s.bySupplier.at(-1)!;
    expect(fold.key).toBe("__other__");
    expect(fold.label).toBe("7 more");
    expect(fold.sublabel).toMatch(/included in the totals/i);
  });

  // THE reason the fold happens at bucket level, before `poIds` becomes a count.
  //
  // On by-item a single order appears in every bucket it has a line in, so each of those buckets
  // reports `poCount: 1`. Summing them would say ONE order was six. The fold unions the id sets
  // instead, so it reports the distinct orders behind the collapsed rows.
  it("counts DISTINCT orders in the fold, not once per bucket it appears in", async () => {
    // One order, six different items — six buckets, all naming the same order.
    repo.findFinancePoHeaders.mockResolvedValue([po({ id: "poX", code: "PO-X" })]);
    repo.findFinanceLines.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) =>
        line({
          purchaseOrderId: "poX",
          irmItemId: `irm${i}`,
          itemName: `Item ${i}`,
          quantity: 1,
          unitPricePence: 100 * (i + 1),
          lineTotalPence: 100 * (i + 1),
        }),
      ),
    );

    const s = await getFinanceSummary(ACTOR, { period: "month", breakdownLimit: 2 }, NOW);
    const fold = s.byItem.at(-1)!;
    expect(fold.key).toBe("__other__");
    expect(fold.label).toBe("4 more");
    // Four folded buckets, each carrying poCount 1 — summing gives 4, the union gives the truth.
    expect(fold.poCount).toBe(1);
  });

  it("leaves a breakdown shorter than the limit completely untouched", async () => {
    const s = await getFinanceSummary(ACTOR, { period: "month", breakdownLimit: 50 }, NOW);
    expect(s.bySupplier).toHaveLength(10);
    expect(s.bySupplier.some((r) => r.key === "__other__")).toBe(false);
  });
});
