// Document Platform — PDF renderer (pdfkit engine). The ONLY file that knows the PDF library, so a
// future engine swap is contained here. Draws a Purchase Order letterhead from the pure document
// payload via section primitives (header / company / meta / parties / items / totals / notes /
// signature / footer) that future document types reuse. Streams to a Buffer.

import PDFDocument from "pdfkit";

import { safeBrandColor } from "../../utils/email-html.js";
import { COLORS, FONT, PAGE } from "./document.constants.js";
import { formatDateTime } from "./document.formatter.js";
import type {
  DocumentRegional,
  PoDocLine,
  PurchaseOrderDocumentData,
} from "./document.types.js";

type Doc = InstanceType<typeof PDFDocument>;

export function renderPurchaseOrderPdf(
  data: PurchaseOrderDocumentData,
  regional: DocumentRegional,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: PAGE.size,
      margin: PAGE.margin,
      bufferPages: true,
      info: {
        Title: `Purchase Order ${data.order.code}`,
        Author: data.company.legalName || data.branding.brandName,
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawBody(doc, data);
      drawFooters(doc, data, regional);
      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// Pick a legible text colour (near-black or white) for placing on the brand accent.
function readableOn(hex: string): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length < 6) return COLORS.white;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? COLORS.ink : COLORS.white;
}

function drawBody(doc: Doc, data: PurchaseOrderDocumentData): void {
  const accent = safeBrandColor(data.branding.brandColor);
  const M = PAGE.margin;
  const W = doc.page.width - M * 2;

  // ── Header band ──
  doc.rect(0, 0, doc.page.width, PAGE.headerHeight).fill(accent);
  const onAccent = readableOn(accent);
  let drewLogo = false;
  if (data.logo) {
    try {
      doc.image(data.logo, M, 26, { fit: [150, 44] });
      drewLogo = true;
    } catch {
      drewLogo = false;
    }
  }
  if (!drewLogo) {
    doc
      .font("Helvetica-Bold")
      .fontSize(15)
      .fillColor(onAccent)
      .text(data.company.legalName || data.branding.brandName, M, 38, {
        width: W * 0.55,
        lineBreak: false,
      });
  }
  doc
    .font("Helvetica-Bold")
    .fontSize(FONT.title)
    .fillColor(onAccent)
    .text("PURCHASE ORDER", M, 30, { width: W, align: "right" });
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(onAccent)
    .text(data.order.code, M, 30 + FONT.title + 7, { width: W, align: "right" });

  let y = PAGE.headerHeight + 20;

  // ── Company (left) + order meta (right) ──
  const companyBottom = drawCompany(doc, data, M, y, W * 0.54);
  const metaBottom = drawMeta(doc, data, M + W * 0.58, y, W * 0.42);
  y = Math.max(companyBottom, metaBottom) + 16;

  // ── Parties: Supplier + Deliver To ──
  const gap = 16;
  const halfW = (W - gap) / 2;
  const supBottom = drawParty(
    doc,
    "SUPPLIER",
    data.supplier.name,
    data.supplier.addressLines,
    [data.supplier.contactPerson, data.supplier.email, data.supplier.phone],
    M,
    y,
    halfW,
    accent,
  );
  const delBottom = drawParty(
    doc,
    "DELIVER TO",
    data.delivery.name,
    data.delivery.addressLines,
    [],
    M + halfW + gap,
    y,
    halfW,
    accent,
  );
  y = Math.max(supBottom, delBottom) + 18;

  // ── Items / totals / terms / notes / signature ──
  y = drawItemsTable(doc, data.lines, M, y, W, accent) + 14;
  y = drawTotals(doc, data, M, y, W) + 14;
  y = drawTerms(doc, data, M, y, W, accent) + 14;
  if (data.notes) y = drawNotes(doc, data.notes, M, y, W) + 14;
  if (data.signature) drawSignature(doc, data, M, y, W);
}

