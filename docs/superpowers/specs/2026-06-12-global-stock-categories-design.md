# Global Stock Categories — Design

**Date:** 2026-06-12
**Status:** Approved (sections 1–3)
**Author:** Shahul (with Claude)

## Problem

`CustomerCatalogueItem.category` is currently a **free-text string** (`schema.prisma:261`, max 80 chars, no constraint). The catalogue-item form ([CatalogueItemModal.tsx:182](../../../frontend/src/components/dashboard/customers/CatalogueItemModal.tsx)) offers an autocomplete `<datalist>`, but the suggestions are derived only from *that customer's* existing items ([CustomerDetail.tsx:653](../../../frontend/src/components/dashboard/customers/CustomerDetail.tsx)) and the user can still type anything.

Consequence: category values fragment across customers and over time — `Optical` / `optical` / `Optical Devices` / `Fibre` / `Fiber` all become distinct buckets. Any future "stock by category" / "inventory by category" reporting is unreliable.

## Goal

Replace free-text categories with a **single global master list** of categories that staff manage dynamically (create / edit / delete) through the app — mirroring how **Roles** are managed today. Every catalogue item references a category from this list. One source of truth → clean grouping and reporting.

## Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| Scope | Global vs per-customer | **Fully global flat list** — same categories for all customers |
| Migration | Existing free-text data | **Fresh start / blank slate** — dev test data is disposable; no migration script. Existing `CustomerCatalogueItem` rows are **deleted** from the DB (they hold legacy free-text `category` and no `categoryId`, which a required relation cannot tolerate). |
| Link type | How items store category | **Reference by ID** (`categoryId` → `Category`), normalized, single source of truth |
| Relation strictness | Nullable vs required | **Strict required relation** — `categoryId` is non-nullable at DB **and** validation level. Every catalogue item must belong to a category. No transition compatibility. |
| Fields | Category shape | **Name + Description + Status** (+ auto-derived `key` slug + `sortOrder`). No manual "Code" field. |
| Status type | enum vs string | **`status String @default("active")`** validated by zod `z.enum(["active","inactive"])` — matches all 6 existing models. **No Prisma enum** (the schema has zero enums; adding one breaks a deliberate, consistent convention; in MongoDB Prisma enums serialize to strings anyway). |
| Permissions | How endpoints are guarded | **New `categories` permission group** (`categories.view/create/edit/delete`) in `permissions.ts` — independently delegatable, renders in the role matrix automatically, consistent with every other module. |
| UI location | Where management screen lives | **Settings → new "Categories" section** (`/dashboard/settings?section=categories`). Master-data config belongs in the Settings hub, not under "Users & Roles" (IA mismatch — categories are a catalogue concept, not a user/identity one). |
| Stock requests | How portal category works | **Category removed from the customer request entirely; admin assigns a mandatory category on approval.** (Revised 2026-06-12 — supersedes the earlier "free-text hint" decision.) The customer's stock request carries **no category field at all** — `CustomerStockRequest.category` is dropped from the model, validation, and the portal form. Categories stay strictly internal master-data: the customer never sees or picks one. When an admin **accepts** a request, the accept action **requires** a valid active `categoryId`; the created catalogue item is built with it. This is the strictest reading of "categories hidden from customer management" — customers don't even see the taxonomy names. |

### Rejected alternatives
- **Enum / hardcoded constant list** for categories — fails the "admin creates them dynamically" requirement (every new category = code change + redeploy).
- **Store category name string (denormalized)** on items — rename requires cascade `updateMany`; a missed cascade orphans a typo. Reference-by-ID is safer and was chosen.
- **Per-customer category subsets** — unnecessary complexity (YAGNI); the business is one company managing many customers' stock, not multi-tenant SaaS.
- **`CategoryStatus` Prisma enum** (suggested externally) — rejected; see Status type row above.
- **Categories tab under Users & Roles** (suggested by exploration) — rejected; IA mismatch.

