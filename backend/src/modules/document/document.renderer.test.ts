import { describe, expect, it } from "vitest";

import { pdfPageCount, pdfTextRuns, type PdfTextRun } from "./document.pdfText.testkit.js";
import { renderPurchaseOrderPdf, signatureBlockHeight } from "./document.renderer.js";
import type { DocumentRegional, PoDocLine, PurchaseOrderDocumentData } from "./document.types.js";

const find = (runs: PdfTextRun[], text: string): PdfTextRun | undefined => runs.find((r) => r.text === text);

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────
const regional: DocumentRegional = { timezone: "Europe/London", dateFormat: "DD/MM/YYYY", timeFormat: "24h" };

const line = (over: Partial<PoDocLine> = {}): PoDocLine => ({
  name: "CAT6 Cable",
  description: "C6",
  quantity: "10 Each",
  unitPrice: "5.00",
  vatRate: "20%",
  lineTotal: "50.00",
  ...over,
});

function data(over: Partial<PurchaseOrderDocumentData> = {}): PurchaseOrderDocumentData {
  return {
    meta: {
      documentId: "po1",
      documentCode: "PO-0001",
      documentType: "purchase_order",
      generatedAt: new Date("2026-08-18T04:38:00Z"),
      generatedBy: null,
    },
    company: {
      legalName: "Electra Networks Ltd",
      registrationNumber: "01234567",
      vatNumber: "GB123456789",
      addressLines: ["1 Way", "Bracknell", "RG12 1NF"],
      phone: "+44 1344 000000",
      email: "po@electra.co",
      website: "",
      logoUrl: "",
    },
    branding: { brandName: "Senthra", brandColor: "#7b6ef0" },
    logo: null,
    signature: null,
    supplier: {
      name: "Acme Ltd",
      contactPerson: "Dana",
      addressLines: ["5 Trade Park", "Leeds"],
      email: "sales@acme.co",
      phone: "0800 000",
    },
    delivery: { name: "Leeds DC", addressLines: ["1 Depot Rd", "Leeds"] },
    order: {
      code: "PO-0001",
      status: "Sent",
      orderDate: "18/08/2026",
      expectedDeliveryDate: "19/08/2026",
      reference: "",
      currency: "GBP",
      priority: "Normal",
      project: "PROJ-010",
    },
    terms: {
      delivery: "DDP - Delivered Duty Paid",
      deliveryInstructions: "",
      payment: "30 Days",
      preparedBy: "Ava Stone",
      approvedBy: "Ravi Kumar",
    },
    lines: [line()],
    totals: { subtotal: "1.00", vat: "0.20", vatLabel: "VAT (20%)", grandTotal: "1.20" },
    notes: "",
    ...over,
  };
}

describe("renderPurchaseOrderPdf — order meta block", () => {
  // A job-linked PO's project reference is "JOBNUM — Job name", which is far wider than the meta
  // column. The rows below it were drawn on a fixed 14pt pitch regardless of how many lines the
  // value actually took, so a wrapped project printed ON TOP of Currency and Priority.
  it("keeps the rows below a wrapped project reference clear of it", async () => {
    const buf = await renderPurchaseOrderPdf(
      data({ order: { ...data().order, project: "JOB-2026-0001 - Fibre rollout phase 2, Leeds city centre" } }),
      regional,
    );
    const runs = pdfTextRuns(buf);

    const currency = find(runs, "GBP");
    expect(currency).toBeDefined();
    // Every run that belongs to the wrapped project value: the meta column, above the currency row.
    const projectLines = runs.filter((r) => r.x > 400 && /Fibre|rollout|centre|JOB-2026/.test(r.text));
    expect(projectLines.length).toBeGreaterThan(1); // it really did wrap

    // PDF y grows upward, so "below" means a smaller y. The lowest line of the project value must
    // still sit above the currency row, with a full line of clearance.
    const lowestProjectLine = Math.min(...projectLines.map((r) => r.y));
    expect(currency!.y).toBeLessThanOrEqual(lowestProjectLine - 9);
  });

  it("leaves the meta rows on their default pitch when nothing wraps", async () => {
    const buf = await renderPurchaseOrderPdf(data(), regional);
    const runs = pdfTextRuns(buf);
    const project = find(runs, "PROJ-010");
    const currency = find(runs, "GBP");
    expect(project).toBeDefined();
    expect(currency).toBeDefined();
    expect(project!.y - currency!.y).toBeCloseTo(14, 1);
  });
});

