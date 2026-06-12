# Global Stock Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace free-text catalogue-item categories with a single global, admin-managed Category master list that every catalogue item references by ID.

**Architecture:** A new `category` backend module (full vertical slice cloned from the `role` module) exposes CRUD at `/categories`, guarded by a new `categories.*` permission group. `CustomerCatalogueItem` gains a **required** `categoryId` relation (free-text `category` removed). Categories apply **only to catalogue items** — stock requests do not involve categories at all: the vestigial free-text `category` field is removed from the stock request (model/validation/service/portal modal), and approval remains a status move that never creates a catalogue item. Frontend: a Settings → Categories management screen (cloned from `DepartmentsView`), and the catalogue-item form switches from a free-text input to a required category dropdown.

**Tech Stack:** Express 5, Prisma (MongoDB), zod, vitest (backend); Next.js 16, React 19, axios, Tailwind v4 (frontend). Backend pnpm, Node ≥20, ESM/NodeNext (relative imports need `.js`; cross-module uses `#modules/*`).

---

## Spec

Design doc: [docs/superpowers/specs/2026-06-12-global-stock-categories-design.md](../specs/2026-06-12-global-stock-categories-design.md)

## Critical conventions (read before coding)

- **ESM `.js` extensions:** every relative import ends in `.js` even though source is `.ts` (e.g. `import { prisma } from "../../lib/prisma.js"`). Cross-module imports use the alias: `import * as audit from "#modules/audit/audit.service.js"`. Same-module imports stay relative (`./category.service.js`).
- **Layering:** route → middleware → controller → service → repository → Prisma. Prisma is touched ONLY in repositories. Controllers hold no logic. Services throw `HttpError` (via `badRequest`/`conflict`/`notFound`/`forbidden` from `../../utils/http-error.js`).
- **Backend tests:** vitest IS configured (`pnpm test`). Pure logic (validation schemas) gets real vitest tests. DB/repository + frontend verified via `pnpm typecheck` + `pnpm lint` + `pnpm build` + manual.
- **No `pnpm test` for DB code:** existing tests are pure (no DB). Do NOT add DB-hitting tests.
- **Frontend Next.js is customized** — but this plan adds no new routing/server-component patterns; it edits existing client components and adds a settings section, so no `node_modules/next/dist/docs/` reading is required for these specific edits.

## File structure

**Backend — create:**
- `backend/src/modules/category/category.validation.ts` — zod schemas (pure; tested)
- `backend/src/modules/category/category.repository.ts` — Prisma access only
- `backend/src/modules/category/category.service.ts` — business logic + guards
- `backend/src/modules/category/category.controller.ts` — thin handlers
- `backend/src/modules/category/category.routes.ts` — routes + middleware
- `backend/src/modules/category/category.validation.test.ts` — vitest

**Backend — modify:**
- `backend/prisma/schema.prisma` — add `Category` model; change `CustomerCatalogueItem` (drop `category`, add required `categoryId`)
- `backend/src/modules/role/permissions.ts` — add `categories` permission group
- `backend/src/routes/index.ts` — mount `/categories`
- `backend/src/modules/customer/customer.validation.ts` — `catalogueItemSchema`: `category` → `categoryId`; `stockRequestSchema`: REMOVE the `category` field
- `backend/src/modules/customer/customer.repository.ts` — catalogue create/update: `category` → `categoryId`; include category relation on reads; `StockRequestData` + `createStockRequest`: REMOVE `category`
- `backend/src/modules/customer/customer.service.ts` — catalogue normalize/types/mapper + validate active category; `StockRequestInput`/`toStockRequestData`/`toStockRequest`/`PublicStockRequest`: REMOVE `category`
- `backend/prisma/schema.prisma` (CustomerStockRequest) — REMOVE the `category String?` field (line 343)
- `backend/src/db/seed.ts` — stop seeding free-text `category` on catalogue items (and seed a few categories); remove any `category` from seeded stock requests

**Frontend — create:**
- `frontend/src/types/category.ts`
- `frontend/src/services/category.service.ts`
- `frontend/src/components/dashboard/settings/categories/CategoriesView.tsx`

**Frontend — modify:**
- `frontend/src/components/dashboard/settings/SettingsPanel.tsx` — add Categories section
- `frontend/src/components/dashboard/shell/Sidebar.tsx` — add `categories.view` to Settings nav perms
- `frontend/src/components/dashboard/customers/CatalogueItemModal.tsx` — free-text → required dropdown (`categoryId`)
- `frontend/src/components/dashboard/customers/CustomerDetail.tsx` — drop category derivation; display category name; pass categories to modal
- `frontend/src/components/dashboard/stock/MyStockView.tsx` — display category name from relation
- `frontend/src/services/customer.service.ts` — `CatalogueItemPayload.category` → `categoryId`; `submitStockRequest` payload: REMOVE `category`
- `frontend/src/types/customer.ts` — `CatalogueItem`/`CustomerStockItem` read shape: nested `category {id,name}`; payload `categoryId`; `StockRequest` type: REMOVE `category` (line 74)
- `frontend/src/components/dashboard/stock/StockRequestModal.tsx` — REMOVE the category field (state/input/payload)

---

## Phase 1 — Backend foundation (schema + permissions)

### Task 1: Add Category model and required relation to Prisma schema

**Files:**
- Modify: `backend/prisma/schema.prisma`

- [ ] **Step 1: Add the `Category` model**

Add this block near the other top-level models (e.g. just after the `Role` model around line 87):

```prisma
model Category {
  id          String   @id @default(auto()) @map("_id") @db.ObjectId
  key         String   @unique // auto slug from name: "Optical" -> "optical"
  name        String // display; unique case-insensitive (enforced in service)
  description String?
  status      String   @default("active") // active | inactive
  sortOrder   Int      @default(0)
  items       CustomerCatalogueItem[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

- [ ] **Step 2: Change `CustomerCatalogueItem` — drop `category`, add required `categoryId`**

In the `CustomerCatalogueItem` model, replace the line `category String // e.g. "Optical" | "Core"` with:

```prisma
  categoryId      String   @db.ObjectId
  category        Category @relation(fields: [categoryId], references: [id])
```

Then add this index next to the existing `@@index([customerId])`:

```prisma
  @@index([categoryId])
```

Leave `CustomerStockRequest.category` (the free-text request hint) **unchanged**.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `cd backend && pnpm prisma:generate`
Expected: "Generated Prisma Client" with no errors. (This makes `Category` and `categoryId` available to TypeScript.)

