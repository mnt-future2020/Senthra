# Customer Module — Design Spec

**Date:** 2026-06-09
**Status:** Approved (design), pending implementation
**Branch:** `feat/customer-module`

## 1. Goal & scope

Implement the **Customer module** from `docs/Senthra_Complete_Business_Flow.md` (Pre-requisite 5 + Flow 9):

- An admin/PM creates a **Customer** (company profile + nested projects, stock catalogue, sites).
- The system provisions a **single read-only login** for that customer and emails the credentials.
- The customer logs in (shared `/login`) and lands on a **read-only portal** showing their stock.

Because the **Stock/Inventory/Warehouse/Job systems do not yet exist**, the live stock data is built behind a **feature-flagged seam** that returns an honest "no stock data yet" state. When inventory lands, the portal lights up with **no customer-module rewrite**.

### Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| C1 | Customer auth model | **New third principal type** (`customer`), separate from staff `User` |
| C2 | Stock data source | **Real portal shell + `customerStockService` seam returning "no data yet"**, behind `FEATURE_CUSTOMER_STOCK` flag |
| C3 | Data isolation | Scope **strictly from `req.principal.customerId`**, never from request input |
| C4 | Route | **Separate `/customer` subtree** (own thin shell, no admin nav) |
| C5 | Read-only | **Structural** — customer principal has no write routes; reads are principal-scoped GETs |
| logins/customer | One login per customer | **Login fields live directly on the `Customer` record** (no separate table) |
| login surface | Shared `/login` | Customer appended to the login lookup order; routed by `homeFor` after auth |
| pricing | "NO pricing" hard rule | **Never render monetary values**; "high value" is a boolean/tier, not a price |

## 2. Data model (`backend/prisma/schema.prisma`)

```
model Customer {
  id                String   @id @default(auto()) @map("_id") @db.ObjectId
  customerCode      String   @unique          // Counter-allocated, e.g. CUST-001
  name              String                    // company, e.g. "BT"
  nameLower         String   @unique          // case-insensitive company-name guard
  contactPerson     String?
  email             String   @unique          // login identity
  phone             String?
  status            String   @default("active") // active | inactive

  // Auth (one login per customer; mirrors User)
  passwordHash      String
  mustResetPassword Boolean  @default(true)
  resetTokenHash      String?
  resetTokenExpiresAt DateTime?

  deletedAt         DateTime?                  // soft delete (mirrors User)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  projects  CustomerProject[]
  catalogue CustomerCatalogueItem[]
  sites     CustomerSite[]
}

model CustomerProject {
  id         String   @id @default(auto()) @map("_id") @db.ObjectId
  customerId String   @db.ObjectId
  customer   Customer @relation(fields: [customerId], references: [id])
  name       String
  nameLower  String                            // unique per-customer via @@unique
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  @@unique([customerId, nameLower])
  @@index([customerId])
}

model CustomerCatalogueItem {
  id         String   @id @default(auto()) @map("_id") @db.ObjectId
  customerId String   @db.ObjectId
  customer   Customer @relation(fields: [customerId], references: [id])
  name       String
  sku        String
  skuLower   String                            // unique per-customer via @@unique
  category   String                            // e.g. Optical | Core
  attributes Json?                             // per-category custom fields
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  @@unique([customerId, skuLower])
  @@index([customerId])
}

model CustomerSite {
  id         String   @id @default(auto()) @map("_id") @db.ObjectId
  customerId String   @db.ObjectId
  customer   Customer @relation(fields: [customerId], references: [id])
  name       String
  postcode   String?                           // optional
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  @@index([customerId])
}
```

`Session.principalType` is a free string — no change needed; customer sessions use `principalType = "customer"`.

## 3. Backend auth plumbing

- **`utils/jwt.ts`**: `Actor = "admin" | "user" | "customer"`. `readActor` keeps the admin fallback; recognizes `"customer"`.
- **`types/principal.ts`**: add
  ```
  interface CustomerPrincipal {
    type: "customer";
    id: string;            // customer id
    customerId: string;    // == id (explicit for isolation reads)
    email: string;
    name: string;          // company name
    customerCode: string;
    mustResetPassword: boolean;
    permissions: string[]; // fixed: ["stock.view"]
  }
  type Principal = AdminPrincipal | UserPrincipal | CustomerPrincipal;
  function customerPrincipal(c: Customer): CustomerPrincipal
  ```
- **`utils/actor.ts`** (LANDMINE FIX): currently any non-`user` → `[ALL_PERMISSIONS]`. Change to:
  - admin → `[ALL_PERMISSIONS]`
  - user → `principal.permissions`
  - customer → `principal.permissions` (read-only set)
- **`middleware/auth.middleware.ts`**:
  - `requireAuth`: add `payload.actor === "customer"` branch → `customerRepo.findById`, reject soft-deleted / inactive, `req.principal = customerPrincipal(c)`.
  - add `requireCustomer` guard (mirrors `requireAdmin`).
  - `requirePermission` / `requireAnyPermission`: already handle a `permissions` array generically; customer's forced-reset wall handled like user's (`mustResetPassword` 403). Ensure the admin-only early-return doesn't accidentally pass customers.
- **`modules/auth/auth.service.ts`**:
  - `login`: append customer lookup after user (active, not soft-deleted) → `customerPrincipal`, `startAndIssue(c.id, "customer")`.
  - `refreshSession`: add `actor === "customer"` branch.
  - `forgotPassword` / `resetPassword`: extend to customers (third lookup) so they can self-serve reset.
  - first-login forced password set reuses **`changeUserPassword` equivalent**: add `changeCustomerPassword` (or generalize) so `POST /auth/password` works for a customer principal.
- **Email-namespace disjointness**: customer create rejects an email already used by an admin or staff user (including soft-deleted), and vice-versa (extend the existing cross-collection guards).