// Commercial terms + accountability the client's official PO must carry: Delivery Terms, Payment
// Terms, Prepared By, Approved By. Each row is omitted when its value is empty, so the section
// never shows a dangling label — and the whole section is skipped if nothing is set. Two columns
// (label + wrapping value) so long delivery/payment terms wrap instead of truncating.
function drawTerms(doc: Doc, data: PurchaseOrderDocumentData, x: number, y: number, W: number, accent: string): number {
  const t = data.terms;
  const rows: [string, string][] = [];
  if (t.payment) rows.push(["Payment Terms", t.payment]);
  if (t.delivery) rows.push(["Delivery Terms", t.delivery]);
  if (t.deliveryInstructions) rows.push(["Delivery Instructions", t.deliveryInstructions]);
  if (t.preparedBy) rows.push(["Prepared By", t.preparedBy]);
  if (t.approvedBy) rows.push(["Approved By", t.approvedBy]);
  if (rows.length === 0) return y;

  // Keep the whole block on one page — push it to the next page if it wouldn't fit.
  const pageBottom = doc.page.height - PAGE.margin - 30;
  const estH = 16 + rows.length * 14;
  let yy = y;
  if (yy + estH > pageBottom) {
    doc.addPage();
    yy = PAGE.margin;
  }

  doc.font("Helvetica-Bold").fontSize(FONT.label).fillColor(accent).text("TERMS & AUTHORISATION", x, yy, { width: W });
  yy = doc.y + 4;
  const labelW = W * 0.22;
  const valueW = W * 0.78;
  for (const [label, value] of rows) {
    const startY = yy;
    doc.font("Helvetica").fontSize(FONT.label).fillColor(COLORS.faint).text(label.toUpperCase(), x, startY + 1, { width: labelW });
    doc.font("Helvetica-Bold").fontSize(FONT.small).fillColor(COLORS.ink).text(value, x + labelW, startY, { width: valueW });
    // A wrapped value can push past one line; advance to whichever column ended lower.
    yy = Math.max(doc.y, startY + 14);
  }
  return yy;
}

function drawCompany(doc: Doc, data: PurchaseOrderDocumentData, x: number, y: number, w: number): number {
  let yy = y;
  doc
    .font("Helvetica-Bold")
    .fontSize(FONT.section)
    .fillColor(COLORS.ink)
    .text(data.company.legalName || data.branding.brandName, x, yy, { width: w });
  yy = doc.y + 2;
  doc.font("Helvetica").fontSize(FONT.small).fillColor(COLORS.muted);
  const idBits: string[] = [];
  if (data.company.registrationNumber) idBits.push(`Reg No: ${data.company.registrationNumber}`);
  if (data.company.vatNumber) idBits.push(`VAT: ${data.company.vatNumber}`);
  if (idBits.length) {
    doc.text(idBits.join("    "), x, yy, { width: w });
    yy = doc.y;
  }
  for (const ln of data.company.addressLines) {
    doc.text(ln, x, yy, { width: w });
    yy = doc.y;
  }
  for (const c of [data.company.phone, data.company.email, data.company.website].filter(Boolean)) {
    doc.text(c, x, yy, { width: w });
    yy = doc.y;
  }
  return yy;
}

function drawMeta(doc: Doc, data: PurchaseOrderDocumentData, x: number, y: number, w: number): number {
  const rows: [string, string][] = [
    ["PO Number", data.order.code],
    ["Status", data.order.status],
    ["Order Date", data.order.orderDate || "—"],
    ["Expected Delivery", data.order.expectedDeliveryDate || "—"],
  ];
  if (data.order.project) rows.push(["Project", data.order.project]);
  if (data.order.reference) rows.push(["Supplier Reference", data.order.reference]);
  rows.push(["Currency", data.order.currency]);
  rows.push(["Priority", data.order.priority]);
  let yy = y;
  for (const [label, value] of rows) {
    const startY = yy;
    doc
      .font("Helvetica")
      .fontSize(FONT.label)
      .fillColor(COLORS.faint)
      .text(label.toUpperCase(), x, startY + 1, { width: w * 0.5, lineBreak: false });
    doc
      .font("Helvetica-Bold")
      .fontSize(FONT.small)
      .fillColor(COLORS.ink)
      .text(value, x + w * 0.5, startY, { width: w * 0.5, align: "right" });
    // A value wider than the column WRAPS — a job-linked PO's project reference ("JOBNUM — Job
    // name") routinely does. Advancing a fixed 14pt regardless printed the next rows (Currency,
    // Priority) straight on top of it, so take whichever ended lower. Same rule as drawTerms.
    yy = Math.max(doc.y, startY + 14);
  }
  return yy;
}

