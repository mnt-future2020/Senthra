// Document Platform — Purchase Order builder. PURE: maps a loaded PurchaseOrder (with relations)
// + the resolved DocumentContext into the render-agnostic PurchaseOrderDocumentData. No I/O — all
// settings/signature/logo are already resolved on the context. Future document types add their own
// build*Document here and reuse the same context + formatters.

import type { PurchaseOrderWithRelations } from "#modules/purchase-order/purchase-order.repository.js";
import { incotermLabel } from "#modules/purchase-order/purchase-order.validation.js";
import { formatDate, formatMoney } from "./document.formatter.js";
import { joinAddressLines } from "./document.utils.js";
import { returnLocationLine } from "#modules/purchase-order/rentalReturn.js";
import { billablePeriods, rateBasisLabel, type RatePeriod } from "../../utils/rental-pricing.js";
import type { DocumentPerson } from "#modules/user/user.service.js";
import type { DocumentContext, PurchaseOrderDocumentData } from "./document.types.js";

const titleCase = (s: string): string =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// A VAT rate as the supplier reads it: "20%", "0%", "12.5%" — never "20.00%".
const formatVatRate = (rate: number | null | undefined): string => `${Number((rate ?? 0).toFixed(2))}%`;

// An actor column stores the person's LOGIN. Print who they are — "Ava Stone — Buyer". The POSITION
// is the point on an Approved By line: it is what evidences the authority to commit this spend.
// Bare name when they have no job title on file (most users don't) — a dangling separator reads as
// broken output. Falls back to the email for an actor we can't resolve at all (a deleted user, an
// external invite): they must still leave an accountability trail, and a blank row is worse.
const personName = (email: string | null | undefined, people: Record<string, DocumentPerson>): string => {
  const e = email?.trim() ?? "";
  if (!e) return "";
  const person = people[e.toLowerCase()];
  if (!person) return e;
  return person.jobTitle ? `${person.name} — ${person.jobTitle}` : person.name;
};

// "VAT (20%)" when EVERY line — goods and hire alike — is at one rate, so the reader can check the
// figure. Null on a mixed-rate or empty order: naming one rate there would misstate the others.
function singleVatRate(po: PurchaseOrderWithRelations): string | null {
  const rates = [...po.items, ...po.rentalItems].map((l) => l.vatRate ?? 0);
  if (rates.length === 0) return null;
  const [first] = rates;
  return rates.every((r) => r === first) ? `VAT (${formatVatRate(first)})` : null;
}