- [ ] **Step 4: Commit**

```bash
cd backend
git add prisma/schema.prisma
git commit -m "feat(category): add Category model and required categoryId relation"
```

---

### Task 2: Add the `categories` permission group

**Files:**
- Modify: `backend/src/modules/role/permissions.ts:89` (after the `customers` group)

- [ ] **Step 1: Insert the `categories` group**

In `PERMISSION_GROUPS`, immediately after the `customers` group object (which ends around line 89 with `]},`) and before the `audit` group, insert:

```ts
  {
    key: "categories",
    label: "Categories",
    description: "The global stock-category master list used to tag catalogue items.",
    permissions: [
      { key: "categories.view", action: "View", description: "View stock categories." },
      { key: "categories.create", action: "Create", description: "Add new stock categories." },
      { key: "categories.edit", action: "Edit", description: "Edit stock categories." },
      { key: "categories.delete", action: "Delete", description: "Delete stock categories." },
    ],
  },
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd backend && pnpm typecheck`
Expected: no errors. (`PERMISSION_KEYS` now includes the 4 new keys automatically — they derive from `PERMISSION_GROUPS`.)

- [ ] **Step 3: Commit**

```bash
cd backend
git add src/modules/role/permissions.ts
git commit -m "feat(category): add categories permission group to RBAC catalog"
```

---

## Phase 2 — Backend category module (TDD where pure)

### Task 3: Category validation schemas (TDD)

**Files:**
- Create: `backend/src/modules/category/category.validation.ts`
- Test: `backend/src/modules/category/category.validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/category/category.validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createCategorySchema, updateCategorySchema } from "./category.validation.js";

describe("createCategorySchema", () => {
  it("accepts a valid category and trims the name", () => {
    const r = createCategorySchema.safeParse({ name: "  Optical  ", description: " fibre optics ", status: "active" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("Optical");
      expect(r.data.description).toBe("fibre optics");
      expect(r.data.status).toBe("active");
    }
  });

  it("requires a name", () => {
    const r = createCategorySchema.safeParse({ description: "x" });
    expect(r.success).toBe(false);
  });

  it("rejects a blank name", () => {
    const r = createCategorySchema.safeParse({ name: "   " });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const r = createCategorySchema.safeParse({ name: "Optical", status: "archived" });
    expect(r.success).toBe(false);
  });

  it("rejects a name longer than 60 chars", () => {
    const r = createCategorySchema.safeParse({ name: "x".repeat(61) });
    expect(r.success).toBe(false);
  });
});

describe("updateCategorySchema", () => {
  it("accepts a partial update (status only)", () => {
    const r = updateCategorySchema.safeParse({ status: "inactive" });
    expect(r.success).toBe(true);
  });

  it("rejects an empty-string name when provided", () => {
    const r = updateCategorySchema.safeParse({ name: "   " });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm test -- category.validation`