function drawParty(
  doc: Doc,
  title: string,
  name: string,
  addressLines: string[],
  contactBits: string[],
  x: number,
  y: number,
  w: number,
  accent: string,
): number {
  let yy = y;
  doc.font("Helvetica-Bold").fontSize(FONT.label).fillColor(accent).text(title, x, yy, { width: w });
  yy = doc.y + 2;
  doc.font("Helvetica-Bold").fontSize(FONT.body).fillColor(COLORS.ink).text(name || "—", x, yy, { width: w });
  yy = doc.y + 1;
  doc.font("Helvetica").fontSize(FONT.small).fillColor(COLORS.muted);
  for (const ln of addressLines) {
    doc.text(ln, x, yy, { width: w });
    yy = doc.y;
  }
  for (const c of contactBits.filter(Boolean)) {
    doc.text(c, x, yy, { width: w });
    yy = doc.y;
  }
  return yy;
}

function drawItemsTable(
  doc: Doc,
  lines: PoDocLine[],
  x: number,
  y: number,
  W: number,
  accent: string,
): number {
  // A VAT column, because every line carries its OWN rate: on a mixed-rate order (20% goods and a
  // zero-rated line) a single lump VAT figure at the bottom is one the supplier cannot reconcile.
  const cols = {
    name: { x, w: W * 0.42 },
    qty: { x: x + W * 0.42, w: W * 0.13 },
    unit: { x: x + W * 0.55, w: W * 0.17 },
    vat: { x: x + W * 0.72, w: W * 0.09 },
    total: { x: x + W * 0.81, w: W * 0.19 },
  };
  const padX = 6;
  const padY = 6;
  const onAccent = readableOn(accent);
  let yy = y;

  const header = () => {
    doc.rect(x, yy, W, 22).fill(accent);
    doc.font("Helvetica-Bold").fontSize(FONT.label).fillColor(onAccent);
    doc.text("ITEM", cols.name.x + padX, yy + 7, { width: cols.name.w - padX * 2, lineBreak: false });
    doc.text("QTY", cols.qty.x, yy + 7, { width: cols.qty.w - padX, align: "right", lineBreak: false });
    doc.text("UNIT PRICE", cols.unit.x, yy + 7, { width: cols.unit.w - padX, align: "right", lineBreak: false });
    doc.text("VAT", cols.vat.x, yy + 7, { width: cols.vat.w - padX, align: "right", lineBreak: false });
    doc.text("LINE TOTAL", cols.total.x, yy + 7, { width: cols.total.w - padX, align: "right", lineBreak: false });
    yy += 22;
  };

  header();
  const pageBottom = doc.page.height - PAGE.margin - 30;
  let zebra = false;

  for (const line of lines) {
    doc.font("Helvetica-Bold").fontSize(FONT.small);
    const nameH = doc.heightOfString(line.name, { width: cols.name.w - padX * 2 });
    let descH = 0;
    if (line.description) {
      doc.font("Helvetica").fontSize(FONT.small);
      descH = doc.heightOfString(line.description, { width: cols.name.w - padX * 2 });
    }
    const rowH = Math.max(20, padY * 2 + nameH + (descH ? descH + 1 : 0));

    if (yy + rowH > pageBottom) {
      doc.addPage();
      yy = PAGE.margin;
      header();
    }

    if (zebra) doc.rect(x, yy, W, rowH).fill(COLORS.zebra);
    zebra = !zebra;

    doc
      .font("Helvetica-Bold")
      .fontSize(FONT.small)
      .fillColor(COLORS.ink)
      .text(line.name, cols.name.x + padX, yy + padY, { width: cols.name.w - padX * 2 });
    if (line.description) {
      doc
        .font("Helvetica")
        .fontSize(FONT.small)
        .fillColor(COLORS.muted)
        .text(line.description, cols.name.x + padX, yy + padY + nameH + 1, { width: cols.name.w - padX * 2 });
    }
    doc.font("Helvetica").fontSize(FONT.small).fillColor(COLORS.ink);
    doc.text(line.quantity, cols.qty.x, yy + padY, { width: cols.qty.w - padX, align: "right", lineBreak: false });
    doc.text(line.unitPrice, cols.unit.x, yy + padY, { width: cols.unit.w - padX, align: "right", lineBreak: false });
    doc.text(line.vatRate, cols.vat.x, yy + padY, { width: cols.vat.w - padX, align: "right", lineBreak: false });
    doc.text(line.lineTotal, cols.total.x, yy + padY, { width: cols.total.w - padX, align: "right", lineBreak: false });

    yy += rowH;
    doc.lineWidth(0.5).strokeColor(COLORS.line).moveTo(x, yy).lineTo(x + W, yy).stroke();
  }

  if (lines.length === 0) {
    doc
      .font("Helvetica")
      .fontSize(FONT.small)
      .fillColor(COLORS.faint)
      .text("No items on this order.", x + padX, yy + padY);
    yy += 24;
  }
  return yy;
}

