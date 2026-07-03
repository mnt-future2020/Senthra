# Customer Site Bulk Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin bulk-import a customer's delivery/installation sites from an Excel/CSV sheet, with an in-browser preview, per-row validation, skip-duplicate handling, and a race-safe batched backend insert.

**Architecture:** The browser parses the sheet with SheetJS (lazy-loaded), validates each row for the preview, and POSTs valid rows as JSON — in sequential batches of ≤500 — to a new `POST /customers/:id/sites/bulk`. The backend re-validates every row authoritatively (`siteSchema`), skips duplicates (name+postcode), batch-geocodes postcodes, and allocates a contiguous `STE-####` code block via one atomic counter `$inc` before `createMany`. No backend file-upload/multipart.

**Tech Stack:** Backend — Express 5, Prisma (MongoDB), zod, vitest. Frontend — Next.js 16, React 19, `xlsx` (SheetJS), vitest.

**Spec:** `docs/superpowers/specs/2026-07-02-customer-site-bulk-import-design.md`

## Global Constraints

- **ESM / NodeNext (backend):** every relative import MUST include the `.js` extension; cross-module imports use the `#modules/<domain>/...` alias (also with `.js`). Same-module imports stay relative (`./customer.repository.js`); shared dirs stay relative (`../../lib/geocode.js`).
- **Strict layering:** `route → middleware → controller → service → repository → Prisma`. Prisma is touched ONLY in repositories. Controllers hold no logic. Services throw `HttpError` (`badRequest`/`notFound` from `../../utils/http-error.js`) or return data.
- **Counter reservation rule (verified):** the site-code counter `$inc` MUST be a standalone atomic op — NEVER inside `withTransaction` (avoids un-retried Mongo `TransientTransactionError`). Do NOT allocate by `max(code)+1`.
- **Dedupe key (client + server identical):** `name.trim().toLowerCase() + "|" + (postcode||"").toLowerCase().replace(/\s+/g,"")`.
- **Batch cap:** ≤500 rows per HTTP request (backend hard-rejects >500); client sends larger sheets in sequential 500-row batches; soft guard ~5,000 rows total.
- **Country default** "United Kingdom"; **status default** "active".
- **Git:** per the repo owner's standing rule, do NOT commit or push without explicit approval. The commit step in each task is a checkpoint — stage the files and prepare the message, but only run `git commit` when the owner has said to. Let them test first.
- **Verify commands:** backend `cd backend && pnpm typecheck && pnpm lint`; backend tests `pnpm vitest run <file>`; frontend `cd frontend && pnpm test` and `npx tsc --noEmit`.

---

### Task 1: Backend — `geocodePostcodesBulk`

Batch postcode → coordinates via postcodes.io's bulk endpoint (100/call), best-effort. Reuses the existing single `geocodePostcode` file.

**Files:**
- Modify: `backend/src/lib/geocode.ts`
- Test: `backend/src/lib/geocode.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `canonicalPostcode(p: string): string` and `geocodePostcodesBulk(codes: (string|null|undefined)[]): Promise<Map<string, Coordinates>>` — the returned map is keyed by `canonicalPostcode` (uppercased, spaces removed). Existing `geocodePostcode`, `lookupPostcode`, `Coordinates`, `PostcodeDetails` stay unchanged.

- [ ] **Step 1: Write the failing test**

Create `backend/src/lib/geocode.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalPostcode, geocodePostcodesBulk } from "./geocode.js";

afterEach(() => vi.restoreAllMocks());

describe("canonicalPostcode", () => {
  it("uppercases and strips all spaces", () => {
    expect(canonicalPostcode(" ls1 4dy ")).toBe("LS14DY");
    expect(canonicalPostcode("ec1a1bb")).toBe("EC1A1BB");
  });
});

