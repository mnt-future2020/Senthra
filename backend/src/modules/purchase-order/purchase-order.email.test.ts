import { beforeEach, describe, expect, it, vi } from "vitest";

// The document render, SoT readers and the email transport are mocked — this isolates the
// orchestration (which template, recipient, attachment, skip + failure semantics).
vi.mock("#modules/settings/settings.service.js", () => ({
  getCompanyProfile: vi.fn(),
  getRegionalSettings: vi.fn(),
}));
vi.mock("#modules/email/email.service.js", () => ({ sendTemplatedEmail: vi.fn() }));
vi.mock("#modules/document/document.service.js", () => ({ generatePurchaseOrderPdf: vi.fn() }));

import type { PurchaseOrderWithRelations } from "./purchase-order.repository.js";
import { getCompanyProfile, getRegionalSettings } from "#modules/settings/settings.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
import { generatePurchaseOrderPdf } from "#modules/document/document.service.js";
import { notifySupplierPoCancelled, notifySupplierPoSent } from "./purchase-order.email.js";

const mockCompany = getCompanyProfile as ReturnType<typeof vi.fn>;
const mockRegional = getRegionalSettings as ReturnType<typeof vi.fn>;
const mockSend = sendTemplatedEmail as ReturnType<typeof vi.fn>;
const mockPdf = generatePurchaseOrderPdf as ReturnType<typeof vi.fn>;

function po(over: Record<string, unknown> = {}): PurchaseOrderWithRelations {
  return {
    id: "po1",
    code: "PO-0001",
    currency: "GBP",
    supplierName: "Acme",
    sentBy: "buyer@x.co",
    sentAt: new Date("2026-06-05T00:00:00Z"),
    orderDate: new Date("2026-06-01T00:00:00Z"),
    expectedDeliveryDate: new Date("2026-06-10T00:00:00Z"),
    grandTotalPence: 8400,
    supplier: { name: "Acme Ltd", contactPerson: "Dana", contactEmail: "sales@acme.co" },
    ...over,
  } as unknown as PurchaseOrderWithRelations;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCompany.mockResolvedValue({ legalName: "Electra Networks Ltd" });
  mockRegional.mockResolvedValue({ timezone: "Europe/London", dateFormat: "DD/MM/YYYY", timeFormat: "24h" });
  mockPdf.mockResolvedValue({ buffer: Buffer.from("%PDF-1.4 fake"), filename: "PO-0001.pdf", mimeType: "application/pdf" });
  mockSend.mockResolvedValue(undefined);
});

describe("notifySupplierPoSent", () => {
  it("generates the PDF (signed from sentBy) and emails po.sent with the PDF attached", async () => {
    await notifySupplierPoSent(po(), { type: "user", id: "u", email: "buyer@x.co", permissions: [] });
    expect(mockPdf).toHaveBeenCalledWith(expect.objectContaining({ code: "PO-0001" }), "buyer@x.co");
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [key, to, vars, opts] = mockSend.mock.calls[0];
    expect(key).toBe("po.sent");
    expect(to).toBe("sales@acme.co");
    expect(vars).toMatchObject({
      poCode: "PO-0001",
      supplierName: "Acme Ltd",
      companyLegalName: "Electra Networks Ltd",
      grandTotal: "£84.00",
    });
    expect(opts.attachments).toHaveLength(1);
    expect(opts.attachments[0]).toMatchObject({ filename: "PO-0001.pdf", contentType: "application/pdf" });
  });

  it("skips cleanly (no PDF, no email, no throw) when the supplier has no email", async () => {
    await expect(
      notifySupplierPoSent(po({ supplier: { name: "Acme Ltd", contactPerson: "Dana", contactEmail: null } })),
    ).resolves.toBeUndefined();
    expect(mockPdf).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("propagates a send failure so the fire-and-forget caller can log it", async () => {
    mockSend.mockRejectedValueOnce(new Error("SMTP down"));
    await expect(notifySupplierPoSent(po())).rejects.toThrow(/SMTP/);
  });
});

describe("notifySupplierPoCancelled", () => {
  it("emails po.cancelled (no attachment) when the PO had already been sent", async () => {
    await notifySupplierPoCancelled(po({ sentAt: new Date() }));
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [key, to, vars, opts] = mockSend.mock.calls[0];
    expect(key).toBe("po.cancelled");
    expect(to).toBe("sales@acme.co");
    expect(vars).toMatchObject({ poCode: "PO-0001", companyLegalName: "Electra Networks Ltd" });
    expect(opts).toBeUndefined();
  });

  it("does NOT email when the PO was never issued (no sentAt)", async () => {
    await notifySupplierPoCancelled(po({ sentAt: null }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does NOT email when the supplier has no email", async () => {
    await notifySupplierPoCancelled(po({ supplier: { name: "Acme", contactEmail: null }, sentAt: new Date() }));
    expect(mockSend).not.toHaveBeenCalled();
  });
});