Expected: FAIL — cannot resolve `./category.validation.js` (module doesn't exist yet).

- [ ] **Step 3: Write the validation module**

Create `backend/src/modules/category/category.validation.ts`:

```ts
import { z } from "zod";

// Status mirrors every other model in the schema: a plain string constrained at the
// validation boundary (the schema deliberately uses no Prisma enums).
const statusEnum = z.enum(["active", "inactive"]);

export const createCategorySchema = z.object({
  name: z
    .string({ error: "Category name is required." })
    .trim()
    .min(1, "Category name is required.")
    .max(60),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1, "Category name can't be empty.").max(60).optional(),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && pnpm test -- category.validation`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd backend
git add src/modules/category/category.validation.ts src/modules/category/category.validation.test.ts
git commit -m "feat(category): add category validation schemas with tests"
```

---

### Task 4: Category repository

**Files:**
- Create: `backend/src/modules/category/category.repository.ts`

- [ ] **Step 1: Write the repository**

Create `backend/src/modules/category/category.repository.ts`:

```ts
import type { Category, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the Category model.

export function findMany(): Promise<Category[]> {
  return prisma.category.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export function findById(id: string): Promise<Category | null> {
  return prisma.category.findUnique({ where: { id } });
}

export function findByKey(key: string): Promise<Category | null> {
  return prisma.category.findUnique({ where: { key } });
}

// Case-insensitive lookup by display name — enforces name uniqueness (the `name`
// column itself isn't a unique index).
export function findByName(name: string): Promise<Category | null> {
  return prisma.category.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
}

export function create(data: Prisma.CategoryCreateInput): Promise<Category> {
  return prisma.category.create({ data });
}

export function update(id: string, data: Prisma.CategoryUpdateInput): Promise<Category> {
  return prisma.category.update({ where: { id }, data });
}

export function remove(id: string): Promise<Category> {
  return prisma.category.delete({ where: { id } });
}

// How many catalogue items reference this category — the in-use guard for delete.
export function countItems(categoryId: string): Promise<number> {
  return prisma.customerCatalogueItem.count({ where: { categoryId } });
}

// Grouped item counts for all categories at once (avoids per-category N+1 in the list).
export async function countItemsByCategoryMap(): Promise<Record<string, number>> {
  const groups = await prisma.customerCatalogueItem.groupBy({
    by: ["categoryId"],
    _count: { _all: true },
  });
  const map: Record<string, number> = {};
  for (const g of groups) if (g.categoryId) map[g.categoryId] = g._count._all;
  return map;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd backend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd backend
git add src/modules/category/category.repository.ts
git commit -m "feat(category): add category repository"
```

---

### Task 5: Category service

**Files:**
- Create: `backend/src/modules/category/category.service.ts`

- [ ] **Step 1: Write the service**

Create `backend/src/modules/category/category.service.ts`:

```ts
import type { Category, Prisma } from "@prisma/client";

import * as categoryRepo from "./category.repository.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { slugify } from "../../utils/slugify.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import type { CreateCategoryInput, UpdateCategoryInput } from "./category.validation.js";

export interface PublicCategory {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  sortOrder: number;
  itemCount: number;
  createdAt: string;
}

function toPublicCategory(c: Category, itemCount: number): PublicCategory {
  return {
    id: c.id,
    key: c.key,
    name: c.name,
    description: c.description,
    status: c.status ?? "active",
    sortOrder: c.sortOrder,
    itemCount,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listCategories(): Promise<PublicCategory[]> {
  const [categories, counts] = await Promise.all([
    categoryRepo.findMany(),
    categoryRepo.countItemsByCategoryMap(),
  ]);
  return categories.map((c) => toPublicCategory(c, counts[c.id] ?? 0));
}

// Resolve by database id (24-hex) or stable key.
const CATEGORY_OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export async function getCategory(idOrKey: string): Promise<PublicCategory> {
  const category = CATEGORY_OBJECT_ID_RE.test(idOrKey)
    ? await categoryRepo.findById(idOrKey)
    : await categoryRepo.findByKey(idOrKey);
  if (!category) throw notFound("Category not found.");
  return toPublicCategory(category, await categoryRepo.countItems(category.id));
}

export async function createCategory(
  input: CreateCategoryInput,
  actor?: AuditActor,
): Promise<PublicCategory> {
  const name = input.name.trim();
  if (!name) throw badRequest("Category name is required.");
  const baseKey = slugify(name);
  if (!baseKey) throw badRequest("Category name must contain letters or numbers.");

  if (await categoryRepo.findByName(name)) {
    throw conflict(`A category named "${name}" already exists.`);
  }
  let key = baseKey;
  for (let n = 2; await categoryRepo.findByKey(key); n++) key = `${baseKey}_${n}`;

  const created = await categoryRepo.create({
    key,
    name,
    description: input.description?.trim() || null,
    status: input.status ?? "active",
  });
  audit.record({
    actor,
    action: "category.created",
    targetType: "category",
    targetId: created.id,
    targetLabel: created.name,
  });
  return toPublicCategory(created, 0);
}

export async function updateCategory(
  id: string,
  input: UpdateCategoryInput,
  actor?: AuditActor,
): Promise<PublicCategory> {
  const category = await categoryRepo.findById(id);
  if (!category) throw notFound("Category not found.");

  const data: Prisma.CategoryUpdateInput = {};
  if (typeof input.name === "string" && input.name.trim()) {
    const name = input.name.trim();
    const clash = await categoryRepo.findByName(name);
    if (clash && clash.id !== id) throw conflict(`A category named "${name}" already exists.`);
    data.name = name;
  }
  if (typeof input.description === "string") {
    data.description = input.description.trim() || null;
  }
  if (typeof input.status === "string") {
    data.status = input.status;
  }

  const updated = await categoryRepo.update(id, data);
  audit.record({
    actor,
    action: "category.updated",
    targetType: "category",
    targetId: id,
    targetLabel: updated.name,
  });
  return toPublicCategory(updated, await categoryRepo.countItems(id));
}

export async function deleteCategory(id: string, actor?: AuditActor): Promise<void> {
  const category = await categoryRepo.findById(id);
  if (!category) throw notFound("Category not found.");

  const used = await categoryRepo.countItems(id);
  if (used > 0) {
    throw conflict(
      `This category is used by ${used} item${used === 1 ? "" : "s"}. Reassign them before deleting it.`,
    );
  }
  await categoryRepo.remove(id);
  audit.record({
    actor,
    action: "category.deleted",
    targetType: "category",
    targetId: id,
    targetLabel: category.name,
  });
}

// For other modules (the customer catalogue): assert a category id points to an
// existing ACTIVE category. Returns the category. Throws badRequest otherwise.
export async function requireActiveCategory(categoryId: string): Promise<Category> {
  if (!categoryId || !CATEGORY_OBJECT_ID_RE.test(categoryId)) {
    throw badRequest("Select a category.");
  }
  const category = await categoryRepo.findById(categoryId);
  if (!category) throw badRequest("Selected category no longer exists.");
  if ((category.status ?? "active") !== "active") {
    throw badRequest("Selected category is inactive.");
  }
  return category;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd backend && pnpm typecheck`
Expected: no errors. If `audit.record` signature differs, open `backend/src/modules/audit/audit.service.ts` and match the exact `AuditActor` + `record(...)` shape used by `role.service.ts` (it's the canonical caller).

- [ ] **Step 3: Commit**

```bash
cd backend
git add src/modules/category/category.service.ts
git commit -m "feat(category): add category service with in-use delete guard"
```

---

### Task 6: Category controller

**Files:**
- Create: `backend/src/modules/category/category.controller.ts`

- [ ] **Step 1: Write the controller**

Create `backend/src/modules/category/category.controller.ts`:

```ts
import * as categoryService from "./category.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type { CreateCategoryInput, UpdateCategoryInput } from "./category.validation.js";

// GET /categories
export const listCategories = asyncHandler(async (_req, res) => {
  res.json({ categories: await categoryService.listCategories() });
});

// GET /categories/:id  (id or key)
export const getCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.getCategory(param(req, "id"));
  res.json({ category });
});

// POST /categories
export const createCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.createCategory(req.body as CreateCategoryInput, actorFrom(req));
  res.status(201).json({ category });
});

// PUT /categories/:id
export const updateCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.updateCategory(
    param(req, "id"),
    req.body as UpdateCategoryInput,
    actorFrom(req),
  );
  res.json({ category });
});

// DELETE /categories/:id — blocked when the category is in use.
export const deleteCategory = asyncHandler(async (req, res) => {
  await categoryService.deleteCategory(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd backend && pnpm typecheck`
Expected: no errors. (Confirms `actorFrom`, `asyncHandler`, `param` import paths match — they're the same ones `role.controller.ts` uses.)

- [ ] **Step 3: Commit**

```bash
cd backend
git add src/modules/category/category.controller.ts
git commit -m "feat(category): add category controller"
```

---

### Task 7: Category routes + mount

**Files:**
- Create: `backend/src/modules/category/category.routes.ts`
- Modify: `backend/src/routes/index.ts`

- [ ] **Step 1: Write the routes**

Create `backend/src/modules/category/category.routes.ts`:

```ts
import { Router } from "express";

import * as categoryController from "./category.controller.js";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { createCategorySchema, updateCategorySchema } from "./category.validation.js";

const router = Router();

router.use(requireAuth);

// The category list is read by category-managers AND by the catalogue-item form's
// category picker (which staff reach via customers.edit), so either may read it.
router.get("/", requireAnyPermission("categories.view", "customers.edit"), categoryController.listCategories);
router.get("/:id", requireAnyPermission("categories.view", "categories.edit"), categoryController.getCategory);

router.post("/", requirePermission("categories.create"), writeLimiter, validateBody(createCategorySchema), categoryController.createCategory);
router.put("/:id", requirePermission("categories.edit"), writeLimiter, validateBody(updateCategorySchema), categoryController.updateCategory);
router.delete("/:id", requirePermission("categories.delete"), writeLimiter, categoryController.deleteCategory);

export default router;
```

- [ ] **Step 2: Mount the router in the aggregator**

In `backend/src/routes/index.ts`, add the import next to the other `#modules/*` route imports (keep alphabetical — after the customer import, around line 6):

```ts
import categoryRoutes from "#modules/category/category.routes.js";
```

Then add the mount next to the other `router.use(...)` lines (after `router.use("/roles", roleRoutes);` around line 25):

```ts
router.use("/categories", categoryRoutes);
```

- [ ] **Step 3: Verify typecheck + lint pass**

Run: `cd backend && pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 4: Manual smoke test**

Run: `cd backend && pnpm dev` (start the server). In another terminal, with an authenticated admin cookie (or via the frontend later), the endpoint `GET /categories` returns `{ "categories": [] }`. Stop the server after confirming it boots without errors.

- [ ] **Step 5: Commit**

```bash
cd backend
git add src/modules/category/category.routes.ts src/routes/index.ts
git commit -m "feat(category): add category routes and mount at /categories"
```

---

## Phase 3 — Backend catalogue integration

### Task 8: Catalogue validation — `category` → `categoryId`

**Files:**
- Modify: `backend/src/modules/customer/customer.validation.ts:124-151`
- Test: `backend/src/modules/customer/customer.validation.test.ts` (existing)

- [ ] **Step 1: Update the existing test for catalogueItemSchema**

In `backend/src/modules/customer/customer.validation.test.ts`, find the `catalogueItemSchema` describe block. Replace any `category: "Optical"` (or similar) in the valid-payload test with `categoryId: "0123456789abcdef01234567"`, and add these cases inside that describe block:

```ts
  it("requires categoryId", () => {
    const r = catalogueItemSchema.safeParse({ name: "SFP", sku: "SFP-LX" });
    expect(r.success).toBe(false);
  });

  it("rejects a blank categoryId", () => {
    const r = catalogueItemSchema.safeParse({ name: "SFP", sku: "SFP-LX", categoryId: "  " });
    expect(r.success).toBe(false);
  });

  it("accepts a 24-hex categoryId", () => {
    const r = catalogueItemSchema.safeParse({ name: "SFP", sku: "SFP-LX", categoryId: "0123456789abcdef01234567" });
    expect(r.success).toBe(true);
  });
```

(If the existing valid `catalogueItemSchema` test referenced `category`, update it so the suite reflects the new contract.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm test -- customer.validation`
Expected: FAIL — `categoryId` not yet in the schema (the new cases fail; the old `category` field may still be accepted).

- [ ] **Step 3: Update `catalogueItemSchema`**

In `backend/src/modules/customer/customer.validation.ts`, in `catalogueItemSchema` (around line 124), replace the line:

```ts
  category: catalogueText(80, "Category"),
```

with:

```ts
  // A reference to a global Category (validated against the active list in the service).
  categoryId: z
    .string({ error: "Select a category." })
    .trim()
    .regex(/^[a-f0-9]{24}$/i, "Select a category."),
```

Leave `stockRequestSchema.category` (line 194) **unchanged** — the portal request keeps its free-text hint.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && pnpm test -- customer.validation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend
git add src/modules/customer/customer.validation.ts src/modules/customer/customer.validation.test.ts
git commit -m "feat(category): catalogue item validates categoryId instead of free-text category"
```

---

### Task 9: Catalogue repository — store `categoryId`, include relation on reads

**Files:**
- Modify: `backend/src/modules/customer/customer.repository.ts:399-454` (and the catalogue read includes)

- [ ] **Step 1: Update `CatalogueItemData` and create/update to use `categoryId`**

In `backend/src/modules/customer/customer.repository.ts`:

In `interface CatalogueItemData` (around line 399), replace `category: string;` with:

```ts
  categoryId: string;
```

In `createCatalogueItem` (around line 419), replace `category: data.category,` with:

```ts
      categoryId: data.categoryId,
```

In `updateCatalogueItem` (around line 442), replace `category: data.category,` with:

```ts
    categoryId: data.categoryId,
```

- [ ] **Step 2: Include the category relation on catalogue reads**

There are exactly **two** read sites to update (verified during planning):

1. The shared `childInclude` object (lines 29-36) — this single object backs the admin customer detail, the portal own-catalogue, and the stock view (all go through `findByIdWithChildren`). Change its catalogue line from:
```ts
  catalogue: { orderBy: { name: "asc" } },
```
to:
```ts
  catalogue: { include: { category: true }, orderBy: { name: "asc" } },
```

2. `findCatalogueItemById` (line 388) — used by the update/remove guards. Change it to:
```ts
export function findCatalogueItemById(id: string) {
  return prisma.customerCatalogueItem.findUnique({ where: { id }, include: { category: true } });
}
```
(Drop the explicit `: Promise<CustomerCatalogueItem | null>` return annotation so the inferred type carries the included `category`.)

`findCatalogueItemBySku` (line 392) is used only for dup-checks (it reads `.sku`/`.id`), so it does **not** need the include — leave it as-is.

- [ ] **Step 3: Verify typecheck**

Run: `cd backend && pnpm typecheck`
Expected: errors ONLY in `customer.service.ts` (it still references `i.category` as a string and `data.category`) — those are fixed in Task 10. The repository file itself should compile. If the repository has errors, re-check the includes.

- [ ] **Step 5: Commit**

```bash
cd backend
git add src/modules/customer/customer.repository.ts
git commit -m "feat(category): catalogue repository stores categoryId and includes category relation"
```

---

### Task 10: Catalogue service — normalize/types/mapper + active-category validation

**Files:**
- Modify: `backend/src/modules/customer/customer.service.ts` (lines ~85-90, ~246-262, ~826-868)

- [ ] **Step 1: Import the category service**

Near the top of `customer.service.ts`, with the other `#modules/*` imports, add:

```ts
import * as categoryService from "#modules/category/category.service.js";
```

- [ ] **Step 2: Update the `PublicCatalogueItem` shape**

Find `export interface PublicCatalogueItem` (around line 85). Replace its `category: string;` field with:

```ts
  categoryId: string;
  category: { id: string; name: string } | null;
```

- [ ] **Step 3: Update `toCatalogueItem` mapper**

`toCatalogueItem` (around line 246) currently takes `CustomerCatalogueItem`. Change its parameter type to include the relation and map it. Replace the whole function with:

```ts
function toCatalogueItem(
  i: CustomerCatalogueItem & { category?: { id: string; name: string } | null },
): PublicCatalogueItem {
  return {
    id: i.id,
    name: i.name,
    sku: i.sku,
    categoryId: i.categoryId,
    category: i.category ? { id: i.category.id, name: i.category.name } : null,
    description: i.description,
    uom: i.uom,
    serialized: i.serialized ?? false,
    barcodeRequired: i.barcodeRequired ?? false,
    highValue: i.highValue ?? false,
    thresholdQty: i.thresholdQty,
    status: i.status ?? "active",
    attributes: i.attributes ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}
```

- [ ] **Step 4: Update `CatalogueItemInput` and `normalizeCatalogueInput`**

Find `export interface CatalogueItemInput` (around line 826). Replace `category: string;` with:

```ts
  categoryId: string;
```

In `normalizeCatalogueInput` (around line 840), replace:

```ts
  const category = input.category.trim();
```
with:
```ts
  const categoryId = input.categoryId.trim();
```

replace:
```ts
  if (!category) throw badRequest("Category is required.");
```
with:
```ts
  if (!categoryId) throw badRequest("Select a category.");
```

and in the returned object replace `category,` with:
```ts
    categoryId,
```

- [ ] **Step 5: Validate the category is active in add/update**

In `addCatalogueItem` (around line 870), immediately after `const data = normalizeCatalogueInput(input);`, add:

```ts
  await categoryService.requireActiveCategory(data.categoryId);
```

Do the same in `updateCatalogueItem` (around line 893), right after its `const data = normalizeCatalogueInput(input);`.

- [ ] **Step 6: Verify typecheck + lint + tests**

Run: `cd backend && pnpm typecheck && pnpm lint && pnpm test`
Expected: no errors; all vitest tests pass. (If `toCatalogueItem` is called with a result lacking `category`, ensure Task 9's includes are in place on that read path.)

- [ ] **Step 7: Commit**

```bash
cd backend
git add src/modules/customer/customer.service.ts
git commit -m "feat(category): catalogue service maps categoryId and validates active category"
```

---

### Task 11: Remove the vestigial `category` field from stock requests (backend)

**Context (verified against current code):** approving a stock request is a **status move only** — `approveStockRequest` (customer.service.ts:1189) deliberately never creates a catalogue item. There is no `acceptStockRequest`. So a stock request's `category` field is dead — nothing reads it for classification. This task removes it cleanly. Categories apply only to catalogue items. **Do not** add catalogue-creation or category logic to approval.

**Files:**
- Modify: `backend/prisma/schema.prisma` (`CustomerStockRequest.category`, line 343)
- Modify: `backend/src/modules/customer/customer.validation.ts` (`stockRequestSchema`, line 204)
- Modify: `backend/src/modules/customer/customer.repository.ts` (`StockRequestData` + `createStockRequest`, lines 625/643)
- Modify: `backend/src/modules/customer/customer.service.ts` (`StockRequestInput`/`toStockRequestData`/`toStockRequest`/`PublicStockRequest`)

- [ ] **Step 1: Remove `category` from the Prisma model**

In `backend/prisma/schema.prisma`, in `model CustomerStockRequest`, delete line 343:
```prisma
  category    String?  // a free-text customer hint, NOT a link to a catalogue category
```

- [ ] **Step 2: Remove `category` from `stockRequestSchema`**

In `customer.validation.ts`, in `stockRequestSchema` (line 193), delete the line:
```ts
  category: z.string().trim().max(80).optional(),
```
Also update the block comment just above it (lines 190-191) to drop the "Category is a free-text customer hint" sentence, so the comment stays accurate.

- [ ] **Step 3: Remove `category` from the repository**

In `customer.repository.ts`:
- In `interface StockRequestData` (line 622), delete `category?: string | null;` (line 625).
- In `createStockRequest` (line 636), delete `category: data.category ?? null,` (line 643).

- [ ] **Step 4: Remove `category` from the service**

In `customer.service.ts`:
- In `interface StockRequestInput` (around line 1115), delete `category?: string;` (line 1119).
- In `toStockRequestData` (line 1124), delete `category: trimToNull(input.category),` (line 1135).
- In `interface PublicStockRequest` (search for it — around line 134 region; it has a `category` field), delete its `category` field.
- In `toStockRequest` (line 294), delete `category: r.category,` (line 299).

- [ ] **Step 5: Confirm approval is unchanged**

Do NOT modify `approveStockRequest` / `rejectStockRequest` / the routes. Approval stays a status move. (This step is a no-op check: re-read `approveStockRequest` at customer.service.ts:1189 and confirm it still only calls `reviewStockRequest` with a status — no catalogue write.)

- [ ] **Step 6: Regenerate client + verify typecheck + lint + tests**

Run: `cd backend && pnpm prisma:generate && pnpm typecheck && pnpm lint && pnpm test`
Expected: no errors; tests pass. (If a test references `stockRequestSchema` with a `category`, update it to drop that field.)

- [ ] **Step 7: Commit**

```bash
cd backend
git add prisma/schema.prisma src/modules/customer/customer.validation.ts src/modules/customer/customer.repository.ts src/modules/customer/customer.service.ts
git commit -m "refactor(category): remove vestigial category field from stock requests"
```

---

### Task 12: Seed — drop free-text catalogue category, seed starter categories

**Files:**
- Modify: `backend/src/db/seed.ts`

- [ ] **Step 1: Inspect the seed's catalogue section**

Open `backend/src/db/seed.ts` and find where catalogue items are created (search for `category` — the design doc noted line ~127). Determine how items are seeded (inline array, or from a template).

- [ ] **Step 2: Seed starter categories and reference them by id**

Before catalogue items are seeded, upsert a few global categories and build a name→id map, then set `categoryId` on each seeded item instead of a free-text `category`. Concretely:

```ts
// Seed the global category master list first; catalogue items reference these by id.
const CATEGORY_NAMES = ["Optical", "Fiber", "Core", "Router", "Switch", "Cable", "Connector"];
const categoryIdByName: Record<string, string> = {};
for (let i = 0; i < CATEGORY_NAMES.length; i++) {
  const name = CATEGORY_NAMES[i];
  const key = name.toLowerCase();
  const cat = await prisma.category.upsert({
    where: { key },
    update: {},
    create: { key, name, status: "active", sortOrder: i },
  });
  categoryIdByName[name] = cat.id;
}
```

Then, where each catalogue item is created, replace the `category: "<Something>"` field with a `categoryId` lookup, e.g.:

```ts
    categoryId: categoryIdByName["Optical"],
```

If the seed currently derives category from a template string, map that string through `categoryIdByName` (falling back to a sensible default like `categoryIdByName["Core"]`, and ensure any template category names are included in `CATEGORY_NAMES`).

- [ ] **Step 3: Verify typecheck**

Run: `cd backend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Reset DB data and reseed (dev/test data is disposable)**

Because existing `CustomerCatalogueItem` rows have no `categoryId`, delete them before reseeding. Run the seed (it should be idempotent). If the seed does not already clear catalogue items, run this one-off cleanup first:

Run: `cd backend && node -e "import('./dist/lib/prisma.js').then(async ({prisma})=>{await prisma.customerCatalogueItem.deleteMany({});await prisma.$disconnect();console.log('cleared catalogue items')})"`

(If `dist` isn't built, run `pnpm build` first, or perform the deletion via your normal seed reset path.)

Then run your seed command (check `package.json`/README for the exact script, e.g. `pnpm tsx src/db/seed.ts` or a `seed` script).
Expected: seeds categories + catalogue items with valid `categoryId`, no errors.

- [ ] **Step 5: Commit**

```bash
cd backend
git add src/db/seed.ts
git commit -m "feat(category): seed starter categories and reference them by id in catalogue seed"
```

---

### Task 13: Backend full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Full backend check**

Run: `cd backend && pnpm prisma:generate && pnpm typecheck && pnpm lint && pnpm test`
Expected: client generates; no type errors; no lint errors; all vitest tests pass.

- [ ] **Step 2: Boot smoke test**

Run: `cd backend && pnpm dev`
Expected: server starts cleanly. Confirm no runtime error on boot. Stop it.

- [ ] **Step 3: Commit (only if any fixups were needed)**

```bash
cd backend
git add -A
git commit -m "chore(category): backend verification fixups"
```

---

## Phase 4 — Frontend

### Task 14: Category types + service

**Files:**
- Create: `frontend/src/types/category.ts`
- Create: `frontend/src/services/category.service.ts`

- [ ] **Step 1: Create the type**

Create `frontend/src/types/category.ts`:

```ts
export interface Category {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  sortOrder: number;
  itemCount: number;
  createdAt: string;
}

export interface CategoryPayload {
  name: string;
  description?: string;
  status?: "active" | "inactive";
}
```

- [ ] **Step 2: Create the service**

First confirm the shape of an existing simple service to mirror it exactly. Open `frontend/src/services/role.service.ts` and match its `api()` import path and cache idiom. Then create `frontend/src/services/category.service.ts`:

```ts
import { api } from "@/lib/api";
import type { Category, CategoryPayload } from "@/types/category";

let cache: Category[] | null = null;

export const getCachedCategories = (): Category[] | null => cache;

export async function listCategories(): Promise<Category[]> {
  const { categories } = await api<{ categories: Category[] }>("/categories");
  cache = categories;
  return categories;
}

export async function getCategory(idOrKey: string): Promise<Category> {
  const { category } = await api<{ category: Category }>(`/categories/${idOrKey}`);
  return category;
}

export async function createCategory(payload: CategoryPayload): Promise<Category> {
  const { category } = await api<{ category: Category }>("/categories", { method: "POST", data: payload });
  cache = null;
  return category;
}

export async function updateCategory(id: string, payload: CategoryPayload): Promise<Category> {
  const { category } = await api<{ category: Category }>(`/categories/${id}`, { method: "PUT", data: payload });
  cache = null;
  return category;
}

export async function deleteCategory(id: string): Promise<void> {
  await api(`/categories/${id}`, { method: "DELETE" });
  cache = null;
}
```

**Important:** match the actual `api()` call signature used elsewhere. If `role.service.ts` calls `api(path, { method, data })` differently (e.g. `api.post`), copy that exact form instead of the above.

- [ ] **Step 3: Verify lint + typecheck (build)**

Run: `cd frontend && pnpm lint`
Expected: no errors. (A focused type error here surfaces a mismatched `api()` signature — fix to match the real one.)

- [ ] **Step 4: Commit**

```bash
cd frontend
git add src/types/category.ts src/services/category.service.ts
git commit -m "feat(category): add frontend category types and service"
```

---

### Task 15: Categories management screen (Settings section)

**Files:**
- Create: `frontend/src/components/dashboard/settings/categories/CategoriesView.tsx`
- Modify: `frontend/src/components/dashboard/settings/SettingsPanel.tsx`
- Modify: `frontend/src/components/dashboard/shell/Sidebar.tsx`

- [ ] **Step 1: Read the clone source**

Open `frontend/src/components/dashboard/users-roles/departments/DepartmentsView.tsx` in full. This is the template: header card (search + sort + inline add input), paginated list, inline edit (pencil → input → Enter/Escape), delete-with-confirm. Note its exact imports (`can` from `useAuth`, `ConfirmDialog`, styles, icons) and structure.

- [ ] **Step 2: Create `CategoriesView` by adapting `DepartmentsView`**

Create `frontend/src/components/dashboard/settings/categories/CategoriesView.tsx`. Adapt the Departments component with these concrete differences:

- Import from the category service: `listCategories`, `getCachedCategories`, `createCategory`, `updateCategory`, `deleteCategory` and the `Category` type.
- Permissions: `const canCreate = can("categories.create"); const canEdit = can("categories.edit"); const canDelete = can("categories.delete");`
- Each row shows the category **name** plus its **status** (active/inactive) and **itemCount** (e.g. "12 items"). Inline edit edits the name. Add a status toggle control (a small active/inactive switch or button calling `updateCategory(id, { status })`).
- Delete uses the confirm dialog; surface the server's 409 message verbatim when a category is in use (the catch shows `err.message`).
- Seed initial list from `getCachedCategories()` and refresh via `listCategories()` on mount (mirror how Departments seeds + loads).

Keep the same Tailwind classes/styles and pagination (12/page) as Departments so it visually matches. Use the `Tag` icon from `lucide-react` for the section.

(Because this is a faithful clone of an existing in-repo component, reproduce its structure exactly and swap the domain calls/labels — do not invent new UI patterns.)

- [ ] **Step 3: Register the Settings section**

Open `frontend/src/components/dashboard/settings/SettingsPanel.tsx`. It defines sections with `{ id, label, requires, ... }` and renders the active one (`?section=`). Add a `categories` section entry:

- Add to the sections array (after `integrations`/`email`, before or after `email_templates` as fits): an entry with `id: "categories"`, `label: "Categories"`, `requires: "categories.view"` (match the exact field name the file uses for gating — it may be `requires` or `perm`).
- In the render switch/map that picks the active section's component, render `<CategoriesView />` for `categories`. Import it at the top:
```ts
import { CategoriesView } from "./categories/CategoriesView";
```

Match the file's existing idiom exactly (how other sections declare `requires` and how the component is chosen).

- [ ] **Step 4: Allow category-only admins to reach Settings in the sidebar**

Open `frontend/src/components/dashboard/shell/Sidebar.tsx`. In the `NAV` array, the Settings item has `perms: ["settings.view", "email_templates.view"]`. Add `"categories.view"`:

```ts
  { href: "/dashboard/settings", label: "Settings", icon: Settings, perms: ["settings.view", "email_templates.view", "categories.view"] },
```

- [ ] **Step 5: Update the Settings page permission gate (if present)**

If `frontend/src/app/dashboard/settings/page.tsx` wraps the panel in `<PermissionGate anyOf={[...]}>`, add `"categories.view"` to that `anyOf` array so the page renders for a category-only admin. (If no such gate exists, skip.)

- [ ] **Step 6: Verify lint + build**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: builds with no errors.

- [ ] **Step 7: Manual verification**

Run both servers (`cd backend && pnpm dev`, and `cd frontend && pnpm dev`). As an admin, go to Settings → Categories. Create "Optical", "Fiber". Rename one. Toggle one inactive. Try to delete one — confirm it works when unused. Confirm the list shows item counts.

- [ ] **Step 8: Commit**

```bash
cd frontend
git add src/components/dashboard/settings/categories/CategoriesView.tsx src/components/dashboard/settings/SettingsPanel.tsx src/components/dashboard/shell/Sidebar.tsx
git add src/app/dashboard/settings/page.tsx 2>/dev/null || true
git commit -m "feat(category): add Settings > Categories management screen"
```

---

### Task 16: Catalogue item modal — free-text → required dropdown

**Files:**
- Modify: `frontend/src/components/dashboard/customers/CatalogueItemModal.tsx`
- Modify: `frontend/src/services/customer.service.ts` (`CatalogueItemPayload`)
- Modify: `frontend/src/types/customer.ts` (`CatalogueItem` read type)

- [ ] **Step 1: Update the payload + read types**

In `frontend/src/services/customer.service.ts`, find `CatalogueItemPayload` (the design noted line ~89). Replace its `category: string;` field with:

```ts
  categoryId: string;
```

In `frontend/src/types/customer.ts`, find the `CatalogueItem` type (lines ~23-31). Replace `category: string;` with:

```ts
  categoryId: string;
  category: { id: string; name: string } | null;
```

Also find `CustomerStockItem` (around line 125) used by the stock view; replace its `category: string;` with the same nested shape (and `categoryId: string;`) so `MyStockView` can read `item.category?.name`.

- [ ] **Step 2: Convert the modal field to a dropdown**

Open `frontend/src/components/dashboard/customers/CatalogueItemModal.tsx`. Currently it has `categorySuggestions?: string[]` prop and a free-text `<input list="catalogue-category-options">` + `<datalist>` (lines ~182-191), with state `const [category, setCategory] = useState(item?.category ?? "")`.

Make these changes:

- Replace the prop. Remove `categorySuggestions?: string[]`. Add:
```ts
  categories: { id: string; name: string }[];
```
- Replace the state:
```ts
  const [categoryId, setCategoryId] = React.useState(item?.categoryId ?? "");
```
- Replace the free-text input + datalist block with a `<select>`:
```tsx
<select
  className={inputCls}
  value={categoryId}
  onChange={(e) => {
    setCategoryId(e.target.value);
    setErrors((p) => ({ ...p, category: undefined }));
  }}
  aria-invalid={Boolean(errors.category)}
>
  <option value="">— Select a category</option>
  {categories.map((c) => (
    <option key={c.id} value={c.id}>{c.name}</option>
  ))}
</select>
{categories.length === 0 && (
  <p className="mt-1 text-[11px] text-[var(--muted)]">
    No categories yet. Create one in Settings → Categories first.
  </p>
)}
```
- Update the validation: replace the `if (!category.trim())` check with `if (!categoryId) errs.category = "Select a category.";`
- Update the submit payload: send `categoryId` instead of `category`.
- If there's a "save disabled" condition, also disable save when `categories.length === 0`.

- [ ] **Step 3: Verify lint**

Run: `cd frontend && pnpm lint`
Expected: errors will appear at the modal's call site in `CustomerDetail.tsx` (prop changed from `categorySuggestions` to `categories`) — fixed in Task 17. The modal/service/types files themselves should be clean.

- [ ] **Step 4: Commit**

```bash
cd frontend
git add src/components/dashboard/customers/CatalogueItemModal.tsx src/services/customer.service.ts src/types/customer.ts
git commit -m "feat(category): catalogue item modal uses required category dropdown"
```

---

### Task 17: Customer detail — supply categories, display name, drop derivation

**Files:**
- Modify: `frontend/src/components/dashboard/customers/CustomerDetail.tsx`

- [ ] **Step 1: Load active categories and pass to the modal**

Open `frontend/src/components/dashboard/customers/CustomerDetail.tsx`. Remove the derivation block (around line 653):

```ts
const categories = React.useMemo(
  () => [...new Set(customer.catalogue.map((i) => i.category).filter(Boolean))].sort(),
  [customer.catalogue],
);
```

Replace it with state + load of **active** global categories from the service:

```ts
const [categories, setCategories] = React.useState<{ id: string; name: string }[]>(
  () => (getCachedCategories() ?? []).filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name })),
);
React.useEffect(() => {
  listCategories()
    .then((cats) =>
      setCategories(cats.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name }))),
    )
    .catch(() => {});
}, []);
```

Add the import at the top:
```ts
import { getCachedCategories, listCategories } from "@/services/category.service";
```

- [ ] **Step 2: Update the modal usage**

Find where `<CatalogueItemModal ... />` is rendered. Replace the prop `categorySuggestions={categories}` with:
```tsx
categories={categories}
```

- [ ] **Step 3: Fix catalogue table display to use the category name**

Find where the catalogue table renders each item's category (search for `.category` in the JSX — around lines 664/704/744/771 per the design). Replace any `item.category` (rendered as a string) with `item.category?.name ?? "—"`. If category is used in a client-side search filter, use `item.category?.name ?? ""` there too.

- [ ] **Step 4: Verify lint + build**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/components/dashboard/customers/CustomerDetail.tsx
git commit -m "feat(category): customer detail loads global categories and shows category name"
```