---

## Section 1 — Data model

### New `Category` model (`backend/prisma/schema.prisma`)

```prisma
model Category {
  id          String   @id @default(auto()) @map("_id") @db.ObjectId
  key         String   @unique               // auto slug from name: "Optical" -> "optical"
  name        String                         // display; unique case-insensitive (enforced in service)
  description String?
  status      String   @default("active")    // active | inactive  (zod statusEnum, NOT a Prisma enum)
  sortOrder   Int      @default(0)
  items       CustomerCatalogueItem[]         // back-relation
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

### Change to `CustomerCatalogueItem`

Remove the free-text `category String` field; add a **required** relation:

```prisma
// REMOVE: category  String
categoryId  String   @db.ObjectId            // REQUIRED, non-nullable
category    Category @relation(fields: [categoryId], references: [id])

@@index([categoryId])
```

### Notes
- **No `isSystem` flag** (unlike Role). There are no seeded default categories (fresh start), so every category is admin-created and therefore editable/deletable.
- The required relation means **categories must exist before any catalogue item can be created**. A brand-new empty system has zero categories → the catalogue "Add Item" dropdown is empty → an admin must create at least one category in Settings first. This is the intended, clean behavior.
- **DB cleanup step:** delete all existing `CustomerCatalogueItem` documents before/as part of applying this schema (dev/test data only — authorized).

---

## Section 2 — Backend module + API

New module `backend/src/modules/category/`, a full vertical slice cloned from the `role` module's conventions (`asyncHandler`, `actorFrom(req)`, `param(req, "id")`, `{ key }`-wrapped JSON responses, audit on every mutation, `#modules/*` alias with `.js` extensions).

### Files
```
backend/src/modules/category/
├── category.routes.ts        # route + middleware chain
├── category.controller.ts    # thin handlers (asyncHandler)
├── category.service.ts       # business logic + guards
├── category.repository.ts    # ONLY Prisma access
└── category.validation.ts    # zod schemas
```
Plus: mount at `/categories` in `backend/src/routes/index.ts`; add the `categories` group to `backend/src/modules/role/permissions.ts`.

### Endpoints

| Method | Path | Purpose | Guard |
|---|---|---|---|
| GET | `/categories` | list (+ `itemCount` per category) | `requireAnyPermission("categories.view","customers.edit")` |
| GET | `/categories/:id` | one (by id or key) | `requireAnyPermission("categories.view","categories.edit")` |
| POST | `/categories` | create | `requirePermission("categories.create")` + `writeLimiter` + `validateBody` |
| PUT | `/categories/:id` | update (name/description/status) | `requirePermission("categories.edit")` + `writeLimiter` + `validateBody` |
| DELETE | `/categories/:id` | delete (in-use guarded) | `requirePermission("categories.delete")` + `writeLimiter` |

Read route also allows `customers.edit` because the catalogue-item form (in the customer flow) needs to read the active category list to populate its dropdown, and catalogue writes (`POST/PUT /:id/catalogue`) are gated by `customers.edit` (`customer.routes.ts:83,90`) — same rationale as roles allowing `users.*` to read the role list for the user form's role picker. (`customers.create` is *not* included: creating a customer does not reach the catalogue form; catalogue editing needs `customers.edit`.)

### Validation (`category.validation.ts`)

```ts
const statusEnum = z.enum(["active", "inactive"]);   // identical to customer.validation.ts:5

export const createCategorySchema = z.object({
  name: z.string({ error: "Category name is required." }).trim().min(1).max(60),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),                      // service defaults to "active"
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1, "Category name can't be empty.").max(60).optional(),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
```

### Service guards (`category.service.ts`) — mirrors `role.service.ts`

