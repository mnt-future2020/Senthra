import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHERE a customer logo was stored, recorded at the moment it is stored.
 *
 * Create and update both write the logo's identity, and they had drifted: update persisted the
 * provider, create did not. A logo uploaded to the second provider during create therefore read
 * back as Cloudinary, and its object could never be addressed for deletion — the exact failure the
 * provider column exists to prevent, on the one path that writes the most logos.
 */
vi.mock("./customer.repository.js", () => ({
  findByEmailIncludingDeleted: vi.fn(),
  findActiveByNameLower: vi.fn(),
  createWithCode: vi.fn(),
  revive: vi.fn(),
  createCustomerUser: vi.fn(),
  softDelete: vi.fn(),
  isUniqueConflictError: () => false,
}));
const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("../../lib/storage/index.js", () => ({ findActiveStorage: vi.fn(async () => ({ upload })) }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
// Trim the heavy dependency graph this module pulls in transitively.
vi.mock("#modules/auth/email-namespace.js", () => ({ assertEmailNamespaceFree: vi.fn() }));
vi.mock("#modules/auth/auth.service.js", () => ({ issueResetEmail: vi.fn() }));
vi.mock("#modules/auth/session.service.js", () => ({}));
vi.mock("./customer.stock.service.js", () => ({ getCustomerStock: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({}));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn(), getStockCodePrefix: vi.fn() }));
vi.mock("../../lib/warehouse-access.js", () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock("#modules/email/email.service.js", () => ({ sendTemplatedEmail: vi.fn(async () => undefined) }));

import * as customerRepo from "./customer.repository.js";

import { createCustomer } from "./customer.service.js";

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const LOGO = "data:image/png;base64,iVBORw0KGgo=";

/** What the storage layer hands back for one stored logo. `provider` is the coordinate at issue. */
const storedOn = (provider: string) => ({
  url: `https://cdn/${provider}/logo.png`,
  publicId: "senthra/customers/logo-abc",
  resourceType: "image",
  provider,
});

const customerRow = {
  id: "c1",
  customerCode: "CUS-0001",
  name: "LOBBI",
  email: "ops@lobbi.co",
  status: "active",
  logoUrl: "https://cdn/logo.png",
  createdAt: new Date("2026-07-02T00:00:00Z"),
  updatedAt: new Date("2026-07-02T00:00:00Z"),
};

const input = { name: "LOBBI", email: "ops@lobbi.co", logo: LOGO };

beforeEach(() => {
  vi.clearAllMocks();
  asMock(customerRepo.findByEmailIncludingDeleted).mockResolvedValue(null);
  asMock(customerRepo.findActiveByNameLower).mockResolvedValue(null);
  asMock(customerRepo.createWithCode).mockResolvedValue(customerRow);
  asMock(customerRepo.revive).mockResolvedValue(customerRow);
  asMock(customerRepo.createCustomerUser).mockResolvedValue({ id: "u1", fullName: "Dana", email: "ops@lobbi.co" });
  asMock(customerRepo.softDelete).mockResolvedValue(undefined);
});

describe("createCustomer — the logo's provider is persisted with it", () => {
  // THE REGRESSION. Delete resolves the provider from THIS column; without it every Spaces logo
  // created here is addressed against Cloudinary, answers "not found", and survives forever.
  it("records the provider the logo was actually stored on", async () => {
    upload.mockResolvedValue(storedOn("spaces"));
    await createCustomer(input);
    expect(asMock(customerRepo.createWithCode).mock.calls[0]![0]).toMatchObject({
      logoUrl: "https://cdn/spaces/logo.png",
      logoPublicId: "senthra/customers/logo-abc",
      logoResourceType: "image",
      logoProvider: "spaces",
    });
  });

  it("records Cloudinary just as explicitly", async () => {
    upload.mockResolvedValue(storedOn("cloudinary"));
    await createCustomer(input);
    expect(asMock(customerRepo.createWithCode).mock.calls[0]![0]).toMatchObject({ logoProvider: "cloudinary" });
  });

  // Revive shares `customerColumns` with create precisely so the two cannot diverge — which is what
  // had happened against update. Re-adding a removed customer must record the provider too.
  it("records the provider when reviving a soft-deleted customer", async () => {
    asMock(customerRepo.findByEmailIncludingDeleted).mockResolvedValue({ id: "c1", deletedAt: new Date() });
    upload.mockResolvedValue(storedOn("spaces"));
    await createCustomer(input);
    expect(asMock(customerRepo.revive).mock.calls[0]![1]).toMatchObject({ logoProvider: "spaces" });
  });

  // No logo means no identity to record. Null is the legacy value every pre-existing row carries,
  // and the normaliser downstream reads it as Cloudinary — which is where those logos are.
  it("writes a null provider when no logo is supplied", async () => {
    await createCustomer({ name: "LOBBI", email: "ops@lobbi.co" });
    expect(upload).not.toHaveBeenCalled();
    expect(asMock(customerRepo.createWithCode).mock.calls[0]![0]).toMatchObject({
      logoUrl: null,
      logoPublicId: null,
      logoResourceType: null,
      logoProvider: null,
    });
  });
});