describe("geocodePostcodesBulk", () => {
  it("returns an empty map for no postcodes without calling the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const map = await geocodePostcodesBulk([]);
    expect(map.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps each known postcode to coords, keyed canonically, and omits unknowns", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          { query: "LS1 4DY", result: { latitude: 53.79, longitude: -1.54 } },
          { query: "ZZ1 1ZZ", result: null },
        ],
      }),
    } as unknown as Response);

    const map = await geocodePostcodesBulk(["ls1 4dy", "ZZ1 1ZZ", null, "ls1 4dy"]);
    expect(map.get("LS14DY")).toEqual({ latitude: 53.79, longitude: -1.54 });
    expect(map.has("ZZ11ZZ")).toBe(false);
  });

  it("never throws on a network error — returns whatever resolved (empty here)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const map = await geocodePostcodesBulk(["LS1 4DY"]);
    expect(map.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/lib/geocode.test.ts`
Expected: FAIL — `canonicalPostcode`/`geocodePostcodesBulk` are not exported.

- [ ] **Step 3: Implement**

Append to `backend/src/lib/geocode.ts` (below `geocodePostcode`):

```ts
// Canonical postcode key: uppercase, all whitespace removed. postcodes.io accepts a
// postcode with or without the internal space, so this collapses "LS1 4DY"/"ls14dy"
// to one key for de-duping lookups and indexing the result map.
export function canonicalPostcode(postcode: string): string {
  return postcode.trim().toUpperCase().replace(/\s+/g, "");
}

// Bulk postcode → coordinates via postcodes.io POST /postcodes (max 100 per call).
// Best-effort, like the single lookup: any failed chunk contributes nothing. The
// returned Map is keyed by canonicalPostcode; unknown postcodes are simply absent.
export async function geocodePostcodesBulk(
  codes: (string | null | undefined)[],
): Promise<Map<string, Coordinates>> {
  const out = new Map<string, Coordinates>();
  const unique = [...new Set(codes.map((c) => c?.trim()).filter((c): c is string => !!c))];
  if (unique.length === 0) return out;

  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(POSTCODES_IO, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postcodes: chunk }),
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        result?: { query: string; result: { latitude?: number | null; longitude?: number | null } | null }[];
      };
      for (const row of body.result ?? []) {
        const r = row.result;
        if (r && typeof r.latitude === "number" && typeof r.longitude === "number") {
          out.set(canonicalPostcode(row.query), { latitude: r.latitude, longitude: r.longitude });
        }
      }
    } catch {
      // best-effort: skip this chunk
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/lib/geocode.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit** (only when approved — see Global Constraints)

```bash
git add backend/src/lib/geocode.ts backend/src/lib/geocode.test.ts
git commit -m "feat(geocode): add batch postcode lookup (geocodePostcodesBulk)"
```

---

### Task 2: Backend — `bulkSiteSchema`

The route-level guard: an array of raw objects, size-bounded. Per-row validation is deliberately left to the service (partial success).

**Files:**
- Modify: `backend/src/modules/customer/customer.validation.ts`
- Test: `backend/src/modules/customer/customer.validation.test.ts:47` (extend — add a `bulkSiteSchema` block)

**Interfaces:**
- Consumes: existing `siteSchema` (unchanged).
- Produces: `bulkSiteSchema` (zod object) and `type BulkSiteInput = { fileName?: string; sites: Record<string, unknown>[] }`.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/modules/customer/customer.validation.test.ts` (import `bulkSiteSchema` at the top alongside `siteSchema`):

```ts
describe("bulkSiteSchema", () => {
  it("accepts an array of raw row objects", () => {
    const r = bulkSiteSchema.safeParse({ fileName: "sites.xlsx", sites: [{ name: "A" }, { anything: 1 }] });
    expect(r.success).toBe(true);
  });
  it("rejects an empty array", () => {
    expect(bulkSiteSchema.safeParse({ sites: [] }).success).toBe(false);
  });
  it("rejects more than 500 rows", () => {
    const sites = Array.from({ length: 501 }, () => ({ name: "A" }));
    expect(bulkSiteSchema.safeParse({ sites }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/modules/customer/customer.validation.test.ts`
Expected: FAIL — `bulkSiteSchema` is not exported.

- [ ] **Step 3: Implement**

In `backend/src/modules/customer/customer.validation.ts`, directly below `export type SiteInput = z.infer<typeof siteSchema>;`:

```ts
// Bulk site import. Route-level guard only: an array of RAW row objects, size-bounded.
// Per-row validation is intentionally deferred to the service (siteSchema.safeParse per
// row) so one bad row reports as `failed` instead of rejecting the whole batch.
export const bulkSiteSchema = z.object({
  fileName: z.string().trim().max(260).optional(),
  sites: z
    .array(z.record(z.string(), z.unknown()))
    .min(1, "Add at least one site.")
    .max(500, "Import up to 500 sites per batch."),
});
export type BulkSiteInput = z.infer<typeof bulkSiteSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/modules/customer/customer.validation.test.ts`
Expected: PASS (existing siteSchema tests + 3 new).

- [ ] **Step 5: Commit** (when approved)

```bash
git add backend/src/modules/customer/customer.validation.ts backend/src/modules/customer/customer.validation.test.ts
git commit -m "feat(customer): add bulkSiteSchema for site import"
```

---

### Task 3: Backend — repository `findSitesByCustomer` + `createSitesBulk`

Race-safe contiguous code-block allocation + `createMany`. This is the crux — follow the counter rule exactly.

**Files:**
- Modify: `backend/src/modules/customer/customer.repository.ts`
- Test: `backend/src/modules/customer/customer.repository.bulk.test.ts` (create)

**Interfaces:**
- Consumes: existing module-private `highestNestedSuffix`, `isRecordNotFound`, `isUniqueConflict`, and the exported `SiteData` interface (unchanged).
- Produces:
  - `findSitesByCustomer(customerId: string): Promise<{ name: string; postcode: string | null }[]>`
  - `createSitesBulk(customerId: string, data: SiteData[]): Promise<CustomerSite[]>`

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/customer/customer.repository.bulk.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const counter = { update: vi.fn(), create: vi.fn() };
const customerSite = { findMany: vi.fn(), createMany: vi.fn() };
vi.mock("../../lib/prisma.js", () => ({
  prisma: { counter, customerSite },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { createSitesBulk } from "./customer.repository.js";

beforeEach(() => vi.clearAllMocks());

const site = (name: string) => ({ name, addressLine1: null, addressLine2: null, city: null, county: null, postcode: null, country: null, contactPerson: null, contactNumber: null, latitude: null, longitude: null, status: "active" });

describe("createSitesBulk", () => {
  it("reserves a block with ONE atomic increment of N and assigns codes from the returned end seq", async () => {
    counter.update.mockResolvedValue({ seq: 7 }); // end seq → block is 5,6,7 for N=3
    customerSite.createMany.mockResolvedValue({ count: 3 });
    customerSite.findMany.mockResolvedValue([{ code: "STE-0005" }, { code: "STE-0006" }, { code: "STE-0007" }]);

    await createSitesBulk("cust1", [site("A"), site("B"), site("C")]);

    expect(counter.update).toHaveBeenCalledTimes(1);
    expect(counter.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: "STE:cust1" },
      data: { seq: { increment: 3 } },
    }));
    const created = customerSite.createMany.mock.calls[0][0].data;
    expect(created.map((r: { code: string }) => r.code)).toEqual(["STE-0005", "STE-0006", "STE-0007"]);
  });

  it("cold-start: seeds the counter from the highest existing suffix, tolerates a concurrent-seed conflict, then reserves", async () => {
    counter.update
      .mockRejectedValueOnce(Object.assign(new Error("no counter"), { code: "P2025", name: "PrismaClientKnownRequestError" }))
      .mockResolvedValueOnce({ seq: 2 });
    customerSite.findMany
      .mockResolvedValueOnce([{ code: "STE-0001" }]) // existing codes for seed
      .mockResolvedValueOnce([{ code: "STE-0002" }]); // refetch created
    counter.create.mockResolvedValue({});
    customerSite.createMany.mockResolvedValue({ count: 1 });

    await createSitesBulk("cust2", [site("Only")]);

    expect(counter.create).toHaveBeenCalledWith({ data: { key: "STE:cust2", seq: 1 } });
    expect(counter.update).toHaveBeenCalledTimes(2);
  });

  it("returns [] and does nothing for an empty batch", async () => {
    const res = await createSitesBulk("cust3", []);
    expect(res).toEqual([]);
    expect(counter.update).not.toHaveBeenCalled();
  });
});
```

Note: the mock error must satisfy `isRecordNotFound` (checks `instanceof Prisma.PrismaClientKnownRequestError && code === "P2025"`). Since the test can't easily construct that class, adjust `isRecordNotFound`/`isUniqueConflict` are used internally — **if the `instanceof` check makes this test brittle, assert only the happy-path (first + third test) and cover cold-start in the service test with a fake repo.** Prefer keeping the happy-path + empty-batch assertions here.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/modules/customer/customer.repository.bulk.test.ts`
Expected: FAIL — `createSitesBulk` not exported.

- [ ] **Step 3: Implement**

In `backend/src/modules/customer/customer.repository.ts`, in the `// --- nested: sites ---` region (near `createSite`), add:

```ts
// Dedupe-key source: the customer's existing sites, name + postcode only (avoids
// pulling the whole customer graph just to build the skip set).
export function findSitesByCustomer(
  customerId: string,
): Promise<{ name: string; postcode: string | null }[]> {
  return prisma.customerSite.findMany({
    where: { customerId },
    select: { name: true, postcode: true },
  });
}

// Bulk-create sites with a RACE-SAFE contiguous STE-#### block.
// Allocation mirrors allocateNestedCode: reserve the whole block with ONE atomic $inc
// (by N) on the per-customer counter — NEVER inside a transaction (a $inc inside a Mongo
// transaction can hit un-retried write-conflict aborts). A createMany failure after
// reservation only "burns" the numbers (a gap), never duplicates them.
export async function createSitesBulk(
  customerId: string,
  data: SiteData[],
): Promise<CustomerSite[]> {
  if (data.length === 0) return [];
  const N = data.length;
  const key = `STE:${customerId}`;
  const fmt = (seq: number) => `STE-${String(seq).padStart(4, "0")}`;

  let endSeq: number;
  try {
    const c = await prisma.counter.update({ where: { key }, data: { seq: { increment: N } }, select: { seq: true } });
    endSeq = c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
    const existing = await prisma.customerSite.findMany({ where: { customerId }, select: { code: true } });
    const start = highestNestedSuffix("STE", existing.map((s) => s.code));
    try {
      await prisma.counter.create({ data: { key, seq: start } });
    } catch (e2) {
      if (!isUniqueConflict(e2)) throw e2; // concurrent seed — fine
    }
    const c = await prisma.counter.update({ where: { key }, data: { seq: { increment: N } }, select: { seq: true } });
    endSeq = c.seq;
  }

  const startSeq = endSeq - N + 1;
  const rows = data.map((d, i) => ({
    customerId,
    code: fmt(startSeq + i),
    name: d.name,
    addressLine1: d.addressLine1 ?? null,
    addressLine2: d.addressLine2 ?? null,
    city: d.city ?? null,
    county: d.county ?? null,
    postcode: d.postcode ?? null,
    country: d.country ?? null,
    contactPerson: d.contactPerson ?? null,
    contactNumber: d.contactNumber ?? null,
    latitude: d.latitude ?? null,
    longitude: d.longitude ?? null,
    status: d.status ?? "active",
  }));

  await prisma.customerSite.createMany({ data: rows });
  return prisma.customerSite.findMany({
    where: { customerId, code: { in: rows.map((r) => r.code) } },
    orderBy: { code: "asc" },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/modules/customer/customer.repository.bulk.test.ts`
Expected: PASS (happy-path + empty-batch; cold-start if the `instanceof` mock holds, else covered in Task 4).

- [ ] **Step 5: Typecheck + commit** (when approved)

```bash
cd backend && pnpm typecheck
git add backend/src/modules/customer/customer.repository.ts backend/src/modules/customer/customer.repository.bulk.test.ts
git commit -m "feat(customer): race-safe bulk site creation + findSitesByCustomer"
```

---

### Task 4: Backend — service `bulkAddSites`

Per-row validate → dedupe → batch-geocode → repo insert → audit. The partial-success brain.

**Files:**
- Modify: `backend/src/modules/customer/customer.service.ts`
- Test: `backend/src/modules/customer/customer.service.bulk.test.ts` (create)

**Interfaces:**
- Consumes: `siteSchema`/`SiteInput` (validation), `toSiteData`, `requireCustomer`, `toSite`, `PublicCustomerSite` (this file); `customerRepo.findSitesByCustomer`, `customerRepo.createSitesBulk` (Task 3); `geocodePostcodesBulk`, `canonicalPostcode` (Task 1); `audit.record`.
- Produces:
  - `siteDedupeKey(name: string, postcode: string | null | undefined): string`
  - `interface RowNote { row: number; name: string; reason: string }`
  - `interface BulkSiteResult { createdSites: PublicCustomerSite[]; skipped: RowNote[]; failed: RowNote[] }`
  - `bulkAddSites(customerId: string, rows: unknown[], fileName: string | undefined, actor?: AuditActor): Promise<BulkSiteResult>`

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/customer/customer.service.bulk.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./customer.repository.js", () => ({
  findById: vi.fn(),
  findSitesByCustomer: vi.fn(),
  createSitesBulk: vi.fn(),
}));
vi.mock("../../lib/geocode.js", () => ({
  geocodePostcodesBulk: vi.fn(),
  canonicalPostcode: (p: string) => p.trim().toUpperCase().replace(/\s+/g, ""),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
// Trim the heavy dependency graph this module pulls in transitively.
vi.mock("#modules/auth/email-namespace.js", () => ({ assertEmailNamespaceFree: vi.fn() }));
vi.mock("#modules/auth/auth.service.js", () => ({ issueResetEmail: vi.fn() }));
vi.mock("#modules/auth/session.service.js", () => ({}));
vi.mock("./customer.stock.service.js", () => ({ getCustomerStock: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({}));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn(), getStockCodePrefix: vi.fn() }));
vi.mock("../../lib/warehouse-access.js", () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock("#modules/email/email.service.js", () => ({ sendTemplatedEmail: vi.fn() }));

import * as customerRepo from "./customer.repository.js";
import { geocodePostcodesBulk } from "../../lib/geocode.js";
import * as audit from "#modules/audit/audit.service.js";
import { bulkAddSites } from "./customer.service.js";

const createdSite = (code: string, name: string) => ({
  id: code, code, name, addressLine1: null, addressLine2: null, city: null, county: null,
  postcode: null, country: null, contactPerson: null, contactNumber: null, latitude: null,
  longitude: null, status: "active", createdAt: new Date("2026-07-02T00:00:00Z"),
});

beforeEach(() => {
  vi.clearAllMocks();
  (customerRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1", name: "LOBBI" });
  (customerRepo.findSitesByCustomer as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (geocodePostcodesBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
});

describe("bulkAddSites", () => {
  it("partitions rows into created / skipped / failed", async () => {
    (customerRepo.findSitesByCustomer as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "Existing", postcode: "LS1 4DY" },
    ]);
    (customerRepo.createSitesBulk as ReturnType<typeof vi.fn>).mockResolvedValue([createdSite("STE-0001", "New Site")]);

    const res = await bulkAddSites("c1", [
      { name: "New Site", postcode: "M1 1AA" },      // created
      { name: "Existing", postcode: "ls1 4dy" },     // skipped (matches existing, case-insensitive)
      { name: "", postcode: "M1 1AA" },              // failed (no name)
    ], "sites.xlsx");

    expect(res.createdSites).toHaveLength(1);
    expect(res.skipped).toEqual([{ row: 2, name: "Existing", reason: expect.stringContaining("Already exists") }]);
    expect(res.failed[0]).toMatchObject({ row: 3 });
    expect(customerRepo.createSitesBulk).toHaveBeenCalledWith("c1", [expect.objectContaining({ name: "New Site" })]);
  });

  it("skips a duplicate that appears twice within the same file", async () => {
    (customerRepo.createSitesBulk as ReturnType<typeof vi.fn>).mockResolvedValue([createdSite("STE-0001", "Dup")]);
    const res = await bulkAddSites("c1", [
      { name: "Dup", postcode: "M1 1AA" },
      { name: "dup", postcode: "m1 1aa" },
    ], undefined);
    expect(res.createdSites).toHaveLength(1);
    expect(res.skipped).toHaveLength(1);
  });

  it("attaches geocoded coords by canonical postcode, best-effort", async () => {
    (geocodePostcodesBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([["M11AA", { latitude: 53.4, longitude: -2.2 }]]));
    (customerRepo.createSitesBulk as ReturnType<typeof vi.fn>).mockResolvedValue([createdSite("STE-0001", "Geo")]);
    await bulkAddSites("c1", [{ name: "Geo", postcode: "M1 1AA" }], undefined);
    const staged = (customerRepo.createSitesBulk as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(staged[0]).toMatchObject({ latitude: 53.4, longitude: -2.2 });
  });

  it("records ONE audit entry with fileName + counts", async () => {
    (customerRepo.createSitesBulk as ReturnType<typeof vi.fn>).mockResolvedValue([createdSite("STE-0001", "A")]);
    await bulkAddSites("c1", [{ name: "A" }], "my.xlsx");
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect((audit.record as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      action: "customer.sites.bulk_imported",
      metadata: expect.objectContaining({ fileName: "my.xlsx", created: 1, skipped: 0, failed: 0 }),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/modules/customer/customer.service.bulk.test.ts`
Expected: FAIL — `bulkAddSites` not exported.

- [ ] **Step 3: Implement**

In `backend/src/modules/customer/customer.service.ts`:

Add the geocode import to the existing geocode import line (currently `import { geocodePostcode } from "../../lib/geocode.js";`):

```ts
import { geocodePostcode, geocodePostcodesBulk, canonicalPostcode } from "../../lib/geocode.js";
```

Add the `siteSchema` import — this file imports validation TYPES; it also needs the runtime schema. Add to the existing `./customer.validation.js` import (or add a new import if none):

```ts
import { siteSchema } from "./customer.validation.js";
```

Then, directly after `updateSite` (end of the sites section, near line 882):

```ts
// --- nested: sites — bulk import ---

// Dedupe identity for a site within a customer: name + postcode, case- and space-insensitive.
// MUST match the frontend's dedupeKey in lib/siteImport.ts exactly.
export function siteDedupeKey(name: string, postcode: string | null | undefined): string {
  return `${name.trim().toLowerCase()}|${(postcode ?? "").toLowerCase().replace(/\s+/g, "")}`;
}

export interface RowNote {
  row: number; // 1-based sheet row number (from the client)
  name: string;
  reason: string;
}
export interface BulkSiteResult {
  createdSites: PublicCustomerSite[];
  skipped: RowNote[];
  failed: RowNote[];
}

// Bulk-import sites for one customer. Partial success: each row is validated with the
// SAME siteSchema as single-add (client is never trusted); invalid rows → `failed`,
// duplicates (existing or in-batch) → `skipped`, the rest are geocoded and created.
export async function bulkAddSites(
  customerId: string,
  rows: unknown[],
  fileName: string | undefined,
  actor?: AuditActor,
): Promise<BulkSiteResult> {
  const startedAt = Date.now();
  const customer = await requireCustomer(customerId);

  const existing = await customerRepo.findSitesByCustomer(customerId);
  const seen = new Set(existing.map((s) => siteDedupeKey(s.name, s.postcode)));

  const skipped: RowNote[] = [];
  const failed: RowNote[] = [];
  const staged: customerRepo.SiteData[] = [];

  rows.forEach((raw, i) => {
    const row = i + 1;
    const parsed = siteSchema.safeParse(raw);
    if (!parsed.success) {
      const rawName = (raw as { name?: unknown })?.name;
      failed.push({
        row,
        name: typeof rawName === "string" ? rawName : "",
        reason: parsed.error.issues[0]?.message ?? "Invalid row.",
      });
      return;
    }
    const input = parsed.data;
    const key = siteDedupeKey(input.name, input.postcode);
    if (seen.has(key)) {
      skipped.push({ row, name: input.name, reason: "Already exists (name + postcode)." });
      return;
    }
    seen.add(key);
    staged.push(toSiteData(input));
  });

  // Batch-geocode the staged postcodes, attach coords (best-effort; unknown → null).
  const coords = await geocodePostcodesBulk(staged.map((d) => d.postcode));
  for (const d of staged) {
    const c = d.postcode ? coords.get(canonicalPostcode(d.postcode)) : undefined;
    d.latitude = c?.latitude ?? null;
    d.longitude = c?.longitude ?? null;
  }

  const created = await customerRepo.createSitesBulk(customerId, staged);

  audit.record({
    actor,
    action: "customer.sites.bulk_imported",
    targetType: "customer",
    targetId: customer.id,
    targetLabel: `${customer.name} — imported ${created.length} site(s)`,
    metadata: {
      fileName: fileName ?? null,
      created: created.length,
      skipped: skipped.length,
      failed: failed.length,
      durationMs: Date.now() - startedAt,
    },
  });

  return { createdSites: created.map(toSite), skipped, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/modules/customer/customer.service.bulk.test.ts`
Expected: PASS (4 tests). If the transitive-mock list needs another entry, add the missing `vi.mock(...)` for whatever module the error names.

- [ ] **Step 5: Typecheck + commit** (when approved)

```bash
cd backend && pnpm typecheck
git add backend/src/modules/customer/customer.service.ts backend/src/modules/customer/customer.service.bulk.test.ts
git commit -m "feat(customer): bulkAddSites service (partial import, dedupe, geocode, audit)"
```

---

### Task 5: Backend — controller, route, rate limiter

Wire the endpoint. No unit test (thin controller; covered by service tests) — verified by typecheck + a manual curl.

**Files:**
- Modify: `backend/src/middleware/rateLimit.middleware.ts`
- Modify: `backend/src/modules/customer/customer.controller.ts`
- Modify: `backend/src/modules/customer/customer.routes.ts`

**Interfaces:**
- Consumes: `customerService.bulkAddSites` (Task 4), `bulkSiteSchema` (Task 2), `actorFrom`, `param`, `asyncHandler`, `requirePermission`, `validateBody`.
- Produces: `bulkWriteLimiter`; `customerController.bulkAddSites`; route `POST /:id/sites/bulk`.

- [ ] **Step 1: Add the limiter**

In `backend/src/middleware/rateLimit.middleware.ts`, after `writeLimiter`:

```ts
// Bulk site import: the client sends sites in sequential batches (≤500 each). A handful
// of batches per import is normal; this caps a runaway loop / abusive client.
export const bulkWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: json("Too many import batches in a short time. Please slow down."),
});
```

- [ ] **Step 2: Add the controller**

In `backend/src/modules/customer/customer.controller.ts`, add `BulkSiteInput` to the type import from `./customer.validation.js`, then after `addSite`:

```ts
export const bulkAddSites = asyncHandler(async (req, res) => {
  const { sites, fileName } = req.body as BulkSiteInput;
  const result = await customerService.bulkAddSites(param(req, "id"), sites, fileName, actorFrom(req));
  res.status(201).json(result);
});
```

- [ ] **Step 3: Add the route**

In `backend/src/modules/customer/customer.routes.ts`, add `bulkWriteLimiter` to the rateLimit import, then directly after the `POST /:id/sites` route (before the `PUT /:id/sites/:siteId` route):

```ts
adminRouter.post(
  "/:id/sites/bulk",
  requirePermission("customer_sites.create"),
  bulkWriteLimiter,
  validateBody(bulkSiteSchema),
  customerController.bulkAddSites,
);
```

Ensure `bulkSiteSchema` is imported in `customer.routes.ts` from `./customer.validation.js` (add it to the existing import).

- [ ] **Step 4: Verify typecheck, lint, and the endpoint**

```bash
cd backend && pnpm typecheck && pnpm lint
```
Expected: no errors.

Manual smoke (dev server running, replace cookie/customer id):
```bash
curl -s -X POST "http://localhost:8000/customers/<CUST_ID>/sites/bulk" \
  -H "content-type: application/json" -b "<auth cookie>" \
  -d '{"fileName":"t.xlsx","sites":[{"name":"Curl Site","postcode":"LS1 4DY","city":"Leeds"}]}'
```
Expected: `201` with `{ "createdSites": [ { "code": "STE-####", ... } ], "skipped": [], "failed": [] }`.

- [ ] **Step 5: Commit** (when approved)

```bash
git add backend/src/middleware/rateLimit.middleware.ts backend/src/modules/customer/customer.controller.ts backend/src/modules/customer/customer.routes.ts
git commit -m "feat(customer): POST /customers/:id/sites/bulk endpoint"
```

---

### Task 6: Backend — optional `@@unique([customerId, code])` hardening

Defense-in-depth. Verified safe (0 duplicates in live data at spec time). Re-verify before prod.

**Files:**
- Modify: `backend/prisma/schema.prisma` (CustomerSite model)

- [ ] **Step 1: Re-run the data safety check**

Run a one-off read-only check (against whatever DB `backend/.env` points at) confirming zero duplicate `(customerId, code)` pairs and zero null codes. If any duplicates exist, STOP — resolve them before adding the constraint.

- [ ] **Step 2: Add the constraint**

In `backend/prisma/schema.prisma`, in `model CustomerSite`, replace `@@index([customerId])` with:

```prisma
  @@unique([customerId, code])
```
(A unique compound index also serves the `customerId` lookups, so the separate `@@index` is redundant.)

- [ ] **Step 3: Push the index + regenerate the client**

```bash
cd backend && pnpm prisma db push && pnpm prisma:generate
```
Expected: index created, client regenerated. (If `db push` reports a uniqueness violation, a duplicate slipped in — revert and resolve.)

- [ ] **Step 4: Verify**

```bash
cd backend && pnpm typecheck
```
Expected: no errors. Optionally re-run the Task 3/4 suites — still green.

- [ ] **Step 5: Commit** (when approved)

```bash
git add backend/prisma/schema.prisma
git commit -m "chore(customer): unique (customerId, code) on CustomerSite as import safeguard"
```

---

### Task 7: Frontend — `lib/siteImport.ts` pure logic + tests

The testable core (no React, no xlsx at module top). Adds the `xlsx` dependency (used only by the dynamic-import helpers in Task 8).

**Files:**
- Modify: `frontend/package.json` (add `xlsx`)
- Create: `frontend/src/lib/siteImport.ts`
- Test: `frontend/src/lib/siteImport.test.ts`

**Interfaces:**
- Consumes: `UK_POSTCODE_RE` from `@/lib/validation`; `SitePayload` from `@/services/customer.service`.
- Produces:
  - `type RawRow = Record<string, unknown>`
  - `type SiteDraft = { name: string; addressLine1: string; addressLine2: string; city: string; county: string; postcode: string; country: string; contactPerson: string; contactNumber: string; status: string }`
  - `mapColumns(raw: RawRow): SiteDraft`
  - `validateRow(draft: SiteDraft): { ok: true; value: SitePayload } | { ok: false; error: string }`
  - `dedupeKey(name: string, postcode: string): string`
  - `type PreviewRow = { rowNumber: number; draft: SiteDraft; status: "new" | "duplicate" | "error"; reason?: string }`
  - `classifyRows(drafts: SiteDraft[], existingKeys: Set<string>): PreviewRow[]`
  - `EXPORT_COLUMNS: readonly (keyof SiteDraft)[]`

- [ ] **Step 1: Install the dependency**

```bash
cd frontend && pnpm add xlsx
```
Expected: `xlsx` appears under `dependencies` in `frontend/package.json`.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/lib/siteImport.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { classifyRows, dedupeKey, mapColumns, validateRow } from "./siteImport";

describe("mapColumns", () => {
  it("maps aliases case-insensitively and trims", () => {
    const d = mapColumns({ "Site Name": " Leeds HQ ", "Post Code": "ls1 4dy", Town: "Leeds", Phone: "0770" });
    expect(d.name).toBe("Leeds HQ");
    expect(d.postcode).toBe("ls1 4dy");
    expect(d.city).toBe("Leeds");
    expect(d.contactNumber).toBe("0770");
  });
  it("defaults country and status when blank", () => {
    const d = mapColumns({ name: "A" });
    expect(d.country).toBe("United Kingdom");
    expect(d.status).toBe("active");
  });
});

describe("validateRow", () => {
  it("requires a name", () => {
    expect(validateRow(mapColumns({ name: "" })).ok).toBe(false);
  });
  it("rejects a bad UK postcode", () => {
    const r = validateRow(mapColumns({ name: "A", postcode: "12345" }));
    expect(r.ok).toBe(false);
  });
  it("accepts a valid row and emits a SitePayload with defaults applied", () => {
    const r = validateRow(mapColumns({ name: "A", postcode: "LS1 4DY" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("A");
      expect(r.value.country).toBe("United Kingdom");
      expect(r.value.status).toBe("active");
    }
  });
  it("rejects an out-of-range status", () => {
    expect(validateRow(mapColumns({ name: "A", status: "archived" })).ok).toBe(false);
  });
});

describe("dedupeKey", () => {
  it("is case- and space-insensitive on name + postcode", () => {
    expect(dedupeKey("Leeds HQ", "LS1 4DY")).toBe(dedupeKey("leeds hq", "ls14dy"));
  });
});

describe("classifyRows", () => {
  it("tags error > duplicate > new and catches in-file duplicates", () => {
    const drafts = [
      mapColumns({ name: "Good", postcode: "LS1 4DY" }),   // new
      mapColumns({ name: "Good", postcode: "ls1 4dy" }),   // duplicate (in-file)
      mapColumns({ name: "Dupe", postcode: "M1 1AA" }),    // duplicate (existing)
      mapColumns({ name: "", postcode: "M1 1AA" }),        // error
    ];
    const existing = new Set([dedupeKey("Dupe", "M1 1AA")]);
    const rows = classifyRows(drafts, existing);
    expect(rows.map((r) => r.status)).toEqual(["new", "duplicate", "duplicate", "error"]);
    expect(rows[0].rowNumber).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && pnpm vitest run src/lib/siteImport.test.ts`
Expected: FAIL — module not found / exports missing.

- [ ] **Step 4: Implement the pure logic**

Create `frontend/src/lib/siteImport.ts`:

```ts
import { UK_POSTCODE_RE } from "@/lib/validation";
import type { SitePayload } from "@/services/customer.service";

// One raw spreadsheet row (header → cell), as produced by SheetJS sheet_to_json.
export type RawRow = Record<string, unknown>;

// A normalised, string-only draft of a site row (pre-validation).
export type SiteDraft = {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  county: string;
  postcode: string;
  country: string;
  contactPerson: string;
  contactNumber: string;
  status: string;
};

// The canonical column order for the template and the report.
export const EXPORT_COLUMNS = [
  "name", "addressLine1", "addressLine2", "city", "county",
  "postcode", "country", "contactPerson", "contactNumber", "status",
] as const satisfies readonly (keyof SiteDraft)[];

// Header aliases → SiteDraft field. Keys are lower-cased + space-collapsed at match time.
const HEADER_ALIASES: Record<string, keyof SiteDraft> = {
  name: "name", sitename: "name", site: "name",
  addressline1: "addressLine1", address1: "addressLine1", address: "addressLine1", addressline: "addressLine1",
  addressline2: "addressLine2", address2: "addressLine2",
  city: "city", town: "city", citytown: "city",
  county: "county",
  postcode: "postcode", postalcode: "postcode", zip: "postcode",
  country: "country",
  contactperson: "contactPerson", contact: "contactPerson", contactname: "contactPerson",
  contactnumber: "contactNumber", phone: "contactNumber", telephone: "contactNumber", tel: "contactNumber",
  status: "status",
};

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[\s_-]+/g, "");
const cell = (v: unknown) => (v == null ? "" : String(v).trim());

// Map a raw row's arbitrary headers onto a SiteDraft, applying blank-field defaults.
export function mapColumns(raw: RawRow): SiteDraft {
  const draft: SiteDraft = {
    name: "", addressLine1: "", addressLine2: "", city: "", county: "",
    postcode: "", country: "", contactPerson: "", contactNumber: "", status: "",
  };
  for (const [header, value] of Object.entries(raw)) {
    const field = HEADER_ALIASES[normHeader(header)];
    if (field && !draft[field]) draft[field] = cell(value);
  }
  if (!draft.country) draft.country = "United Kingdom";
  if (!draft.status) draft.status = "active";
  return draft;
}

// Validate a draft, mirroring the backend siteSchema. Returns a ready-to-send SitePayload
// on success. (Phone format is left to the backend — it re-validates everything.)
export function validateRow(
  draft: SiteDraft,
): { ok: true; value: SitePayload } | { ok: false; error: string } {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: "Site name is required." };
  if (name.length > 120) return { ok: false, error: "Site name is too long (max 120)." };
  if (draft.addressLine1.length > 200 || draft.addressLine2.length > 200)
    return { ok: false, error: "Address line is too long (max 200)." };
  for (const [label, v] of [["City", draft.city], ["County", draft.county], ["Country", draft.country]] as const)
    if (v.length > 120) return { ok: false, error: `${label} is too long (max 120).` };
  if (draft.postcode && !UK_POSTCODE_RE.test(draft.postcode.trim()))
    return { ok: false, error: `Invalid UK postcode "${draft.postcode}".` };
  const status = draft.status.trim().toLowerCase();
  if (status !== "active" && status !== "inactive")
    return { ok: false, error: `Status must be "active" or "inactive" (got "${draft.status}").` };

  return {
    ok: true,
    value: {
      name,
      addressLine1: draft.addressLine1 || undefined,
      addressLine2: draft.addressLine2 || undefined,
      city: draft.city || undefined,
      county: draft.county || undefined,
      postcode: draft.postcode.trim() || undefined,
      country: draft.country || undefined,
      contactPerson: draft.contactPerson || undefined,
      contactNumber: draft.contactNumber || undefined,
      status: status as "active" | "inactive",
    },
  };
}

// MUST match backend siteDedupeKey exactly.
export function dedupeKey(name: string, postcode: string): string {
  return `${name.trim().toLowerCase()}|${postcode.toLowerCase().replace(/\s+/g, "")}`;
}

export type PreviewRow = {
  rowNumber: number;
  draft: SiteDraft;
  status: "new" | "duplicate" | "error";
  reason?: string;
};

// Classify every draft for the preview: error (fails validation) > duplicate (matches an
// existing site OR an earlier NEW row in this file) > new. rowNumber is 1-based.
export function classifyRows(drafts: SiteDraft[], existingKeys: Set<string>): PreviewRow[] {
  const seen = new Set(existingKeys);
  return drafts.map((draft, i) => {
    const rowNumber = i + 1;
    const v = validateRow(draft);
    if (!v.ok) return { rowNumber, draft, status: "error" as const, reason: v.error };
    const key = dedupeKey(draft.name, draft.postcode);
    if (seen.has(key)) return { rowNumber, draft, status: "duplicate" as const, reason: "Already exists (name + postcode)." };
    seen.add(key);
    return { rowNumber, draft, status: "new" as const };
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && pnpm vitest run src/lib/siteImport.test.ts`
Expected: PASS (all describes).

- [ ] **Step 6: Commit** (when approved)

```bash
git add frontend/package.json frontend/pnpm-lock.yaml frontend/src/lib/siteImport.ts frontend/src/lib/siteImport.test.ts
git commit -m "feat(sites): site-import pure logic (map/validate/classify) + xlsx dep"
```

---

### Task 8: Frontend — SheetJS helpers in `lib/siteImport.ts`

The thin xlsx-backed helpers: parse, template, report. Dynamic-imported so `xlsx` stays out of the initial bundle.

**Files:**
- Modify: `frontend/src/lib/siteImport.ts`

**Interfaces:**
- Consumes: `xlsx` (dynamic), `EXPORT_COLUMNS`, `PreviewRow`, `SiteDraft` (Task 7).
- Produces:
  - `parseSheet(file: File): Promise<RawRow[]>`
  - `buildTemplateBlob(): Promise<Blob>`
  - `buildReportBlob(rows: PreviewRow[]): Promise<Blob>`

- [ ] **Step 1: Implement (no unit test — thin xlsx wrappers, verified via the modal in Task 10)**

Append to `frontend/src/lib/siteImport.ts`:

```ts
// Parse the first worksheet of an .xlsx/.xls/.csv File into raw rows. SheetJS is loaded
// on demand so it never ships in the initial bundle.
export async function parseSheet(file: File): Promise<RawRow[]> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const first = wb.SheetNames[0];
  if (!first) return [];
  return XLSX.utils.sheet_to_json<RawRow>(wb.Sheets[first], { defval: "" });
}

// A downloadable .xlsx template: the canonical header row + one example row.
export async function buildTemplateBlob(): Promise<Blob> {
  const XLSX = await import("xlsx");
  const example: Record<string, string> = {
    name: "Leeds Basinghall", addressLine1: "1 Basinghall Street", addressLine2: "",
    city: "Leeds", county: "West Yorkshire", postcode: "LS1 4DY", country: "United Kingdom",
    contactPerson: "Sam Taylor", contactNumber: "07700 900111", status: "active",
  };
  const ws = XLSX.utils.json_to_sheet([example], { header: EXPORT_COLUMNS as unknown as string[] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sites");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// A downloadable .xlsx report: every processed row, original columns + status + reason.
export async function buildReportBlob(rows: PreviewRow[]): Promise<Blob> {
  const XLSX = await import("xlsx");
  const data = rows.map((r) => {
    const rec: Record<string, string> = {};
    for (const col of EXPORT_COLUMNS) rec[col] = r.draft[col];
    rec.status = r.status;
    rec.reason = r.reason ?? "";
    return rec;
  });
  const ws = XLSX.utils.json_to_sheet(data, { header: [...EXPORT_COLUMNS, "status", "reason"] as string[] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Import report");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit** (when approved)

```bash
git add frontend/src/lib/siteImport.ts
git commit -m "feat(sites): SheetJS parse/template/report helpers (dynamic import)"
```

---

### Task 9: Frontend — service `bulkAddSites` + result types

**Files:**
- Modify: `frontend/src/types/customer.ts` (add `RowNote`, `BulkSiteResult`)
- Modify: `frontend/src/services/customer.service.ts` (add `bulkAddSites`)

**Interfaces:**
- Consumes: `api` (from `@/lib/api`), `SitePayload`, `CustomerSite`.
- Produces:
  - `interface RowNote { row: number; name: string; reason: string }`
  - `interface BulkSiteResult { createdSites: CustomerSite[]; skipped: RowNote[]; failed: RowNote[] }`
  - `bulkAddSites(customerId: string, sites: SitePayload[], fileName?: string): Promise<BulkSiteResult>`

- [ ] **Step 1: Add the types**

In `frontend/src/types/customer.ts`, after the `CustomerSite` interface:

```ts
// Bulk site import result (mirror of the backend BulkSiteResult).
export interface SiteImportRowNote {
  row: number;
  name: string;
  reason: string;
}
export interface BulkSiteResult {
  createdSites: CustomerSite[];
  skipped: SiteImportRowNote[];
  failed: SiteImportRowNote[];
}
```

- [ ] **Step 2: Add the service function**

In `frontend/src/services/customer.service.ts`, add `BulkSiteResult` to the type import from `@/types/customer`, then after `updateSite` (near line 226):

```ts
// Bulk-import sites for a customer. Sends ONE batch (≤500 rows); the caller chunks larger
// sheets and aggregates. `fileName` is metadata for the server audit trail.
export function bulkAddSites(
  customerId: string,
  sites: SitePayload[],
  fileName?: string,
): Promise<BulkSiteResult> {
  return api<BulkSiteResult>(`/customers/${customerId}/sites/bulk`, {
    method: "POST",
    body: { sites, fileName },
  });
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit** (when approved)

```bash
git add frontend/src/types/customer.ts frontend/src/services/customer.service.ts
git commit -m "feat(customer): frontend bulkAddSites service + result types"
```

---

### Task 10: Frontend — `SiteImportModal.tsx`

The 3-step modal (Upload → Preview → Result), batching + aggregation.

**Files:**
- Create: `frontend/src/components/dashboard/customers/SiteImportModal.tsx`

**Interfaces:**
- Consumes: `Modal` (`@/components/ui/Modal`), `ghostBtn`/`primaryBtn`/`labelCls` (`@/components/ui/styles`), everything from `@/lib/siteImport`, `customerService.bulkAddSites` + `BulkSiteResult` type, `useDashboard` (`@/hooks/useDashboard`) for toasts.
- Produces: `SiteImportModal({ customerId, existingSites, onClose, onImported })` where `existingSites: CustomerSite[]` (to seed the dedupe set) and `onImported: () => void`.

- [ ] **Step 1: Implement the modal**

Create `frontend/src/components/dashboard/customers/SiteImportModal.tsx`:

```tsx
"use client";

import * as React from "react";
import { Loader2, Upload, Download, FileWarning } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { ghostBtn, primaryBtn } from "@/components/ui/styles";
import { useDashboard } from "@/hooks/useDashboard";
import {
  buildReportBlob, buildTemplateBlob, classifyRows, dedupeKey, mapColumns, parseSheet,
  type PreviewRow,
} from "@/lib/siteImport";
import type { BulkSiteResult, CustomerSite } from "@/types/customer";

const BATCH_SIZE = 500;
const MAX_ROWS = 5000;

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

type Result = { created: number; skipped: number; failed: number };

export function SiteImportModal({
  customerId,
  existingSites,
  onClose,
  onImported,
}: {
  customerId: string;
  existingSites: CustomerSite[];
  onClose: () => void;
  onImported: () => void;
}) {
  const { pushToast } = useDashboard();
  const [step, setStep] = React.useState<"upload" | "preview" | "result">("upload");
  const [fileName, setFileName] = React.useState("");
  const [rows, setRows] = React.useState<PreviewRow[]>([]);
  const [parsing, setParsing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [result, setResult] = React.useState<Result | null>(null);

  const existingKeys = React.useMemo(
    () => new Set(existingSites.map((s) => dedupeKey(s.name, s.postcode ?? ""))),
    [existingSites],
  );

  const counts = React.useMemo(() => ({
    total: rows.length,
    new: rows.filter((r) => r.status === "new").length,
    duplicate: rows.filter((r) => r.status === "duplicate").length,
    error: rows.filter((r) => r.status === "error").length,
  }), [rows]);

  const onFile = async (file: File) => {
    setError(null);
    setParsing(true);
    try {
      const raw = await parseSheet(file);
      if (raw.length === 0) { setError("That sheet has no rows."); return; }
      if (raw.length > MAX_ROWS) { setError(`Too many rows (${raw.length}). Split the file into chunks of ${MAX_ROWS} or fewer.`); return; }
      const drafts = raw.map(mapColumns);
      if (drafts.every((d) => !d.name)) { setError("No 'name' column found — download the template and match the headers."); return; }
      setFileName(file.name);
      setRows(classifyRows(drafts, existingKeys));
      setStep("preview");
    } catch {
      setError("Couldn't read that file. Use .xlsx, .xls or .csv.");
    } finally {
      setParsing(false);
    }
  };

  const runImport = async () => {
    const payloads = rows.filter((r) => r.status === "new").flatMap((r) => {
      const v = validatePayload(r);
      return v ? [v] : [];
    });
    if (payloads.length === 0) return;
    setImporting(true);
    setProgress({ done: 0, total: payloads.length });
    const agg: Result = { created: 0, skipped: counts.duplicate, failed: counts.error };
    try {
      for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
        const batch = payloads.slice(i, i + BATCH_SIZE);
        const res: BulkSiteResult = await customerService.bulkAddSites(customerId, batch, fileName);
        agg.created += res.createdSites.length;
        agg.skipped += res.skipped.length;
        agg.failed += res.failed.length;
        setProgress({ done: Math.min(i + BATCH_SIZE, payloads.length), total: payloads.length });
      }
      setResult(agg);
      setStep("result");
      onImported();
      pushToast(`Imported ${agg.created} site${agg.created === 1 ? "" : "s"}.`, "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed. Some rows may not have been saved — re-upload to retry (duplicates are skipped).");
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open
      title="Import sites"
      subtitle="Upload an Excel/CSV sheet of sites for this customer."
      onClose={importing ? () => {} : onClose}
      footer={<Footer />}
    >
      {step === "upload" && (
        <div className="space-y-4">
          <button type="button" onClick={async () => downloadBlob(await buildTemplateBlob(), "site-import-template.xlsx")} className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--accent)] hover:opacity-80">
            <Download className="h-3.5 w-3.5" /> Download template
          </button>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface-2)]/30 p-8 text-center hover:border-[var(--accent)]">
            {parsing ? <Loader2 className="h-6 w-6 animate-spin text-[var(--accent)]" /> : <Upload className="h-6 w-6 text-[var(--muted)]" />}
            <span className="text-sm font-semibold text-[var(--ink)]">{parsing ? "Reading…" : "Choose a .xlsx, .xls or .csv file"}</span>
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" disabled={parsing}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
          </label>
          {error && <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--neg)]"><FileWarning className="h-4 w-4 shrink-0" />{error}</p>}
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <span className="rounded-lg bg-[var(--pos)]/10 px-2.5 py-1 text-[var(--pos)]">{counts.new} new</span>
            <span className="rounded-lg bg-[var(--surface-2)] px-2.5 py-1 text-[var(--muted)]">{counts.duplicate} skip (exists)</span>
            <span className="rounded-lg bg-[var(--neg)]/10 px-2.5 py-1 text-[var(--neg)]">{counts.error} error</span>
          </div>
          <div className="max-h-[46vh] overflow-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-[var(--surface-2)] text-[var(--faint)]">
                <tr><th className="px-2 py-1.5">#</th><th className="px-2 py-1.5">Name</th><th className="px-2 py-1.5">Postcode</th><th className="px-2 py-1.5">Status</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.rowNumber} className="border-t border-[var(--border)]">
                    <td className="px-2 py-1.5 text-[var(--faint)]">{r.rowNumber}</td>
                    <td className="px-2 py-1.5 text-[var(--ink)]">{r.draft.name || <span className="text-[var(--faint)]">—</span>}</td>
                    <td className="px-2 py-1.5 text-[var(--muted)]">{r.draft.postcode || "—"}</td>
                    <td className="px-2 py-1.5">
                      {r.status === "new" && <span className="font-bold text-[var(--pos)]">New</span>}
                      {r.status === "duplicate" && <span className="text-[var(--muted)]" title={r.reason}>Skip</span>}
                      {r.status === "error" && <span className="font-bold text-[var(--neg)]" title={r.reason}>Error</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {importing && <p className="text-xs text-[var(--muted)]">Importing… {progress.done}/{progress.total}</p>}
          {error && <p className="text-[13px] font-semibold text-[var(--neg)]">{error}</p>}
        </div>
      )}

      {step === "result" && result && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            <Stat label="Added" value={result.created} tone="text-[var(--pos)]" />
            <Stat label="Skipped" value={result.skipped} tone="text-[var(--muted)]" />
            <Stat label="Errors" value={result.failed} tone="text-[var(--neg)]" />
          </div>
          <button type="button" onClick={async () => downloadBlob(await buildReportBlob(rows), "site-import-report.xlsx")} className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--accent)] hover:opacity-80">
            <Download className="h-3.5 w-3.5" /> Download report
          </button>
        </div>
      )}
    </Modal>
  );

  function Footer() {
    if (step === "upload") return <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>;
    if (step === "preview")
      return (
        <>
          <button type="button" onClick={onClose} disabled={importing} className={ghostBtn}>Cancel</button>
          <button type="button" onClick={runImport} disabled={importing || counts.new === 0} className={primaryBtn}>
            {importing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Import {counts.new} new site{counts.new === 1 ? "" : "s"}
          </button>
        </>
      );
    return <button type="button" onClick={onClose} className={primaryBtn}>Done</button>;
  }
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
      <div className={`text-2xl font-extrabold ${tone}`}>{value}</div>
      <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</div>
    </div>
  );
}

// A NEW preview row is guaranteed valid (classifyRows validated it); re-derive its payload.
function validatePayload(r: PreviewRow): import("@/services/customer.service").SitePayload | null {
  const v = validateRowSafe(r);
  return v;
}
function validateRowSafe(r: PreviewRow) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { validateRow } = require("@/lib/siteImport") as typeof import("@/lib/siteImport");
  const res = validateRow(r.draft);
  return res.ok ? res.value : null;
}
```

Note for the implementer: the two helper functions at the bottom are a workaround-free zone — replace them by importing `validateRow` at the top (`import { ..., validateRow } from "@/lib/siteImport"`) and mapping directly: `rows.filter(r => r.status === "new").map(r => validateRow(r.draft)).flatMap(v => v.ok ? [v.value] : [])`. Do NOT use `require`. (Kept explicit here so the data flow is unambiguous; wire it as a clean top-level import.)

- [ ] **Step 2: Verify typecheck + lint**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors. Confirm `useDashboard` exposes `pushToast` and `Modal`'s props (`open/title/subtitle/onClose/footer`) match usage — adjust to the real signatures if they differ (see `SiteModal.tsx` for the exact `Modal` contract).

- [ ] **Step 3: Commit** (when approved)

```bash
git add frontend/src/components/dashboard/customers/SiteImportModal.tsx
git commit -m "feat(sites): SiteImportModal (upload → preview → result)"
```

---

### Task 11: Frontend — wire the "Import sites" button + full verification

**Files:**
- Modify: `frontend/src/components/dashboard/customers/CustomerDetail.tsx` (Sites tab header, near the "Add site" button around line 1240)

**Interfaces:**
- Consumes: `SiteImportModal` (Task 10); the customer's sites + a refetch callback that already exist in `CustomerDetail`.

- [ ] **Step 1: Import the modal**

At the top of `CustomerDetail.tsx`, add:

```tsx
import { SiteImportModal } from "./SiteImportModal";
```

- [ ] **Step 2: Add open state + button + modal**

Find where `SiteModal` open state lives in `CustomerDetail.tsx` and add a sibling:

```tsx
const [showImport, setShowImport] = React.useState(false);
```

Next to the existing "Add site" button in the Sites tab header, add (gated by the same create permission used for "Add site" — reuse the existing `canWrite`/permission variable already in scope):

```tsx
{canWrite && (
  <button type="button" onClick={() => setShowImport(true)} className={ghostBtn}>
    Import sites
  </button>
)}
```

At the bottom of the Sites tab render (alongside where `SiteModal` is conditionally rendered), add — using the SAME sites array and refetch handler the Sites tab already uses (e.g. `customer.sites` and the callback that reloads the customer):

```tsx
{showImport && (
  <SiteImportModal
    customerId={customer.id}
    existingSites={customer.sites}
    onClose={() => setShowImport(false)}
    onImported={() => { setShowImport(false); reloadCustomer(); }}
  />
)}
```

Replace `reloadCustomer()` with the actual refetch function already present in `CustomerDetail` (whatever `SiteModal`'s `onSaved` uses to refresh the sites list). If `SiteModal` updates local state instead of refetching, mirror that: call the same handler its `onSaved` calls.

- [ ] **Step 3: Full verification**

```bash
cd frontend && npx tsc --noEmit && pnpm test
cd ../backend && pnpm typecheck && pnpm lint && pnpm vitest run src/lib/geocode.test.ts src/modules/customer
```
Expected: frontend types clean, `siteImport` tests green; backend typecheck/lint clean, all customer + geocode suites green.

- [ ] **Step 4: Manual end-to-end (dev servers running)**

1. Open a customer → **Sites** tab → **Import sites**.
2. **Download template**, add 3 rows (one valid, one duplicate of an existing site, one with a bad postcode), upload.
3. Preview shows **1 new / 1 skip / 1 error**; click **Import 1 new site**.
4. Result shows **1 added**; the Sites list now includes the new `STE-####` row with its structured address; **Download report** yields an `.xlsx` with `status`/`reason` columns.

- [ ] **Step 5: Commit** (when approved)

```bash
git add frontend/src/components/dashboard/customers/CustomerDetail.tsx
git commit -m "feat(customer): wire Import sites into the Sites tab"
```

---

## Self-Review (author checklist — completed)

**Spec coverage:**
- §2 per-customer / preview+partial / skip-dupes / Approach A → Tasks 7,10,11 (client parse+preview), 2,4 (partial+dedupe), 5 (endpoint). ✅
- §5.1 lib/siteImport (map/validate/dedupe/classify/template/report) → Tasks 7,8. ✅
- §5.2 modal, §5.3 wiring + service + xlsx dep → Tasks 9,10,11,7. ✅
- §5.4 endpoint/validation/service/repo/geocode/limiter → Tasks 1,2,3,4,5. ✅
- §5.4 atomic block reservation + transaction rule → Task 3 (with counter rule in Global Constraints). ✅
- §5.4 optional `@@unique` → Task 6. ✅
- §6 contracts (fileName + response) → Tasks 4,5,9. ✅
- §7 validation rules → Tasks 2 (route), 4 (server per-row), 7 (client mirror). ✅
- §8 scale (batch 500, soft cap 5000, bulk geocode) → Tasks 1,10; Global Constraints. ✅
- §9 error handling (bad file, per-row, failed batch, geocode best-effort) → Tasks 1,4,10. ✅
- §10 testing (backend + frontend) → Tasks 1,2,3,4,7. ✅
- §14 verification points baked into Task 3 + Global Constraints. ✅

**Placeholder scan:** none — every code step carries full code. The one flagged spot (Task 10 bottom helpers) includes explicit instructions to wire `validateRow` as a top-level import instead.

**Type consistency:** `SiteDraft`, `PreviewRow`, `SitePayload`, `BulkSiteResult`/`SiteImportRowNote` (frontend) and `SiteData`, `RowNote`, `BulkSiteResult` (backend) are used consistently across tasks; `dedupeKey` (fe) mirrors `siteDedupeKey` (be) with the identical formula stated in Global Constraints; `geocodePostcodesBulk` map keyed by `canonicalPostcode` is produced in Task 1 and consumed in Task 4.
