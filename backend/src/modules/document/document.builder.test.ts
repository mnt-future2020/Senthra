import { describe, expect, it } from "vitest";

import type { PurchaseOrderWithRelations } from "#modules/purchase-order/purchase-order.repository.js";
import { buildPurchaseOrderDocument } from "./document.builder.js";
import type { DocumentContext } from "./document.types.js";

function ctx(over: Partial<DocumentContext> = {}): DocumentContext {
  return {
    company: {
      legalName: "Electra Networks Ltd",
      registrationNumber: "01234567",
      vatNumber: "GB123456789",
      addressLines: ["Unit 4", "Bracknell"],
      phone: "+44 1344 000000",
      email: "po@electra.co",
      website: "https://electra.co",
      logoUrl: "",
    },
    people: {},
    regional: { timezone: "Europe/London", dateFormat: "DD/MM/YYYY", timeFormat: "24h" },
    branding: { brandName: "Senthra", brandColor: "#7b6ef0" },
    signature: null,
    logo: null,
    meta: {
      documentId: "po1",
      documentCode: "PO-0001",
      documentType: "purchase_order",
      generatedAt: new Date("2026-06-19T00:00:00Z"),
      generatedBy: "ops@x.com",
    },
    ...over,
  };
}

function po(over: Record<string, unknown> = {}): PurchaseOrderWithRelations {
  return {
    id: "po1",
    code: "PO-0001",
    currency: "GBP",
    status: "sent",
    priority: "high",
    supplierName: "Acme",
    referenceNumber: "REF-9",
    orderDate: new Date("2026-06-01T00:00:00Z"),
    expectedDeliveryDate: new Date("2026-06-10T00:00:00Z"),
    deliveryAddress: null,
    deliveryInstructions: "Call ahead; forklift required.",
    deliveryTerms: "DDP",
    paymentTerms: "30 Days",
    subtotalPence: 7000,
    vatPence: 1400,
    grandTotalPence: 8400,
    supplierNotes: "Deliver to the rear gate.",
    createdBy: "finance@electra.co",
    approvedBy: "director@electra.co",
    projectRef: "PROJ-77",
    jobId: null,
    job: null,
    supplier: {
      name: "Acme Ltd",
      contactPerson: "Dana",
      contactEmail: "sales@acme.co",
      contactPhone: "0800 000",
      paymentTerms: "30 Days",
      customPaymentTerms: null,
      addressLine1: "5 Trade Park",
      addressLine2: null,
      city: "Leeds",
      county: "West Yorkshire",
      postcode: "LS1 1AB",
      country: "United Kingdom",
    },
    warehouse: {
      name: "Leeds DC",
      addressLine1: "1 Depot Rd",
      addressLine2: null,
      city: "Leeds",
      county: null,
      postcode: "LS2 2BB",
      country: "United Kingdom",
    },
    items: [
      { itemName: "CAT6 Cable", sku: "C6", baseUnit: "Each", notes: "Reel", quantity: 10, unitPricePence: 500, vatRate: 20, lineTotalPence: 5000 },
      { itemName: "RJ45", sku: null, baseUnit: null, notes: null, quantity: 2, unitPricePence: 1000, vatRate: 20, lineTotalPence: 2000 },
    ],
    // Present and empty by default: the repository's include always supplies it. Hire lines have
    // their own tests below.
    rentalItems: [],
    ...over,
  } as unknown as PurchaseOrderWithRelations;
}