export function buildPurchaseOrderDocument(
  po: PurchaseOrderWithRelations,
  ctx: DocumentContext,
): PurchaseOrderDocumentData {
  const { regional, people } = ctx;
  const currency = po.currency || "GBP";
  const s = po.supplier;
  const wh = po.warehouse;

  // Project reference: prefer the linked job (code + name), else the free-text projectRef.
  const project = po.job
    ? [po.job.jobNumber, po.job.name].filter(Boolean).join(" — ")
    : (po.projectRef?.trim() ?? "");

  // Commercial terms come from the PO itself (agreed for THIS order). Payment term falls back to
  // the supplier's default for older POs saved before the field existed; delivery term resolves
  // its Incoterm code to the full human label (e.g. "DDP" → "DDP — Delivered Duty Paid").
  const payment =
    po.paymentTerms?.trim() ||
    (s ? (s.paymentTerms === "Custom" ? (s.customPaymentTerms ?? "") : (s.paymentTerms ?? "")) : "");
  const deliveryTerms = po.deliveryTerms ? incotermLabel(po.deliveryTerms) : "";

  return {
    meta: ctx.meta,
    // legalName falls back to the brand name so the letterhead is never blank.
    company: { ...ctx.company, legalName: ctx.company.legalName || ctx.branding.brandName },
    branding: ctx.branding,
    logo: ctx.logo,
    signature: ctx.signature,
    supplier: {
      name: s?.name ?? po.supplierName ?? "",
      contactPerson: s?.contactPerson ?? "",
      addressLines: joinAddressLines([
        s?.addressLine1,
        s?.addressLine2,
        s?.city,
        s?.county,
        s?.postcode,
        s?.country,
      ]),
      email: s?.contactEmail ?? "",
      phone: s?.contactPhone ?? "",
    },
    delivery: {
      name: wh?.name ?? "",
      // An explicit delivery-address override wins; otherwise the destination warehouse's address.
      addressLines: po.deliveryAddress
        ? joinAddressLines(po.deliveryAddress.split(/\r?\n/))
        : joinAddressLines([
            wh?.addressLine1,
            wh?.addressLine2,
            wh?.city,
            wh?.county,
            wh?.postcode,
            wh?.country,
          ]),
    },
    order: {
      code: po.code,
      status: titleCase(po.status ?? "draft"),
      orderDate: formatDate(po.orderDate, regional.dateFormat, regional.timezone),
      expectedDeliveryDate: formatDate(po.expectedDeliveryDate, regional.dateFormat, regional.timezone),
      reference: po.referenceNumber ?? "",
      currency,
      priority: titleCase(po.priority ?? "normal"),
      project,
    },
    terms: {
      // "Delivery Terms" = the Incoterm (commercial). The practical delivery note
      // (deliveryInstructions) is printed separately under Notes-style content, not as a term.
      delivery: deliveryTerms,
      deliveryInstructions: po.deliveryInstructions?.trim() ?? "",
      payment: payment.trim(),
      // The PERSON, not their login — see personName().
      preparedBy: personName(po.createdBy, people),
      approvedBy: personName(po.approvedBy, people),
    },
    // BOTH kinds of line. This document is what is emailed to the supplier and archived, so a
    // hire-only order printing an empty table under a non-zero total is the worst version of this
    // bug: the total is right and nothing explains it.
    //
    // A hire's period belongs in the description — it is what the supplier is being asked to
    // provide, and there is no column for it. Dates render in UTC because a hire date is a calendar
    // day stored as UTC midnight; the company timezone would shift it a day for zones behind UTC.
    lines: [
      ...po.items.map((i) => ({
        name: i.itemName,
        description: [i.sku, i.notes].filter(Boolean).join(" · "),
        quantity: `${i.quantity}${i.baseUnit ? ` ${i.baseUnit}` : ""}`,
        unitPrice: formatMoney(i.unitPricePence, currency),
        vatRate: formatVatRate(i.vatRate),
        lineTotal: formatMoney(i.lineTotalPence, currency),
      })),
      ...po.rentalItems.map((r) => ({
        name: r.itemName,
        description: [
          `Hire ${formatDate(r.hireStartDate, regional.dateFormat, "UTC")} – ${formatDate(r.hireEndDate, regional.dateFormat, "UTC")}`,
          // The BASIS the price was struck on, so the supplier can check the figure against the rate
          // they quoted rather than taking a lump sum on trust. Nothing is printed for a lump sum:
          // the unit-price column already is that number.
          r.ratePeriod && r.ratePeriod !== "total" && r.ratePence != null
            ? `${formatMoney(r.ratePence, currency)}/${r.ratePeriod} ${rateBasisLabel(r.ratePeriod as RatePeriod, billablePeriods(r.ratePeriod as RatePeriod, r.hireStartDate, r.hireEndDate))}`
            : null,
          r.deliveryAddress ? `Deliver to: ${r.deliveryAddress.replace(/\r?\n/g, ", ")}` : null,
          // The return leg, on the document the supplier actually reads. The order used to name
          // where to deliver and say nothing about collection, so that got settled by phone.
          returnLocationLine({
            returnMode: r.returnMode,
            returnAddress: r.returnAddress,
            deliveryAddress: r.deliveryAddress,
            orderDeliveryAddress: po.deliveryAddress,
            warehouseName: wh?.name ?? null,
            warehouseAddress:
              joinAddressLines([wh?.addressLine1, wh?.addressLine2, wh?.city, wh?.county, wh?.postcode, wh?.country]).join(", ") || null,
          }),
          r.notes,
        ]
          .filter(Boolean)
          .join(" · "),
        quantity: `${r.quantity}${r.baseUnit ? ` ${r.baseUnit}` : ""}`,
        unitPrice: formatMoney(r.unitPricePence, currency),
        vatRate: formatVatRate(r.vatRate),
        lineTotal: formatMoney(r.lineTotalPence, currency),
      })),
    ],
    totals: {
      subtotal: formatMoney(po.subtotalPence, currency),
      vat: formatMoney(po.vatPence, currency),
      vatLabel: singleVatRate(po) ?? "VAT",
      grandTotal: formatMoney(po.grandTotalPence, currency),
    },
    notes: po.supplierNotes?.trim() ?? "",
  };
}