---

### Task 18: Stock view category display + remove category from portal stock-request modal

**Context:** the portal stock-request form has a free-text category field that is now being removed everywhere (Task 11 removed it backend-side). There is NO admin "accept → assign category" UI to build — approval is a status move that doesn't create a catalogue item. This task (a) fixes the customer stock view to show the catalogue category name, and (b) removes the dead category field from the portal request modal + its frontend type/service.

**Files:**
- Modify: `frontend/src/components/dashboard/stock/MyStockView.tsx`
- Modify: `frontend/src/components/dashboard/stock/StockRequestModal.tsx` (remove category field)
- Modify: `frontend/src/types/customer.ts` (`StockRequest` type: remove `category`)
- Modify: `frontend/src/services/customer.service.ts` (`submitStockRequest` payload: remove `category`)

- [ ] **Step 1: Fix `MyStockView` category display**

Open `frontend/src/components/dashboard/stock/MyStockView.tsx`. At the category display sites (around lines 117/157), replace `item.category` (string) with `item.category?.name ?? "—"`. (The portal stock view reads the customer's own catalogue, which now carries the nested category from Task 16's `CustomerStockItem` type change.)

- [ ] **Step 2: Remove the category field from `StockRequestModal`**

Open `frontend/src/components/dashboard/stock/StockRequestModal.tsx`. Remove:
- the state: `const [category, setCategory] = React.useState("");` (line 25)
- the `category` key in the submit payload: `category: category.trim() || undefined,` (line 52)
- the entire Category form field — the `<div>` containing `<label ...>Category<RequiredMark /></label>` and its `<input value={category} ...>` (the block around lines 133-147 in the version read during planning). Also drop `category` from the `errors` state type and any `errs.category` validation line.