- **`listCategories`** — batches item-counts in one grouped query (no N+1), like roles batch user counts. Returns public shape with `itemCount`.
- **`getCategory(idOrKey)`** — resolve by ObjectId or stable `key`; `notFound` if absent.
- **`createCategory`** — `slugify(name)` → `key`; auto-suffix on key collision (`optical`, `optical_2`); **case-insensitive name uniqueness** via `repo.findByName` → `conflict('A category named "X" already exists.')`; default `status="active"`; audit `category.created`.
- **`updateCategory`** — re-check name uniqueness if renamed (excluding self); audit `category.updated`.
- **`deleteCategory`** — **in-use guard:** count catalogue items with this `categoryId`; if `> 0` → `conflict("This category is used by N item(s). Reassign them before deleting it.")`; else delete + audit `category.deleted`. Non-negotiable because the relation is required (prevents orphaned items).

### Repository (`category.repository.ts`)
Pure Prisma, zero business logic: `findMany` (ordered by `sortOrder`, then `name`), `findById`, `findByKey`, `findByName` (case-insensitive `mode: "insensitive"`), `create`, `update`, `remove`, and a count helper for the in-use guard (count `CustomerCatalogueItem` by `categoryId`).

### Permissions catalog addition (`permissions.ts`)
```ts
{
  key: "categories",
  label: "Categories",
  description: "The global stock-category master list used to tag catalogue items.",
  permissions: [
    { key: "categories.view",   action: "View",   description: "View stock categories." },
    { key: "categories.create", action: "Create", description: "Add new stock categories." },
    { key: "categories.edit",   action: "Edit",   description: "Edit stock categories." },
    { key: "categories.delete", action: "Delete", description: "Delete stock categories." },
  ],
},
```