describe("renderPurchaseOrderPdf — totals pagination", () => {
  // 34 lines used to land the totals block exactly at the page boundary: VAT printed on top of the
  // page footer, "Grand Total" was orphaned alone onto its own page, and a fully blank page
  // followed. drawTerms/drawSignature had a page-break guard; drawTotals never did.
  it("keeps the totals block whole when it lands on a page boundary", async () => {
    const buf = await renderPurchaseOrderPdf(data({ lines: Array.from({ length: 34 }, () => line()) }), regional);
    const runs = pdfTextRuns(buf);

    const subtotal = find(runs, "Subtotal");
    const grand = runs.find((r) => r.text.startsWith("Grand"));
    expect(subtotal).toBeDefined();
    expect(grand).toBeDefined();
    expect(grand!.page).toBe(subtotal!.page);
  });

  it("never draws content over the page footer", async () => {
    const buf = await renderPurchaseOrderPdf(data({ lines: Array.from({ length: 34 }, () => line()) }), regional);
    const runs = pdfTextRuns(buf);
    // The footer band: its rule sits at y=68 and its two runs (company line, document meta) sit at
    // y≈56. Nothing else may reach it — content drawn into the bottom margin is exactly what
    // printed VAT on top of the footer and spawned the blank pages.
    const isFooter = (r: PdfTextRun) => r.text.includes("Page ") || r.text.startsWith("Electra Networks Ltd   ");
    expect(runs.filter(isFooter).every((r) => r.y < 68)).toBe(true);
    expect(runs.filter((r) => r.y < 68 && !isFooter(r))).toEqual([]);
  });

  it("emits no blank pages", async () => {
    const buf = await renderPurchaseOrderPdf(data({ lines: Array.from({ length: 34 }, () => line()) }), regional);
    const runs = pdfTextRuns(buf);
    // A page carrying nothing but its own footer is a blank page to the reader.
    for (let p = 1; p <= pdfPageCount(buf); p++) {
      const body = runs.filter((r) => r.page === p && r.y > 68);
      expect(body.length, `page ${p} has no content above the footer`).toBeGreaterThan(0);
    }
  });
});

describe("renderPurchaseOrderPdf — supplier notes", () => {
  // The note is the LAST body block, so it lands wherever the terms above it ended — and an
  // ordinary 8-line order with a note put it straight through the page footer. drawNotes had no
  // page-break guard, so it wrote into the bottom margin like the totals block did.
  it("moves a note that would land on the footer to the next page", async () => {
    const buf = await renderPurchaseOrderPdf(
      data({
        lines: Array.from({ length: 8 }, () => line()),
        notes: "Please book in with the goods-in team 24 hours before delivery, quoting the PO number on the paperwork.",
      }),
      regional,
    );
    const runs = pdfTextRuns(buf);
    const isFooter = (r: PdfTextRun) => r.text.includes("Page ") || r.text.startsWith("Electra Networks Ltd   ");
    expect(runs.filter((r) => r.y < 68 && !isFooter(r))).toEqual([]);
    expect(runs.some((r) => r.text.startsWith("Please book in"))).toBe(true); // and it is still printed
  });
});