describe("buildPurchaseOrderDocument", () => {
  it("maps the company header + order meta", () => {
    const d = buildPurchaseOrderDocument(po(), ctx());
    expect(d.company.legalName).toBe("Electra Networks Ltd");
    expect(d.order).toMatchObject({
      code: "PO-0001",
      status: "Sent",
      priority: "High",
      orderDate: "01/06/2026",
      expectedDeliveryDate: "10/06/2026",
      reference: "REF-9",
      currency: "GBP",
    });
  });

  it("maps supplier + delivery (warehouse address fallback)", () => {
    const d = buildPurchaseOrderDocument(po(), ctx());
    expect(d.supplier.name).toBe("Acme Ltd");
    expect(d.supplier.addressLines).toEqual(["5 Trade Park", "Leeds", "West Yorkshire", "LS1 1AB", "United Kingdom"]);
    expect(d.delivery.name).toBe("Leeds DC");
    expect(d.delivery.addressLines).toEqual(["1 Depot Rd", "Leeds", "LS2 2BB", "United Kingdom"]);
  });

  it("uses an explicit deliveryAddress override when present", () => {
    const d = buildPurchaseOrderDocument(po({ deliveryAddress: "Site B\nUnit 9" }), ctx());
    expect(d.delivery.addressLines).toEqual(["Site B", "Unit 9"]);
  });

  it("formats lines + totals as currency", () => {
    const d = buildPurchaseOrderDocument(po(), ctx());
    expect(d.lines).toHaveLength(2);
    expect(d.lines[0]).toMatchObject({
      name: "CAT6 Cable",
      description: "C6 · Reel",
      quantity: "10 Each",
      unitPrice: "£5.00",
      vatRate: "20%",
      lineTotal: "£50.00",
    });
    expect(d.lines[1].quantity).toBe("2");
    expect(d.totals).toEqual({ subtotal: "£70.00", vat: "£14.00", vatLabel: "VAT (20%)", grandTotal: "£84.00" });
  });

  it("falls back to brandName when legalName is blank", () => {
    const blank = ctx();
    blank.company.legalName = "";
    const d = buildPurchaseOrderDocument(po(), blank);
    expect(d.company.legalName).toBe("Senthra");
  });

  it("carries the signature block + document metadata through", () => {
    const d = buildPurchaseOrderDocument(
      po(),
      ctx({ signature: { signerName: "Ava Stone", jobTitle: "Buyer", image: null, mimeType: null } }),
    );
    expect(d.signature?.signerName).toBe("Ava Stone");
    expect(d.meta.documentCode).toBe("PO-0001");
    expect(d.meta.documentType).toBe("purchase_order");
  });

  // Client's official PO must carry: Project, Delivery Terms (Incoterm), Payment Terms,
  // Prepared By, Approved By — plus the practical delivery instructions.
  it("maps terms + accountability + project reference", () => {
    const d = buildPurchaseOrderDocument(po(), ctx());
    expect(d.order.project).toBe("PROJ-77"); // free-text projectRef when no job linked
    expect(d.terms).toEqual({
      delivery: "DDP — Delivered Duty Paid", // Incoterm code resolved to its label
      deliveryInstructions: "Call ahead; forklift required.",
      payment: "30 Days", // the PO's own paymentTerms
      preparedBy: "finance@electra.co",
      approvedBy: "director@electra.co",
    });
  });

  it("prefers the PO's own paymentTerms over the supplier default", () => {
    const d = buildPurchaseOrderDocument(
      po({ paymentTerms: "60 Days", supplier: { ...po().supplier, paymentTerms: "30 Days" } }),
      ctx(),
    );
    expect(d.terms.payment).toBe("60 Days");
  });

  it("prefers the linked job (code — name) over free-text projectRef", () => {
    const d = buildPurchaseOrderDocument(
      po({ job: { jobNumber: "JOB-2026-0001", name: "Fibre rollout" }, projectRef: "IGNORED" }),
      ctx(),
    );
    expect(d.order.project).toBe("JOB-2026-0001 — Fibre rollout");
  });

  it("falls back to the supplier's Custom payment terms when the PO has none", () => {
    const d = buildPurchaseOrderDocument(
      po({ paymentTerms: null, supplier: { ...po().supplier, paymentTerms: "Custom", customPaymentTerms: "50% up front, 50% on delivery" } }),
      ctx(),
    );
    expect(d.terms.payment).toBe("50% up front, 50% on delivery");
  });

  it("leaves terms/project empty (not undefined) when unset — renderer omits blank rows", () => {
    const d = buildPurchaseOrderDocument(
      po({
        deliveryInstructions: null,
        deliveryTerms: null,
        paymentTerms: null,
        createdBy: null,
        approvedBy: null,
        projectRef: null,
        job: null,
        supplier: { ...po().supplier, paymentTerms: null, customPaymentTerms: null },
      }),
      ctx(),
    );
    expect(d.order.project).toBe("");
    expect(d.terms).toEqual({ delivery: "", deliveryInstructions: "", payment: "", preparedBy: "", approvedBy: "" });
  });
});