(After this the modal submits `name`, `sku`?, `description`, `uom`, `thresholdQty`, custom fields as before — minus category. If `sku` is part of the current modal, leave it; this plan only removes category.)

- [ ] **Step 3: Remove `category` from the frontend `StockRequest` type**

In `frontend/src/types/customer.ts`, in `interface StockRequest` (line 70), delete `category: string | null;` (line 74).

- [ ] **Step 4: Remove `category` from the `submitStockRequest` service payload type**

In `frontend/src/services/customer.service.ts`, find the `submitStockRequest` function / its payload type and remove the `category` field from it (so it matches the modal + backend).

- [ ] **Step 5: Verify lint + build**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: no errors. (TypeScript will flag any remaining `request.category` / `category` reference — remove those too.)

- [ ] **Step 6: Manual verification**

As a portal customer user, open the stock-request modal → confirm there is no Category field → submit a request (name/quantity/reason/notes as applicable) → it appears in the admin review queue. As an admin, approve it → confirm it's a status change and no catalogue item is created.

- [ ] **Step 7: Commit**

```bash
cd frontend
git add src/components/dashboard/stock/MyStockView.tsx src/components/dashboard/stock/StockRequestModal.tsx src/types/customer.ts src/services/customer.service.ts
git commit -m "refactor(category): remove category from portal stock request; stock view shows catalogue category name"
```