describe("renderPurchaseOrderPdf — VAT", () => {
  it("prints a VAT column with each line's rate", async () => {
    const buf = await renderPurchaseOrderPdf(
      data({ lines: [line({ vatRate: "20%" }), line({ vatRate: "0%" })] }),
      regional,
    );
    const runs = pdfTextRuns(buf);
    // The column header, plus one cell per line — so a supplier can reconcile the VAT total.
    const header = runs.find((r) => r.text === "VAT" && r.y > 400);
    expect(header).toBeDefined();
    expect(find(runs, "20%")).toBeDefined();
    expect(find(runs, "0%")).toBeDefined();
  });

  it("labels the VAT total with the rate the builder resolved", async () => {
    const buf = await renderPurchaseOrderPdf(data(), regional);
    const runs = pdfTextRuns(buf);
    expect(runs.some((r) => r.text.startsWith("VAT (20%)"))).toBe(true);
  });
});

describe("renderPurchaseOrderPdf — the signature block", () => {
  // Most issuers never upload a signature graphic, so the slot for one is usually empty. Reserving
  // it anyway printed 46pt of blank paper between "AUTHORISED BY" and the rule — which reads as a
  // MISSING signature on a document the supplier receives, and on an order whose content already
  // ran near the foot of the page it pushed the whole block onto a second sheet carrying nothing
  // else. The space is now reserved only when there is something to put in it.
  it("reserves the graphic's slot only when there is a graphic", () => {
    expect(signatureBlockHeight(false)).toBeLessThan(signatureBlockHeight(true));
    expect(signatureBlockHeight(true) - signatureBlockHeight(false)).toBe(42);
  });

  it("makes room for a job title under the name", () => {
    expect(signatureBlockHeight(false, true)).toBeGreaterThan(signatureBlockHeight(false, false));
  });

  // The order that showed this up: three hire lines whose collection addresses wrap, so the terms
  // block ends ~75pt above the footer. That is not enough for the block WITH its image slot, and
  // ample without it.
  const nearFoot = () =>
    data({
      signature: { signerName: "Ava Stone", jobTitle: null, image: null, mimeType: null },
      lines: Array.from({ length: 3 }, (_, i) =>
        line({
          name: `test fiber net ${i + 1}`,
          description:
            "Hire 19/08/2026 - 20/08/2026 · £3.00/week × 1 week · Collection at end of hire: " +
            "3/359, AYYANAR NAGAR, Y. OTHAKKADAI, PALLIVASAL BACKSIDE, GDFGDFGHDFHDFH, Leeds, " +
            "Tamil Nadu, LS1 4DY, United Kingdom · notes just test",
        }),
      ),
    });

  // Measured on the page rather than by counting pages: how far the signer's name sits BELOW the
  // label is exactly the reserved slot, and it is the void the supplier sees. (Page count depends on
  // where the content above happens to end — an order finishing 10pt from the footer pushes any
  // block over, which is correct.)
  it("leaves no reserved void between the label and the name", async () => {
    const runs = pdfTextRuns(
      await renderPurchaseOrderPdf(
        data({ signature: { signerName: "Ava Stone", jobTitle: null, image: null, mimeType: null } }),
        regional,
      ),
    );
    const label = find(runs, "AUTHORISED BY");
    const name = find(runs, "Ava Stone");
    expect(label).toBeDefined();
    expect(name).toBeDefined();
    // PDF y grows upward, so the drop is label − name. One label, a rule and a line of text — the
    // 42pt graphic slot on top of that is what made it read as a missing signature.
    expect(label!.y - name!.y).toBeLessThan(30);
  });

  it("still reserves the room when there IS a graphic to draw", () => {
    expect(signatureBlockHeight(true)).toBeGreaterThan(signatureBlockHeight(false) + 40);
  });

  // Still never allowed to sit on the footer, whichever page it lands on.
  it("stays clear of the page footer", async () => {
    const runs = pdfTextRuns(await renderPurchaseOrderPdf(nearFoot(), regional));
    const isFooter = (r: PdfTextRun) => r.text.includes("Page ") || r.text.startsWith("Electra Networks Ltd   ");
    expect(runs.filter((r) => r.y < 68 && !isFooter(r))).toEqual([]);
  });
});