// Subtotal / VAT / Grand Total. Kept WHOLE on one page: at the wrong line count this block used to
// straddle the page boundary, printing VAT on top of the page footer and orphaning "Grand Total"
// alone onto the next page — with a blank page behind it, because drawing into the bottom margin
// makes pdfkit auto-spawn one page per text() call.
function drawTotals(doc: Doc, data: PurchaseOrderDocumentData, x: number, y: number, W: number): number {
  const boxW = W * 0.4;
  const boxX = x + W - boxW;
  const pageBottom = doc.page.height - PAGE.margin - 30;
  const estH = 6 + 16 + 16 + 6 + 20; // start offset + subtotal + VAT + rule + grand total
  let yy = y + 6;
  if (yy + estH > pageBottom) {
    doc.addPage();
    yy = PAGE.margin;
  }
  const row = (label: string, value: string, bold: boolean) => {
    const size = bold ? FONT.body : FONT.small;
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(size)
      .fillColor(COLORS.muted)
      .text(label, boxX, yy, { width: boxW * 0.5, lineBreak: false });
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(size)
      .fillColor(COLORS.ink)
      .text(value, boxX + boxW * 0.5, yy, { width: boxW * 0.5, align: "right", lineBreak: false });
    yy += bold ? 20 : 16;
  };
  row("Subtotal", data.totals.subtotal, false);
  // "VAT (20%)" on a single-rate order — the reader can check the figure without a calculator.
  row(data.totals.vatLabel, data.totals.vat, false);
  doc.lineWidth(0.5).strokeColor(COLORS.line).moveTo(boxX, yy).lineTo(boxX + boxW, yy).stroke();
  yy += 6;
  row("Grand Total", data.totals.grandTotal, true);
  return yy;
}

function drawNotes(doc: Doc, notes: string, x: number, y: number, W: number): number {
  const noteW = W * 0.72;
  const pageBottom = doc.page.height - PAGE.margin - 30;
  doc.font("Helvetica").fontSize(FONT.small);
  // Same page-boundary rule as the totals and terms blocks: a note drawn into the bottom margin
  // lands on the footer and spawns a blank page behind it.
  let top = y;
  if (top + 14 + doc.heightOfString(notes, { width: noteW }) > pageBottom) {
    doc.addPage();
    top = PAGE.margin;
  }
  doc.font("Helvetica-Bold").fontSize(FONT.label).fillColor(COLORS.faint).text("NOTES", x, top);
  const yy = doc.y + 2;
  doc.font("Helvetica").fontSize(FONT.small).fillColor(COLORS.muted).text(notes, x, yy, { width: noteW });
  return doc.y;
}

// Blank paper reserved for the signature GRAPHIC — only when there is one to draw.
//
// Uploading a signature is optional and most issuers never do, so this slot is usually empty. It was
// reserved regardless, which put 46pt of nothing between "AUTHORISED BY" and the rule: on a document
// the supplier receives that reads as a MISSING signature, and on an order whose content already ran
// near the foot of the page it pushed the whole block onto a second sheet carrying nothing else.
const SIGNATURE_IMAGE_SLOT = 42;
const SIGNATURE_LABEL_GAP = 15;
const SIGNATURE_RULE_GAP = 4;

/**
 * How much room the AUTHORISED BY block needs — the page-fit guard and the layout read the SAME
 * number, so the guard can never reserve for a graphic the block then doesn't draw.
 */
export function signatureBlockHeight(hasImage: boolean, hasJobTitle = false): number {
  const toRule = SIGNATURE_LABEL_GAP + (hasImage ? SIGNATURE_IMAGE_SLOT : 0) + SIGNATURE_RULE_GAP;
  return toRule + 4 + 12 + (hasJobTitle ? 12 : 0) + 4;
}