### Catalogue-item integration (in the **customer** module)
`customer.service.ts` `normalizeCatalogueInput` (and the create/update paths) validate that the supplied **`categoryId`** points to an existing **active** category — calling the category repository (a service may use another module's repository, per CLAUDE.md). The old free-text `category` handling is removed from the catalogue create/update flow. `customer.validation.ts` `catalogueItemSchema`: replace `category` text field with `categoryId: z.string()` (required, ObjectId-shaped).

---

## Section 3 — Frontend

### Part A — Category management screen (Settings)

- **Location:** `/dashboard/settings?section=categories`. Add a `"categories"` section to `SettingsPanel.tsx` (alongside Branding, Email, Integrations…), gated by `categories.view`.
- **Component:** `frontend/src/components/dashboard/settings/categories/CategoriesView.tsx` — cloned from `DepartmentsView.tsx` (the repo's lightweight master-data CRUD): header card (search + sort + inline "Add" input), paginated list, inline edit (pencil → input → Enter/Escape), **status active/inactive control**, delete-with-confirm dialog.
- **Plumbing:**
  - `frontend/src/types/category.ts` — `Category` type (`id, key, name, description, status, sortOrder, itemCount, createdAt`).
  - `frontend/src/services/category.service.ts` — typed `api()` wrappers + SWR cache, mirroring `role.service.ts` (`listCategories`, `getCategory`, `createCategory`, `updateCategory`, `deleteCategory`).
  - Permission checks via `can("categories.create"|"categories.edit"|"categories.delete")`.
- **Nav:** add `"categories.view"` to the Settings item's `perms` in `Sidebar.tsx` so a category-only admin can reach Settings.
- **Page guard:** include `categories.view` in the Settings page's `PermissionGate` `anyOf`.

### Part B — Catalogue item form integration

In `CatalogueItemModal.tsx`:
- **Replace** the free-text `<input>` + `<datalist>` (lines 182–191) with a **`<select>` dropdown** populated from active categories (`categoryService.list({ status: "active" })`, SWR-cached).
- Field becomes **`categoryId`** (not `category`); **required** — save blocked until chosen.
- **Empty-state UX:** if no active categories exist, show inline hint *"No categories yet. Create one in Settings → Categories first."* and disable save. (Honest consequence of the required relation.)

Elsewhere:
- **Remove** the per-customer category derivation in `CustomerDetail.tsx:653` (`[...new Set(customer.catalogue.map(i => i.category))]`) — obsolete.
- Catalogue **table** display in `CustomerDetail.tsx` and `MyStockView.tsx` shows the category **name** from the populated relation the API returns.
- `services/customer.service.ts` `CatalogueItemPayload` and `types/customer.ts`: swap `category: string` → `categoryId: string`; read type carries nested `category: { id, name }`.

---

## Section 4 — Stock-request flow (portal → admin accept)

The customer portal lets a customer user submit a **stock request** (`StockRequestModal`) that an admin later reviews and **accepts**, which creates a real catalogue item ([customer.service.ts](../../../backend/src/modules/customer/customer.service.ts) `submitStockRequest` / `acceptStockRequest`).

**Decision (revised): the customer request carries NO category; the admin assigns a mandatory active category on accept.** Categories are internal master-data and are never shown to customers — not even as a dropdown of names.

*Scope note:* this plan only **removes** the category from the request. The customer's other request fields (SKU, description, UOM, threshold, custom attributes) are **left as-is**; restructuring the request form (e.g. to Name/Quantity/Reason/Notes) belongs to the separate Customer Portal feature, not this plan.

### Backend

- **Drop `category` from `CustomerStockRequest`** — remove the field from the Prisma model (`schema.prisma`), from `stockRequestSchema` ([customer.validation.ts:191](../../../backend/src/modules/customer/customer.validation.ts)), from `StockRequestInput` / `toStockRequestData` / `toStockRequest` / `PublicStockRequest`, and from the repository's `StockRequestData` + create. Existing stock-request rows are disposable test data and are deleted (consistent with the catalogue fresh-start).
- **`submitStockRequest`** no longer reads/stores a category.
- **`acceptStockRequest`** gains a **required** `categoryId` parameter — `acceptStockRequest(customerId, requestId, categoryId, note, actor)` — validated as an existing **active** category, and passed into `addCatalogueItem`.
- The accept route's body schema (`stockReviewSchema`) gains `categoryId` (required on accept; the service enforces it).

### Frontend

- **Portal `StockRequestModal`** ([StockRequestModal.tsx](../../../frontend/src/components/dashboard/stock/StockRequestModal.tsx)) — **remove** the Category field entirely (input, state, validation, and from the submit payload). All other fields stay.
- **Admin stock-request review/accept UI** (in `CustomerDetail.tsx`) — the accept action gains a **required category `<select>`** (active categories). The admin must choose one before the request can be accepted. The chosen `categoryId` is sent to the accept endpoint.

---

## Data flow (after)

```
Admin: Settings -> Categories -> create "Optical" (POST /categories)
        -> Category { key:"optical", name:"Optical", status:"active" }

Staff: Customer detail -> Stock catalogue -> Add Item
        -> category <select> populated from GET /categories?status=active
        -> POST /customers/:id/catalogue { ..., categoryId }
        -> customer.service validates categoryId is an active Category
        -> CustomerCatalogueItem { categoryId } (required FK)

Display/report: group by categoryId -> single canonical bucket per category
```

## Testing / verification

No backend test runner (per CLAUDE.md). Verify with:
- `cd backend && pnpm prisma:generate && pnpm typecheck && pnpm lint`
- `cd frontend && pnpm lint && pnpm build`
- Manual: create/edit/delete a category in Settings; confirm in-use delete is blocked; create a catalogue item picking a category; confirm empty-state hint when no active categories exist; confirm a renamed category reflects everywhere (single source of truth).

## Out of scope (future)
- Reporting screens themselves ("inventory by category") — this design only makes the data clean enough to build them.
- Per-customer category subsets.
- Bulk re-tagging UI (not needed under fresh-start).
- Category `sortOrder` drag-reorder UI (field exists; manual ordering UI can come later).