// Prepared By / Approved By are stored as the actor's EMAIL. Printing a raw login on a document
// that leaves the building names nobody the supplier can ask for — it should carry the person.
describe("buildPurchaseOrderDocument — accountability names", () => {
  it("prints the person's name for Prepared By / Approved By", () => {
    const d = buildPurchaseOrderDocument(
      po(),
      ctx({
        people: {
          "finance@electra.co": { name: "Ava Stone", jobTitle: "Buyer" },
          "director@electra.co": { name: "Ravi Kumar", jobTitle: "Operations Director" },
        },
      }),
    );
    // The POSITION is what evidences authority to commit this spend — that is why it is here.
    expect(d.terms.preparedBy).toBe("Ava Stone — Buyer");
    expect(d.terms.approvedBy).toBe("Ravi Kumar — Operations Director");
  });

  // A deleted or externally-invited actor has no user row. The email is worse than a name and far
  // better than a blank accountability row on an official order.
  it("falls back to the email when the person can't be resolved", () => {
    const d = buildPurchaseOrderDocument(
      po(),
      ctx({ people: { "finance@electra.co": { name: "Ava Stone", jobTitle: null } } }),
    );
    expect(d.terms.preparedBy).toBe("Ava Stone");
    expect(d.terms.approvedBy).toBe("director@electra.co");
  });

  it("matches the actor regardless of the case the email was recorded in", () => {
    const d = buildPurchaseOrderDocument(
      po({ createdBy: "Finance@Electra.co" }),
      ctx({ people: { "finance@electra.co": { name: "Ava Stone", jobTitle: null } } }),
    );
    expect(d.terms.preparedBy).toBe("Ava Stone");
  });

  // Most users never set a job title. A dangling separator would look like broken output.
  it("prints the bare name when the person has no job title", () => {
    const d = buildPurchaseOrderDocument(
      po(),
      ctx({ people: { "finance@electra.co": { name: "Ava Stone", jobTitle: null } } }),
    );
    expect(d.terms.preparedBy).toBe("Ava Stone");
  });
});

// Every line carries its own vatRate and the document showed one lump VAT figure with no rate. On
// a mixed-rate order (20% goods + a 0% line) the supplier cannot reconcile the total it is billed.
describe("buildPurchaseOrderDocument — VAT", () => {
  it("carries each line's VAT rate", () => {
    const d = buildPurchaseOrderDocument(
      po({ items: [{ ...po().items[0], vatRate: 20 }, { ...po().items[1], vatRate: 0 }] }),
      ctx(),
    );
    expect(d.lines[0]!.vatRate).toBe("20%");
    expect(d.lines[1]!.vatRate).toBe("0%");
  });

  it("drops a trailing zero from a fractional rate", () => {
    const d = buildPurchaseOrderDocument(po({ items: [{ ...po().items[0], vatRate: 12.5 }] }), ctx());
    expect(d.lines[0]!.vatRate).toBe("12.5%");
  });

  it("labels the VAT total with the rate when every line shares one", () => {
    const d = buildPurchaseOrderDocument(
      po({ items: [{ ...po().items[0], vatRate: 20 }, { ...po().items[1], vatRate: 20 }] }),
      ctx(),
    );
    expect(d.totals.vatLabel).toBe("VAT (20%)");
  });

  it("leaves the VAT total unqualified when the rates differ", () => {
    const d = buildPurchaseOrderDocument(
      po({ items: [{ ...po().items[0], vatRate: 20 }, { ...po().items[1], vatRate: 0 }] }),
      ctx(),
    );
    expect(d.totals.vatLabel).toBe("VAT");
  });

  it("counts hire lines when deciding whether the order has a single rate", () => {
    const d = buildPurchaseOrderDocument(
      po({
        items: [{ ...po().items[0], vatRate: 20 }, { ...po().items[1], vatRate: 20 }],
        rentalItems: [
          {
            itemName: "Fibre Tester",
            baseUnit: "Each",
            notes: null,
            quantity: 1,
            hireStartDate: new Date("2026-09-01T00:00:00Z"),
            hireEndDate: new Date("2026-10-01T00:00:00Z"),
            deliveryAddress: null,
            returnMode: "delivery",
            returnAddress: null,
            unitPricePence: 15000,
            lineTotalPence: 15000,
            vatRate: 0,
          },
        ],
      }),
      ctx(),
    );
    expect(d.totals.vatLabel).toBe("VAT");
    expect(d.lines[2]!.vatRate).toBe("0%");
  });

  it("labels a zero-rated order with its rate rather than hiding it", () => {
    const d = buildPurchaseOrderDocument(
      po({ items: [{ ...po().items[0], vatRate: 0 }, { ...po().items[1], vatRate: 0 }] }),
      ctx(),
    );
    expect(d.totals.vatLabel).toBe("VAT (0%)");
  });

  it("leaves the VAT total unqualified when the order has no lines at all", () => {
    const d = buildPurchaseOrderDocument(po({ items: [], rentalItems: [] }), ctx());
    expect(d.totals.vatLabel).toBe("VAT");
  });
});