function drawSignature(doc: Doc, data: PurchaseOrderDocumentData, x: number, y: number, W: number): void {
  const sig = data.signature;
  if (!sig) return;
  let yy = y + 6;
  const pageBottom = doc.page.height - PAGE.margin - 30;
  const needed = signatureBlockHeight(Boolean(sig.image), Boolean(sig.jobTitle));
  if (yy + needed > pageBottom) {
    doc.addPage();
    yy = PAGE.margin;
  }
  const w = W * 0.4;
  doc.font("Helvetica-Bold").fontSize(FONT.label).fillColor(COLORS.faint).text("AUTHORISED BY", x, yy, { width: w });
  const imgY = yy + SIGNATURE_LABEL_GAP;
  if (sig.image) {
    try {
      doc.image(sig.image, x, imgY, { fit: [150, SIGNATURE_IMAGE_SLOT] });
    } catch {
      // Bad/unsupported image — fall back to the name + line only. The slot stays reserved: the
      // guard above already measured for it, and shrinking now would leave a gap mid-page anyway.
    }
  }
  const lineY = imgY + (sig.image ? SIGNATURE_IMAGE_SLOT : 0) + SIGNATURE_RULE_GAP;
  doc.lineWidth(0.5).strokeColor(COLORS.line).moveTo(x, lineY).lineTo(x + w, lineY).stroke();
  doc.font("Helvetica-Bold").fontSize(FONT.small).fillColor(COLORS.ink).text(sig.signerName, x, lineY + 4, { width: w });
  if (sig.jobTitle) {
    doc.font("Helvetica").fontSize(FONT.small).fillColor(COLORS.muted).text(sig.jobTitle, x, doc.y, { width: w });
  }
}

/**
 * Trims `text` with a trailing "…" until it fits `maxWidth` at the doc's current font/size.
 * Returns "" when there is no usable space at all. Callers must set the font before calling.
 */
function ellipsize(doc: Doc, text: string, maxWidth: number): string {
  // Reject non-finite budgets FIRST. Every comparison against NaN is false, so a NaN width would
  // fall through all three guards below AND skip the trim loop — returning the full string, which
  // the caller then draws with `lineBreak: false`, i.e. exactly the unclipped overrun this helper
  // exists to prevent. A width can go NaN if widthOfString() misses a glyph's font metrics.
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return "";
  if (doc.widthOfString(text) <= maxWidth) return text;
  const ellipsis = "…";
  if (doc.widthOfString(ellipsis) > maxWidth) return "";
  let out = text;
  while (out.length > 0 && doc.widthOfString(out + ellipsis) > maxWidth) out = out.slice(0, -1);
  return out.length > 0 ? out + ellipsis : "";
}

function drawFooters(doc: Doc, data: PurchaseOrderDocumentData, regional: DocumentRegional): void {
  const M = PAGE.margin;
  const W = doc.page.width - M * 2;
  const range = doc.bufferedPageRange();
  const generatedAt = formatDateTime(data.meta.generatedAt, regional);
  const left = [data.company.legalName, data.company.phone, data.company.email].filter(Boolean).join("   ·   ");
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // The footer MUST sit inside the printable area — above pdfkit's maxY (= height - bottom margin).
    // Drawing text in/below the bottom margin makes text() auto-spawn a blank page (one per call),
    // which previously produced trailing white pages. The content band reserves 30pt at the bottom
    // (see drawItemsTable/drawSignature), so this never overlaps content.
    const yy = doc.page.height - M - 16;
    doc.lineWidth(0.5).strokeColor(COLORS.line).moveTo(M, yy - 6).lineTo(M + W, yy - 6).stroke();
    doc.font("Helvetica").fontSize(FONT.small).fillColor(COLORS.faint);
    // The generating user is deliberately NOT printed — it is internal audit data the supplier has
    // no use for, and at A4 it cost ~88pt, which forced the company's own email to be truncated
    // ("shahul@mnt…") on an outward-facing document. It remains recorded in the audit log.
    const meta = `${data.meta.documentCode}   ·   Generated ${generatedAt}   ·   Page ${i + 1} of ${range.count}`;
    // `lineBreak: false` makes pdfkit ignore `width` for wrapping AND clipping, so a long left
    // string silently overruns into the right-aligned meta block ("…@mntfuturePO-0031"). Measure
    // the meta text and hand the left side only the space that is actually left over, ellipsizing
    // it if it still doesn't fit (a safety net — the two sides fit at A4 today).
    const rawMetaW = doc.widthOfString(meta);
    // Fall back to a conservative half-width if the measurement is unusable (a NaN from a missing
    // glyph metric). Without this the left budget would be NaN and the company line would silently
    // vanish from the document — degrade to "possibly ellipsized" rather than "missing".
    const metaW = Number.isFinite(rawMetaW) ? rawMetaW : W / 2;
    if (left) {
      const gap = 12;
      const leftW = W - metaW - gap;
      const fitted = ellipsize(doc, left, leftW);
      if (fitted) doc.text(fitted, M, yy, { width: leftW, lineBreak: false });
    }
    doc.text(meta, M, yy, { width: W, align: "right", lineBreak: false });
  }
}
