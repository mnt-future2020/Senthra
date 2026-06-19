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
    subtotalPence: 7000,
    vatPence: 1400,
    grandTotalPence: 8400,
    supplierNotes: "Deliver to the rear gate.",
    supplier: {
      name: "Acme Ltd",
      contactPerson: "Dana",
      contactEmail: "sales@acme.co",
      contactPhone: "0800 000",
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
      { itemName: "CAT6 Cable", sku: "C6", baseUnit: "Each", notes: "Reel", quantity: 10, unitPricePence: 500, lineTotalPence: 5000 },
      { itemName: "RJ45", sku: null, baseUnit: null, notes: null, quantity: 2, unitPricePence: 1000, lineTotalPence: 2000 },
    ],
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
      lineTotal: "£50.00",
    });
    expect(d.lines[1].quantity).toBe("2");
    expect(d.totals).toEqual({ subtotal: "£70.00", vat: "£14.00", grandTotal: "£84.00" });
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
});