// A hire is real spend on the order, and this document is what the supplier reads and what is
// archived. Building it from `items` alone printed an empty table under a non-zero total.
describe("buildPurchaseOrderDocument — rental lines", () => {
  const hire = {
    itemName: "Fibre Tester",
    baseUnit: "Each",
    notes: "Calibrated",
    quantity: 2,
    hireStartDate: new Date("2026-09-01T00:00:00Z"),
    hireEndDate: new Date("2026-10-01T00:00:00Z"),
    deliveryAddress: null,
    returnMode: "delivery",
    returnAddress: null,
    unitPricePence: 15000,
    lineTotalPence: 30000,
  };

  it("prints hire lines after the item lines", () => {
    const d = buildPurchaseOrderDocument(po({ rentalItems: [hire] }), ctx());
    expect(d.lines).toHaveLength(3);
    expect(d.lines[2]).toMatchObject({ name: "Fibre Tester", quantity: "2 Each", lineTotal: "£300.00" });
  });

  // There is no column for a hire period, and the supplier has to know what they are providing.
  it("puts the hire period in the description", () => {
    const d = buildPurchaseOrderDocument(po({ rentalItems: [hire] }), ctx());
    expect(d.lines[2]!.description).toContain("Hire 01/09/2026 – 01/10/2026");
    expect(d.lines[2]!.description).toContain("Calibrated");
  });

  // A hire date is a calendar day stored as UTC midnight. Rendered in a zone behind UTC it would
  // print the previous day and name a period the supplier never agreed to.
  it("renders hire dates in UTC, not the company timezone", () => {
    const d = buildPurchaseOrderDocument(
      po({ rentalItems: [hire] }),
      ctx({ regional: { dateFormat: "DD/MM/YYYY", timeFormat: "24h", timezone: "America/New_York" } }),
    );
    expect(d.lines[2]!.description).toContain("01/09/2026");
  });

  it("shows a line-level delivery address when the hire has one", () => {
    const d = buildPurchaseOrderDocument(po({ rentalItems: [{ ...hire, deliveryAddress: "Unit 4\nLeeds" }] }), ctx());
    expect(d.lines[2]!.description).toContain("Deliver to: Unit 4, Leeds");
  });

  // THE return leg. The order used to name where to deliver and say nothing at all about who
  // collects it from where at the end, so that got settled by phone — differently each time.
  it("always states where the hire is collected from", () => {
    const d = buildPurchaseOrderDocument(po({ rentalItems: [hire] }), ctx());
    expect(d.lines[2]!.description).toContain("Collection at end of hire:");
  });

  it("sends it back to the line's own delivery address by default", () => {
    const d = buildPurchaseOrderDocument(po({ rentalItems: [{ ...hire, deliveryAddress: "Unit 4\nLeeds" }] }), ctx());
    expect(d.lines[2]!.description).toContain("Collection at end of hire: Unit 4, Leeds");
  });

  it("names the warehouse address in warehouse mode, even when the line was delivered elsewhere", () => {
    const d = buildPurchaseOrderDocument(
      po({ rentalItems: [{ ...hire, deliveryAddress: "Unit 4\nLeeds", returnMode: "warehouse" }] }),
      ctx(),
    );
    expect(d.lines[2]!.description).toMatch(/Collection at end of hire: .*Leeds/);
    expect(d.lines[2]!.description).toContain("Deliver to: Unit 4, Leeds");
  });

  it("uses the typed address in other mode", () => {
    const d = buildPurchaseOrderDocument(
      po({ rentalItems: [{ ...hire, returnMode: "other", returnAddress: "Yard 7\nLeeds LS9 9ZZ" }] }),
      ctx(),
    );
    expect(d.lines[2]!.description).toContain("Collection at end of hire: Yard 7, Leeds LS9 9ZZ");
  });

  it("prints a hire-only order's lines rather than an empty table", () => {
    const d = buildPurchaseOrderDocument(po({ items: [], rentalItems: [hire] }), ctx());
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]!.name).toBe("Fibre Tester");
  });
});