## 4. Customer module (`backend/src/modules/customer/`)

Vertical slice cloning `department` (master-data) + `user` (searchable list + emailed credentials):

- `customer.repository.ts` — **only** place Prisma is touched. CRUD for Customer + nested Project/CatalogueItem/Site. `findById`, `findByEmail(...)`, `findByEmailIncludingDeleted`, searchable/paged `findMany(filters, skip, take, sort)` + `count`, `findByResetTokenHash`. Maintains `nameLower`/`skuLower`. Per-customer scoping helper for nested reads.
- `customer.service.ts` — business logic:
  - `createCustomer`: allocate `CUST-###` via `Counter`, validate email disjoint, generate temp password (CSPRNG) → bcrypt(12), `mustResetPassword: true`, persist, audit `customer.created`, fire-and-forget `sendTemplatedEmail("customer.created", email, vars, { force: true })`.
  - update/delete (soft) customer, nested project/catalogue/site CRUD, P2002 conflict → `conflict(...)`.
  - `toPublic` / `toAdminDto` mappers (never expose `passwordHash`, reset fields). Customer-facing DTO **excludes all monetary fields** (none exist yet — invariant for when they do).
- `customer.controller.ts` — thin; admin CRUD + the customer-facing read endpoints.
- `customer.validation.ts` — zod bodies.
- `customer.routes.ts` — two surfaces:
  - **Admin/PM** (`requirePermission("customers.*")`): `/customers` CRUD + nested.
  - **Customer-facing** (`requireCustomer`): `GET /customer/me`, `GET /customer/catalogue`, `GET /customer/stock` (scoped by `req.principal.customerId`).
- Mount both in `routes/index.ts`.

### Stock seam (`customer.stock.service.ts`)
```
interface CustomerStock { available: boolean; items: StockItem[]; movements: StockMovement[]; }
async function getCustomerStock(customerId: string): Promise<CustomerStock>
```
Single impl today: if `!env.FEATURE_CUSTOMER_STOCK` → `{ available: false, items: [], movements: [] }`. Documented as the swap point for the future inventory read-model.

## 5. Permissions + seed + email

- **`modules/role/permissions.ts`**: add `customers` group → `customers.view / create / edit / delete`. (The customer principal's own `stock.view` is a fixed code constant, NOT a role.)
- **`db/seed.ts`**: grant `customers.*` to the system-admin role; idempotent startup grant for already-seeded DBs (mirror `LEGACY_PERMISSION_EXPANSION`). The vestigial empty `customer_pm` *role* (seed.ts:34) is removed — customers are a separate principal type, not a role-based user.
- **`modules/email/emailTemplate.defaults.ts`**: add `customer.created` template (category `account`): vars `{ customerName, contactPerson, email, temporaryPassword, loginLink }`. Create-only seed.
- **`config/env.ts`**: add `FEATURE_CUSTOMER_STOCK` (zod boolean, default false).

## 6. Frontend

- **`types/auth.ts`**: add `CustomerPrincipal` (`type:"customer"`, customerId, email, name, customerCode, mustResetPassword, permissions) to `Principal`.
- **`lib/auth.ts`**:
  - `homeFor`: `principal.type === "customer"` → `/customer/stock`.
  - `canAccessDashboard`: customers → false.
  - `principalCan`: customer branch (uses `permissions`, never throws).
- **`components/auth/AuthGuard.tsx`**: a `customer` principal hitting `/dashboard` (no `requireType` match) is redirected to `homeFor(principal)` — admin shell stays customer-free. Customer subtree uses `requireType="customer"`.
- **`app/customer/`** (new): `layout.tsx` (thin `CustomerShell`: brand + customer name + logout; reuse appearance CSS vars), `stock/page.tsx`.
- **`components/customer/`**: `CustomerShell.tsx`, `CustomerStockView.tsx` (cloned from `DepartmentsView.tsx`, all mutation/`can*` controls removed; renders "No stock data yet" empty state driven by API `available:false`).
- **`services/customer.service.ts`**: wraps `api()`, `registerClientCache`; admin CRUD + customer-facing reads.
- **Admin UI** under `/dashboard` (gated by `customers.*`): customer list/detail/create/edit + nested projects/catalogue/sites, following `users-roles`/`departments` patterns. Add a `customers` `DASHBOARD_SECTIONS` entry + nav item.

## 7. Build order

1. Schema + `pnpm prisma:generate`.
2. Auth plumbing (jwt, principal, actor fix, requireAuth/requireCustomer, login/refresh/reset, password set).
3. Customer module (repository → service → controller → validation → routes → mount).
4. Permissions, seed, email template, env flag, stock seam.
5. Backend verify: `pnpm prisma:generate && pnpm typecheck && pnpm lint`.
6. Frontend auth/routing (types, lib/auth, AuthGuard, service).
7. Customer portal subtree.
8. Admin customer master-data UI + nav.
9. Frontend verify: `pnpm build && pnpm lint`.
10. Code review + fixes.

## 8. Out of scope (deferred, behind the seam)

- Live stock counts, dispatched/received **movement ledger**, serialized **high-value** tracking — need Stock/IRM/Warehouse modules.
- Customer **reports / CSV-Excel export** (qty + dates + engineer + site + project filters) — need the Job system for attribution.
- Stock-dispatched **notifications** to the customer dashboard (Flow 13).

## 9. Open client question (non-blocking; safe default applied)

Docs contradiction: a "£10,000" high-value label vs. the hard "**NO pricing shown to customers**" rule, and the exact customer-visible field allow-list is unanswered (`Client_Requirements` item 10). **Default built:** never render monetary values; "high value" is a boolean/tier flag. Only affects the deferred report exporter — confirm with client before building it.