---

### Task 19: Full end-to-end verification gate

**Files:** none (verification only)

- [ ] **Step 1: Backend full check**

Run: `cd backend && pnpm prisma:generate && pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 2: Frontend full check**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: builds clean.

- [ ] **Step 3: Manual end-to-end happy path**

With both servers running:
1. Empty categories → open a customer → Add catalogue item → confirm the category dropdown is empty and shows the "create one first" hint and save is disabled.
2. Settings → Categories → create Optical, Fiber, Core.
3. Customer → Add catalogue item → pick "Optical" → save → item shows category "Optical".
4. Settings → Categories → rename "Optical" → "Optics" → reopen the item → it now shows "Optics" (single source of truth).
5. Settings → Categories → try to delete "Optics" (in use) → blocked with the "used by N item(s)" message.
6. Portal: open the stock-request modal → confirm there is NO category field → submit a request → admin approves it → confirm approval is a status change only (no catalogue item created, categories not involved).

- [ ] **Step 4: Final commit (any fixups)**

```bash
git add -A
git commit -m "chore(category): end-to-end verification fixups"
```

---

## Self-review checklist (completed during planning)

- **Spec coverage:** Section 1 (model) → Task 1. Section 2 (backend module, permissions, endpoints, guards, catalogue integration) → Tasks 2–13. Section 3 (frontend: service/types, Settings screen, catalogue modal, detail, stock view) → Tasks 14–18. Section 4 (stock-request: category removed, approval untouched) → Task 11 (backend) + Task 18 (frontend). ✅
- **Required relation + fresh start:** Task 1 (required `categoryId`) + Task 12 (delete existing rows, reseed). ✅
- **No Prisma enum for status:** Task 1 uses `String @default("active")`; Task 3 validates with `z.enum`. ✅
- **Stock requests have no category (revised):** category removed from the request model/validation/service/repository (Task 11) and the portal modal/type/service (Task 18). Approval stays a status move — Task 11 Step 5 explicitly forbids adding catalogue-creation/category logic to `approveStockRequest`. ✅
- **Type consistency:** `categoryId: string` + nested `category: { id, name } | null` used consistently across backend (`PublicCatalogueItem`, `CatalogueItemData`, `CatalogueItemInput`) and frontend (`CatalogueItem`, `CustomerStockItem`, modal). `requireActiveCategory` defined in Task 5, consumed in Task 10 (catalogue add/update). No longer referenced by stock-request code. ✅
- **Placeholder scan:** No open-ended hunts remain. Catalogue read-include sites pinned to exactly two (shared `childInclude` at customer.repository.ts:29-36 and `findCatalogueItemById`). Stock-request field-removal sites pinned to exact line numbers (verified against current code: model:343, validation:204, repo:625/643, service:1119/1135/299, FE type:74, FE modal:25/52/133-147). All code steps include real code. ✅
- **Reality-corrected during review:** the working tree had already redesigned stock requests into order/replenishment asks (`name/quantity/reason/notes`, `approveStockRequest` = status move, no `acceptStockRequest`). The original plan's Task 11/18 were written against a stale snapshot and have been rewritten to match the actual code. The portal also already has `overview/projects/sites/catalogue/stock/stock-requests` read endpoints — relevant to the future Customer Portal feature, out of scope here. ✅
- **Stale-doc note:** Backend `CLAUDE.md` claims there is no test runner; in reality vitest is configured and 61 tests pass (recorded in memory `backend-has-vitest`). The plan uses vitest for pure layers accordingly. Consider correcting that `CLAUDE.md` line in a follow-up. ✅
