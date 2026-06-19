// Document Platform — Purchase Order builder. PURE: maps a loaded PurchaseOrder (with relations)
// + the resolved DocumentContext into the render-agnostic PurchaseOrderDocumentData. No I/O — all
// settings/signature/logo are already resolved on the context. Future document types add their own
// build*Document here and reuse the same context + formatters.

import type { PurchaseOrderWithRelations } from "#modules/purchase-order/purchase-order.repository.js";
import { formatDate, formatMoney } from "./document.formatter.js";
import { joinAddressLines } from "./document.utils.js";
import type { DocumentContext, PurchaseOrderDocumentData } from "./document.types.js";

const titleCase = (s: string): string =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function buildPurchaseOrderDocument(
  po: PurchaseOrderWithRelations,
  ctx: DocumentContext,
): PurchaseOrderDocumentData {
  const { regional } = ctx;
  const currency = po.currency || "GBP";
  const s = po.supplier;
  const wh = po.warehouse;

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
    },
    lines: po.items.map((i) => ({
      name: i.itemName,
      description: [i.sku, i.notes].filter(Boolean).join(" · "),
      quantity: `${i.quantity}${i.baseUnit ? ` ${i.baseUnit}` : ""}`,
      unitPrice: formatMoney(i.unitPricePence, currency),
      lineTotal: formatMoney(i.lineTotalPence, currency),
    })),
    totals: {
      subtotal: formatMoney(po.subtotalPence, currency),
      vat: formatMoney(po.vatPence, currency),
      grandTotal: formatMoney(po.grandTotalPence, currency),
    },
    notes: po.supplierNotes?.trim() ?? "",
  };
}
