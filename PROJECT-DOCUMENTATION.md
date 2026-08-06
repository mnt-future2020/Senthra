# Senthra — Codebase Documentation

> Auto-generated documentation based on full codebase analysis.
> Generated on: 2026-07-22

## Table of Contents

1. [Overview](#1-overview)
2. [Tech Stack & Dependencies](#2-tech-stack--dependencies)
3. [Project Structure](#3-project-structure)
4. [Architecture](#4-architecture)
5. [Getting Started](#5-getting-started)
6. [Environment Variables](#6-environment-variables)
7. [Database Schema & Models](#7-database-schema--models)
8. [API Reference](#8-api-reference)
9. [Features & Modules](#9-features--modules)
10. [Authentication & Authorization](#10-authentication--authorization)
11. [Core Business Logic Flows](#11-core-business-logic-flows)
12. [Patterns & Conventions](#12-patterns--conventions)
13. [Third-Party Integrations](#13-third-party-integrations)
14. [Testing](#14-testing)
15. [Deployment & CI/CD](#15-deployment--cicd)
16. [Known Tech Debt & Observations](#16-known-tech-debt--observations)

---

## 1. Overview

**Senthra** is a **stock & inventory management system** built by **MnT (Magizh NexGen Technologies)** for a **UK telecom field-services company**. The client installs and maintains telecom hardware at end-customer sites (customers like BT, Vodafone, Electra Networks) using a fleet of 40–60 field engineers driving vans, coordinated by Project Managers, Warehouse Managers, Finance, and HR.

**The problem it solves:** the business juggles two distinct kinds of stock — **customer-owned equipment** (consignment hardware identified by per-customer SKU/part codes) and **IRM** (company-owned Installation/Raw Materials: cables, connectors, consumables) — across multiple warehouses, dozens of mobile engineer vans, and multiple end customers, with no single source of truth. Senthra tracks every unit end-to-end (supplier → warehouse → engineer's van → customer site → return/damage), enforces a full audit trail, gives each role its own dashboard (admin suite, engineer portal, read-only customer portal), and produces finance-ready data. It is UK-localised throughout: GBP (integer pence), DD/MM/YYYY, Europe/London timezone, UK postcode validation and geocoding.

### Key domain terminology

| Term | Meaning |
|---|---|
| **IRM** | Installation / Raw Materials — company-owned stock catalogue (cables, connectors, tools). Codes `IRM-0001`. |
| **Customer stock** | Equipment owned by a specific end customer, held on consignment (`CustomerStockEntry`), kept strictly separate from IRM. |
| **PRF** | Purchase Requisition Form (`PurchaseRequest`, `PRF-0001`) — internal request that precedes a PO. |
| **PO** | Purchase Order raised to a supplier (`PO-0001`). |
| **GRN** | Goods Received Note (`GoodsReceipt`, `GRN-0001`) — receiving a delivery against a PO. |
| **Van stock** | Stock held on an engineer's van (`EngineerStockBalance` for IRM, `EngineerCustomerStockHolding` for customer stock). |
| **VSR** | Van Stock Request (`VSR-0001`) — non-job engineer restock/return, plus walk-in issue. |
| **JKR / Kit request** | Job Kit Request (`JKR-0001`) — field engineer requests extra kit for a live job; approved per-line from a warehouse or another engineer's van. |
| **Job Pack** | A job (`JOB-2026-0001`) with its kit lines (customer stock + IRM + misc), site, deadline, priority, assigned engineer. |
| **GM** | Goods Management movement (`GM-0001`) — job-scoped issue/return/consume scan session. |
| **Senthra Code** | Manual fallback code when a Code-128 barcode isn't scannable (per-customer format, e.g. `CSE-00001`). |

Supporting docs live in [docs/](docs/): [Senthra_Complete_Business_Flow.md](docs/Senthra_Complete_Business_Flow.md) (14 operational flows), [ARCHITECTURE.md](docs/ARCHITECTURE.md), [Client_Requirements.md](docs/Client_Requirements.md), Figma diagram exports in [docs/diagrams/](docs/diagrams/), and a spec-driven paper trail (16 design specs, 9 implementation plans) in [docs/superpowers/](docs/superpowers/).

---

## 2. Tech Stack & Dependencies

Two independent apps in one git repo (not a workspace — each has its own `package.json`, lockfile, and install). Both use **pnpm** and TypeScript strict mode.

### Backend (`backend/`) — Express 5 + Prisma (MongoDB), Node ≥ 20, ESM

| Purpose | Packages |
|---|---|
| HTTP framework | `express` ^5.2, `cors`, `helmet`, `cookie-parser`, `cookie`, `express-rate-limit` |
| Database/ORM | `@prisma/client` ^6.19 (MongoDB connector; requires a replica set for transactions) |
| Auth & crypto | `jsonwebtoken`, `bcryptjs`, `google-auth-library` |
| Validation | `zod` ^4 |
| Email | `nodemailer` |
| Realtime | `socket.io` |
| Media/documents | `cloudinary` (uploads), `pdfkit` (PO PDFs), `bwip-js` (Code-128 barcodes) |
| Config | `dotenv` |
| Dev/test | `tsx` (dev runner), `typescript` ^6, `vitest` ^4, `eslint` 9 flat config + `typescript-eslint` |

### Frontend (`frontend/`) — Next.js 16 (App Router) + React 19

| Purpose | Packages |
|---|---|
| Framework | `next` 16.2, `react` / `react-dom` 19.2 |
| UI system | shadcn-style components over `@base-ui/react` + `@radix-ui/react-slot`, Tailwind CSS v4, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, `lucide-react`, `vaul` (drawers), `sonner` (toasts), `next-themes` |
| Data/tables/charts | `@tanstack/react-table`, `recharts` 3 |
| Drag & drop | `@dnd-kit/*` |
| Networking | `axios` (REST), `socket.io-client` (realtime) |
| Domain utilities | `@zxing/browser` (barcode scanning), `xlsx` (Excel site import/export), `zod` |
| Dev/test | `typescript` 5, `eslint` + `eslint-config-next`, `vitest` 4 |

⚠️ The frontend is a **customized Next.js 16 build with breaking changes vs. stock Next.js** — [frontend/AGENTS.md](frontend/AGENTS.md) instructs developers/agents to read `node_modules/next/dist/docs/` before writing Next.js code. Observed Next 16 patterns: async `cookies()`, `generateMetadata` + `React.cache`, `<Link onNavigate>`, `useSearchParams` requiring `<Suspense>`.

---

## 3. Project Structure

```
e:\Senthra
├── CLAUDE.md                  # AI/dev instructions for the repo
├── docs/                      # Business flows, architecture, client requirements, diagrams, specs/plans
├── reference/                 # Reference material
├── backend/
│   ├── api/index.js           # Vercel serverless entry (exports the compiled Express app)
│   ├── prisma/schema.prisma   # Single Prisma schema (~2,260 lines, ~60 models)
│   ├── vercel.json            # Rewrites all requests to /api
│   └── src/
│       ├── server.ts          # Local entry: seed → http server → socket.io → listen
│       ├── app.ts             # Express app assembly (middleware chain, routes, error handler)
│       ├── config/env.ts      # THE ONLY place process.env is read (zod-validated)
│       ├── db/seed.ts         # Idempotent startup seed (admin, roles, types, email templates, partial indexes)
│       ├── lib/               # prisma client + withTransaction, mailer, cloudinary, geocode, realtime (socket.io), warehouse-access
│       ├── middleware/        # auth (requireAuth/requirePermission/...), error, rateLimit, validate
│       ├── routes/index.ts    # Route aggregator: mounts every module router
│       ├── types/             # Express request augmentation, Principal union
│       ├── utils/             # HttpError, jwt, cookies, crypto, password, pagination, search, slugify, template-render, time-buckets, procurement-diff, ...
│       └── modules/           # 30 domain modules, each a vertical slice:
│           │                  #   <domain>.routes.ts / .controller.ts / .service.ts / .repository.ts / .validation.ts
│           ├── auth/ user/ role/ settings/ email/ audit/ dashboard/ geo/ document/
│           ├── category/ customer/ department/ engineer/ jobTitle/
│           ├── supplier/ supplier-type/ warehouse/ warehouse-type/
│           ├── irm/ irm-category/ irm-type/
│           ├── purchase-request/ purchase-order/ goods-in/
│           ├── inventory/ goods-management/ engineer-stock/ engineer-transfer/
│           └── job/ job-kit-request/ van-stock-request/
└── frontend/
    ├── AGENTS.md              # "This is NOT the Next.js you know" — Next 16 guidance
    └── src/
        ├── app/               # App Router: /login, /forgot-password, /reset-password, /dashboard/** (one nested layout)
        ├── components/
        │   ├── ui/            # shadcn-style primitives (Field, Select, Modal, Pagination, FormScaffold, ...)
        │   ├── auth/          # AuthGuard, PermissionGate, FirstLoginGate, AuthLayout
        │   └── dashboard/     # Feature trees: shell/, home/, customers/, jobs/, inventory/, irm/,
        │                      #   purchase-orders/, purchase-requests/, goods-in/, goods-management/,
        │                      #   suppliers/, warehouses/, engineer/, portal/, audit/, settings/, account/
        ├── hooks/             # useAuth, useDashboard, useBranding, useReferenceData, useBarcodeScanner, socket hooks
        ├── lib/               # api.ts (axios wrapper), auth.ts, appearance.ts, socket.ts, clientCache.ts, utils.ts
        ├── providers/         # AuthProvider, DashboardProvider, BrandingProvider, NavigationGuardProvider
        ├── services/          # ~30 typed per-domain API wrappers (*.service.ts)
        └── types/             # Shared TS types for every domain
```

---

## 4. Architecture

### Overall pattern

A **two-app modular monolith**: a layered Express REST API (domain modules as vertical slices) and a Next.js App Router SPA-style dashboard. The frontend talks to the backend over HTTP with **httpOnly cookie auth** (`withCredentials`), so both must run together in development. Realtime updates flow over a single Socket.IO connection sharing the same cookie auth.

### Backend layering (strict, enforced by convention)

```
route → middleware (rateLimit → requireAuth → requirePermission → validateBody) → controller → service → repository → Prisma
```

- **Controllers** are thin `asyncHandler` wrappers — no business logic; they call the service and `res.json`. Cookies are set in controllers (HTTP concern at the edge).
- **Services** hold all business logic; return data or `throw new HttpError(status, message)`. Tokens are generated in services.
- **Repositories are the ONLY place Prisma is touched** — one per model, living in the owning module. Cross-module access goes through the other module's repository/service via the `#modules/*` import alias.
- **Error middleware** ([error.middleware.ts](backend/src/middleware/error.middleware.ts)) converts thrown errors to `{ error: message }` JSON; maps Prisma P2023/P2025 → 404 and P2002 → 409; logs only 5xx; never leaks 500 details.

### Bootstrap

- **Local / long-lived** ([server.ts](backend/src/server.ts)): `seedDatabase()` → wrap `app` in `http.createServer` → `initRealtime(httpServer)` (socket.io on the same port) → `listen(env.PORT)` → graceful SIGINT/SIGTERM shutdown (`prisma.$disconnect`).
- **App assembly** ([app.ts](backend/src/app.ts)), middleware in exact order: `trust proxy 1` → `helmet` → `cors({ origin: env.FRONTEND_URL, credentials: true })` → `express.json({ limit: "5mb" })` → `cookieParser()` → routes → `notFound` → `errorHandler`.
- **Vercel serverless** ([api/index.js](backend/api/index.js)): imports the compiled `dist/app.js` and exports it as the handler — no listen, no seed, and **no socket.io** on this path.

### Frontend architecture

- **App Router does routing only** — nearly every `page.tsx` mounts a feature component from `components/dashboard/**` behind `<PermissionGate>`/`<Suspense>`. One nested layout: `/dashboard/layout.tsx` wraps everything in `DashboardProvider → AuthGuard → FirstLoginGate → DashboardShell`.
- **All API access goes through [src/lib/api.ts](frontend/src/lib/api.ts)** — an axios wrapper that sends cookies, silently refreshes once on 401 (de-duplicated: one in-flight `POST /auth/refresh` shared by concurrent 401s) and replays the request, and throws a typed `ApiError` carrying the server message and status. Components never call axios/fetch directly — they call typed functions in `src/services/*.service.ts`.
- **Global state via Context providers** mounted in layouts, consumed only through hooks (`useAuth`, `useDashboard`, `useBranding`): `BrandingProvider` (SSR-seeded branding, live `document.title`/favicon sync), `AuthProvider` (principal + `can(permission)`, validates session on mount), `DashboardProvider` (theme/density/radius + toast queue; accent derived from branding).
- **Realtime**: one ref-counted Socket.IO connection per tab ([lib/socket.ts](frontend/src/lib/socket.ts)); hooks (`useJobSocket`, `useGoodsSocket`, `usePurchaseOrderSocket`, `usePurchaseRequestSocket`) subscribe and refetch on events. Server payloads are scope-agnostic refetch signals (`{id, code, status}`) — clients re-pull through their own permission/warehouse-scoped REST call, so shared rooms leak nothing.
- **Client caches**: many services keep in-memory SWR-style caches registered with [lib/clientCache.ts](frontend/src/lib/clientCache.ts) and cleared on logout, so a second user on the same tab never sees the first user's data.

### Request lifecycle (typical authenticated write)

```
Browser (service fn → api()) ──cookie senthra_access──►
Express: helmet/cors/json/cookieParser
  → module router: writeLimiter → requireAuth (JWT + live Session check + principal load)
  → requirePermission("x.y") → validateBody(zodSchema)
  → controller (asyncHandler, actorFrom(req))
  → service (business rules; withTransaction for multi-write; HttpError on violation)
  → repository (Prisma)
  ← service: audit.record(...) fire-and-forget; emitToRoom/emitToUser realtime signal
  ← controller res.json ── errors: errorHandler → { error } JSON
```

---

## 5. Getting Started

**Prereqs:** Node ≥ 20, pnpm, a MongoDB **replica set** (Atlas or local rs) — Prisma transactions require it.

```bash
# Backend
cd backend
pnpm install
cp .env.example .env          # fill DATABASE_URL, JWT_SECRET, REFRESH_SECRET, ENCRYPTION_KEY (64 hex), ADMIN_EMAIL/PASSWORD
npx prisma db push            # push schema + indexes to MongoDB (also regenerates client)
pnpm dev                      # tsx watch, serves on :8000; seeds admin/roles/templates on startup

# Frontend (separate terminal)
cd frontend
pnpm install
echo NEXT_PUBLIC_API_URL=http://localhost:8000 > .env
pnpm dev                      # serves on :3000
```

Backend scripts: `pnpm dev` / `build` / `start` / `typecheck` / `lint` / `lint:fix` / `test` / `prisma:generate`.
Frontend scripts: `pnpm dev` / `build` / `start` / `lint` / `test`.

⚠️ **After ANY `schema.prisma` change run BOTH** `pnpm prisma:generate` (types) **and** `npx prisma db push` (applies indexes/fields to MongoDB). `prisma:generate` never contacts the DB — indexes and unique constraints silently don't exist until `db push` (this bit the project on 2026-07-17 when one push applied 29 accumulated indexes).

Sign in with the seeded super-admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD`). In dev, the login page also shows quick-login buttons driven by gitignored `NEXT_PUBLIC_QUICK_*` env vars (compiled out of production).

---

## 6. Environment Variables

### Backend ([config/env.ts](backend/src/config/env.ts) — zod-validated at startup; process exits with a clear message on failure)

| Var | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development` / `test` / `production` |
| `PORT` | no | `8000` | HTTP port (local server) |
| `DATABASE_URL` | **yes** | — | MongoDB connection string (replica set) |
| `JWT_SECRET` | **yes** | — | Access-token signing secret |
| `REFRESH_SECRET` | **yes** | — | Refresh-token signing secret (separate) |
| `ACCESS_TOKEN_EXPIRY` | no | `15m` | Access JWT lifetime |
| `REFRESH_TOKEN_EXPIRY` | no | `7d` | Refresh JWT lifetime |
| `ENCRYPTION_KEY` | **yes** | — | 64 hex chars (32 bytes) — AES-256-GCM key for at-rest secrets (SMTP password, Google client secret) |
| `FRONTEND_URL` | no | `http://localhost:3000` | CORS origin + links in emails |
| `COOKIE_DOMAIN` | no | — | Optional cookie domain |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | no | — | Cloudinary fallback creds (DB settings take precedence) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | no | — | Seeds the super-admin on first startup (skipped if unset) |
| `FEATURE_CUSTOMER_STOCK` | no | `false` | Feature flag for the live customer-stock dashboard (Flow 9) |

### Frontend

| Var | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | **yes** | Backend base URL (validated in `lib/env.ts`; throws at import if missing) |
| `NEXT_PUBLIC_QUICK_*` | no | Dev-only quick-login credentials (gitignored; `NODE_ENV`-gated out of prod) |

---

## 7. Database Schema & Models

Single schema at [backend/prisma/schema.prisma](backend/prisma/schema.prisma) (~60 models). MongoDB conventions used throughout:

- Every model: `id String @id @default(auto()) @map("_id") @db.ObjectId`.
- **No Prisma enums** — every status/type is a plain `String`, values documented inline and enforced by the service layer (zod + forward-only state machines).
- **No embedded composite types** — children (lines, attachments, serials, batches) are separate collections with real relations; free-form data uses `Json?` (`CustomerStockEntry.attributes`, `AuditLog.metadata`).
- **"Loose sockets"** — many cross-collection ObjectIds are stored *without* Prisma relations by design (e.g. `Job.createdByUserId`, `PurchaseOrder.pmUserId`, all `customerStockEntryId` refs, `jobKitLineId`); denormalized snapshots (names/emails/codes) carry the human-readable data so history survives renames/deletes.
- **Partial unique indexes built in the seed step** (not `@unique`) for nullable-unique fields: `IrmItem.skuLower`, `IrmItem.barcode`, `CustomerStockEntry.barcode` — works around prisma/prisma#23870 (non-sparse index rejecting a second null).
- **Money is integer GBP pence** (`*Pence` fields). `Counter` (key → seq) drives all human codes (`PRF-0001`, `PO-0001`, `GRN-0001`, `TRF-0001`, `ADJ-0001`, `GM-0001`, `ENG-0001`, `JKR-0001`, `VSR-0001`, `WH-0001`, `SUP-0001`, `IRM-0001`, `CUST-0001`, employee IDs).

### Models by domain

| Domain | Models | Notes |
|---|---|---|
| **Auth / platform** | `Admin`, `Settings`, `Role`, `User`, `UserWarehouseAssignment`, `CustomerUser`, `Session`, `Counter` | `Admin` is the single super-admin. `Settings` is a singleton (SMTP/Google/Cloudinary/branding/company profile/regional). `Role.permissions String[]`, plus `canHoldStock` and `isWarehouseScoped` flags. `Session` enforces logout + 2-device cap (`sid @unique`, `@@index([principalId, principalType])`). `User` soft-deletes (`deletedAt`), unique `email` and `employeeId`. |
| **Master data** | `Category` (customer-domain), `IrmCategory`, `IrmType`, `SupplierType`, `WarehouseType`, `Department`, `JobTitle` | Taxonomies share the shape `key @unique` + `nameLower @unique` (case-insensitive uniqueness). `Department`/`JobTitle` names are denormalized onto `User` and renamed via transactional cascade. |
| **Warehouses / suppliers** | `Warehouse`, `Supplier` | Rich masters: `code @unique`, UK address + geocoded lat/long (warehouse), owner User ref (supplier), soft delete, status indexes. A warehouse has no manager field — its managers are derived from `UserWarehouseAssignment`. |
| **IRM catalogue** | `IrmItem`, `IrmItemSupplier` | Item master: code, sku (mandatory, global-forever unique, auto-generated from name + category when not supplied), barcode, UoM, stock policies (reorder/min/max), `standardCostPence`, track flags (`trackInventory`, `trackSerialNumbers`, `trackBatchNumbers`). Junction ranks suppliers (`@@unique([irmItemId, supplierId])`, ≤1 primary). |
| **Procurement** | `PurchaseRequest(+Item,+Attachment)`, `PurchaseOrder(+Item,+Attachment)` | Lines snapshot item name/sku/unit and hold `quantity`, `unitPricePence`, `vatRate`; header roll-ups `subtotal/vat/grandTotalPence`. `PurchaseOrderItem.receivedQuantity` is the Goods-In seam. `@@unique([purchaseRequestId, irmItemId])` / `([purchaseOrderId, irmItemId])`. One PO per PRF enforced transactionally (deliberately not `@unique`). |
| **Goods In** | `GoodsReceipt(+Item,+Serial,+Batch,+Attachment)` | GRN against a PO; per line `ordered/previouslyReceived/received/damaged/accepted`. Serial uniqueness backstop `@@unique([irmItemId, serialLower])`. |
| **Warehouse inventory** | `InventoryBalance`, `InventoryTransaction`, `StockTransfer`, `StockAdjustment` | Balance: `@@unique([irmItemId, warehouseId])`, `quantityOnHand`/`quantityReserved`. Transaction: immutable append-only ledger (`quantityDelta`, `type`, `sourceType/sourceId/sourceCode`, `balanceAfter`). |
| **Engineer / van stock** | `EngineerStockBalance`, `EngineerStockTransaction`, `EngineerCustomerStockHolding`, `EngineerCustomerStockTransaction`, `EngineerStockTransfer(+Line)`, `VanStockRequest(+Line)`, `VanStockFulfilment(+Line)` | Engineer twins of the warehouse primitives (`@@unique([irmItemId, engineerId])` etc.). Transfers preserve ownership (`company`/`customer`) per line. VSR lines carry `approvedQty/fulfilledQty/closedShortQty` + per-line `sourceWarehouseId`. |
| **Goods management (jobs)** | `JobStockMovement(+Line)`, `JobKitRequest(+Line)`, `DamagedStockBalance`, `DamagedStockTransaction`, `JobStockSummary` | Movement = scan session (`direction: issue/return/consume`). Kit-request lines carry per-line `sourceType/sourceWarehouseId/sourceEngineerId`. Damaged pool keyed `@@unique([warehouseId, ownerType, irmItemId, customerStockEntryId])`. `JobStockSummary` is 1-to-1 with Job (`goodsStatus`). |
| **Customers** | `Customer`, `CustomerProject`, `CustomerSite`, `CustomerStockRequest`, `CustomerStockWarehouseAssignment`, `CustomerStockEntry` | Customer company doubles as portal tenant (`email @unique`). Projects unique per customer by `nameLower`; sites by `code`. Stock request → warehouse assignment (split across warehouses) → stock entry (received consignment; `attributes Json` for per-category dynamic fields). |
| **Jobs** | `Job`, `JobKitLine` | `jobNumber @unique`; full status/workflow snapshots; kit lines typed `customer_stock/irm/misc`, `hasVanSource` flag for away-from-home returns. |
| **Email / audit** | `EmailTemplate`, `EmailLog`, `AuditLog` | Templates admin-editable, keyed, versioned. AuditLog is immutable with actor snapshot. |

For every field/attribute, see the schema file itself — it is heavily commented and is the source of truth.

---

## 8. API Reference

All routes are mounted in [routes/index.ts](backend/src/routes/index.ts). `GET /` is a public health check. Every module router applies `requireAuth`; per-route guards are shown as *(permission)*. Writes additionally pass `writeLimiter` (60/min) and zod `validateBody`; auth endpoints have dedicated limiters. Errors are `{ error: message }` with proper status codes.

### Auth — `/auth`
| Method & path | Auth | Notes |
|---|---|---|
| POST `/auth/login` | public (loginLimiter 10/5min) | `{email, password, remember?}` → sets `senthra_access`/`senthra_refresh` cookies, returns `{token, principal}` |
| POST `/auth/google` | public | Google ID token sign-in (`{credential}`) |
| GET `/auth/google/config` | public | `{enabled, clientId}` |
| POST `/auth/refresh` | refresh cookie (30/5min) | Re-issues both tokens (same session `sid`) |
| POST `/auth/forgot-password`, `/auth/reset-password` | public (limited) | Token-hash reset flow; generic responses (no enumeration) |
| GET `/auth/me` | auth | Current principal |
| PATCH `/auth/credentials` | admin only | Super-admin email/password change |
| POST `/auth/password` | auth | Own password change (staff/customer); first-login forced change allowed without current password |
| POST `/auth/logout` | auth | Ends this device's session |
| GET `/auth/sessions`, POST `/auth/sessions/revoke-others` | auth | Device/session management |

### Users, Roles, Settings, Email templates, Audit, Dashboard, Geo
| Area | Routes (permission) |
|---|---|
| `/users` | GET/PUT `/me`, POST/DELETE `/me/signature` (self, staff only); GET `/` *(users.view)*; POST `/` *(users.create)*; GET/PUT `/:id`, PATCH `/:id/status`, POST `/:id/resend-invite` *(users.edit)*; DELETE `/:id` *(users.delete)*. Create returns a one-time `temporaryPassword`. |
| `/roles` | GET `/` *(roles.view or users.create/edit)*; GET `/permissions` (permission catalog for the role matrix); GET `/:id`; POST/PUT/DELETE *(roles.create/edit/delete)* — with sanitize/implied-permission/no-escalation guards. |
| `/settings` | GET `/branding` (**public** — pre-auth branding); GET `/` *(settings.view)*; PUT `/` *(settings.manage)*; POST `/email/test` *(settings.manage, testEmailLimiter)*; POST `/branding/upload` *(settings.manage)*. |
| `/email-templates` | GET `/`, `/:id`, POST `/:id/preview` *(email_templates.view)*; POST `/`, PUT `/:id`, PATCH `/:id/enabled`, POST `/:id/duplicate|restore|test`, DELETE `/:id` *(email_templates.manage)*. |
| `/audit` | GET `/`, `/facets`, `/export.csv` *(audit.view; export also exportLimiter)* — filters, facets, CSV with formula-injection defense, 50k cap. |
| `/dashboard` | GET `/summary?spendPeriod=12m|90d|30d` — auth only; each section permission-gated inside the service (cards, PO pipeline, spend trend, "Awaiting Your Action" worklist, activity feed). |
| `/geo` | GET `/postcode/:postcode` — UK postcode → city/county via postcodes.io. |

### Master data
| Area | Routes |
|---|---|
| `/categories`, `/irm-categories`, `/irm-types`, `/supplier-types`, `/warehouse-types` | Uniform taxonomy CRUD: GET `/`, GET `/:idOrKey`, POST, PUT `/:id`, DELETE `/:id`. View/create also granted to the owning entity's create/edit permissions (form pickers + inline create). Delete blocked while in use (409 with count). |
| `/departments`, `/job-titles` | GET/POST/PUT/DELETE reusing `users.*` permissions; rename cascades to `User.department`/`User.jobTitle` in a transaction. |
| `/suppliers` | CRUD *(suppliers.view/create/edit/delete)* — `SUP-####` codes, PATCH change-detection audit events, payment-terms rules ("Custom" requires text), soft delete blocked by PRF/PO/GRN/catalogue usage. |
| `/warehouses` | GET `/engineer-options` (role `canHoldStock`), `/options`; CRUD *(warehouse.\*)* — `WH-####`, postcode geocoding, single-default enforcement, warehouse-scoped visibility, soft delete guarded by dependencies. Also hosts the customer pending-stock router. |
| `/irm-items` | CRUD *(irm.\*)*; POST `/:id/generate-barcode` *(irm.barcode.manage)* — Code-128 PNG of the item code. SKU mandatory on create + update (generated from name + category when blank), global-forever unique and refused if it collides with any item code; supplier links reconciled transactionally; soft delete guarded by PO/GRN/inventory/engineer-stock usage. |

### Customers & portal
| Area | Routes |
|---|---|
| `/customers` (admin) | CRUD *(customers.\*)*; nested projects *(customer_projects.\*)*, sites incl. `POST /:id/sites/bulk` *(customer_sites.\*, bulkWriteLimiter)*, portal users + invites/resets *(customer_portal.\*)*; stock requests: list *(stock_requests.view)*, create/approve/edit-approve/assign-warehouses *(stock_requests.approve)*, reject *(stock_requests.reject)*. |
| `/customer` (portal) | `requireCustomer`; read-only: `/profile`, `/overview`, `/projects`, `/sites`, `/stock`, `/stock-entries`, `/stock-requests`; the single write POST `/stock-requests` (queues a review — never writes stock). |
| `/stock-assignments`, `/stock-entries` | Receive assignments *(stock_requests.complete)*; stock-entry read/update/delete/barcode/direct-create/transfer *(customer_stock.\*)*. |

### Operations
| Area | Key routes |
|---|---|
| `/purchase-requests` | CRUD *(purchase_requests.\*)* + workflow: `submit`, `approve`, `reject`, `reopen`, `cancel`, `convert` (→ PO, one per PRF forever), `duplicate` (revision of a converted PRF), attachments. |
| `/purchase-orders` | CRUD + `/split` (multi-warehouse split into one PO per warehouse, single transaction); workflow: `submit`, `approve` (PRF fast-path when commercially identical), `reject`, `assign-pm`, `send` (emails supplier w/ PDF + archives immutable "Issued PO" copy), `accept` (supplier acceptance event, `confirmedDeliveryDate`), PATCH `/delivery-date`, `cancel`, `close`; GET `/:id/pdf`, `/pm-candidates`, `/items/:irmItemId`, `/suppliers/:supplierId/summary`. |
| `/goods-in` | GRN CRUD *(goods_in.\*)*; `complete` (the only inventory write — validates against PO remaining, accepted-only enters stock), `cancel`, attachments. Serial/batch enforcement per IRM track flags. |
| `/inventory` | List/detail/transactions/purchases *(inventory.view)*; `positions` + `summary` (Inventory Hub aggregation across warehouse/engineer/customer/damaged); `movements` (unified cursor-paginated ledger across 4 transaction collections); `transfers` (warehouse↔warehouse, `TRF-####`) *(inventory.move)*; `add-stock` / `adjust` (`ADJ-####`) *(inventory.adjust)*; CSV exports *(inventory.export)*; per-item distribution/holders/jobs; engineer inventory lenses. |
| `/goods-management` | `queue`, `demand`, `/jobs/:jobId` *(goods_management.view / inventory.view)*; `scan-lookup`; `/jobs/:jobId/issue` *(goods_management.issue)*, `/return` *(goods_management.receive_return)*, `/close` *(goods_management.reconcile)*; `damaged` + `damaged/restore`; `overdue`; `damage-photo` upload. |
| `/jobs` | CRUD *(jobs.\*)* + `assign`, `cancel`. Engineer accept/reject/start/complete live under `/engineer`. |
| `/job-kit-requests` | Engineer: `mine`, `item-search`, POST `/` *(engineer.jobs.request_kit)*; Reviewer: list, `pending-count`, `/:id/line-holders`, `approve` (per-line sourcing: warehouse or engineer van; resumable checkpointed approval), `decline` *(jobs.kit_request.review)*; `cancel` (requester). |
| `/van-stock-requests` | Engineer: `mine`, `my-holdings`, POST `/` (restock/return), `cancel`, `cancel-remaining` *(engineer.van_stock.request)*; Reviewer: list, `approve` (per-line source warehouse + availability hard-block), `decline`, `fulfil` (atomic scan posting), `close-short`, `walk-in` (pre-approved issue), `scan-lookup` *(van_stock_request.review)*. |
| `/engineer-transfers` | `holders`, `mine`, `company-search`, `customer-search`, `/:id`; admin: list, `holdings/:engineerId` *(engineer_stock.view/transfer)*; POST `/`, `approve` (holder), `decline`, `cancel`, `override` (admin force), `acknowledge` (signature) *(engineer.transfer / engineer_stock.transfer)*. |
| `/engineer` (portal) | `overview` *(engineer.dashboard.view)*; `stock`, `customer-stock`, `misc-stock`, `movements` *(engineer.inventory.view)*; `jobs`, `jobs/:id` *(engineer.jobs.view)*; POST `jobs/:id/accept|reject|start|complete` *(engineer.jobs.\*)* — all scoped to the authenticated engineer's own id, never a route param. |

Request-body shapes are defined per module in `*.validation.ts` (zod) — the schema names match the route table above (e.g. `createKitRequestSchema`, `postMovementSchema`, `updateSettingsSchema`).

---

## 9. Features & Modules

### Backend module archetypes

The 30 modules fall into recognisable shapes:

- **Taxonomy masters** (category, irm-category, irm-type, supplier-type, warehouse-type): identical CRUD slices with case-insensitive name uniqueness (`nameLower`), slugified keys, grouped-count in-use guards on delete, and `requireActiveX(id)` seams consumed by their parent modules.
- **Rich entity masters** (supplier, warehouse, irm, customer): `Counter`-allocated display codes, PATCH change-detection emitting granular audit events (`x.activated`, `x.deactivated`, …), dependency-checked **soft delete**, picker option routes placed before `/:id`.
- **Employee masters** (department, jobTitle): denormalized names cascaded onto `User` transactionally on rename.
- **Workflow documents** (purchase-request, purchase-order, goods-in, job, job-kit-request, van-stock-request, engineer-transfer): forward-only status machines (`ALLOWED_TRANSITIONS` + `assertTransition`), workflow stamp fields (`submittedBy/At`, `approvedBy/At`, …), fire-and-forget templated emails and realtime emits after commit.
- **Stock primitives** (inventory, engineer-stock, goods-management repositories): balance upserts with a **zero-floor guard** (negative balance → conflict → transaction rollback) + append-only ledgers with `balanceAfter` snapshots. `inventoryService.applyInbound/applyOutbound` is the single write seam every other module uses to touch warehouse stock.
- **Platform services** (auth, user, role, settings, email, audit, dashboard, geo, document): cross-cutting identity, configuration, notification, and reporting.

### Feature highlights (end-to-end)

- **Customer management**: company + projects + sites (bulk Excel import with per-row validation and geocoding) + portal users (invite emails with one-time temp passwords). Creating a customer provisions the first portal login atomically (rolls back the company if user creation fails). Customer **stock requests** flow: portal submit → admin approve/edit-approve/reject → warehouse assignment (splittable across warehouses, quantities must sum) → warehouse receive (optimistic-locked) → `CustomerStockEntry` (draft → active requires category + barcode).
- **Procurement**: PRF with quotation capture and attachments → finance approval → one-shot conversion to PO (lines copied verbatim — finance approved those prices). PO supports direct creation, multi-warehouse split, PM routing, supplier send (PDF generated by the **document module** with company letterhead + issuer signature; emailed and archived immutably), supplier acceptance as a recorded event with confirmed delivery date, and receipt tracking driven by Goods-In.
- **Goods-In (GRN)**: draft receipts against a sent PO; `damaged = received − accepted` derived server-side; serial numbers (exactly `accepted`, globally unique per item) and batches enforced per item track flags; completion is one transaction advancing the PO and crediting only accepted stock into inventory.
- **Inventory Hub**: unified `StockPosition` view across five pools (warehouse, engineer IRM, customer entries, engineer customer holdings, damaged), unified movement ledger (cursor-paginated union of four transaction collections — pricing-free by construction), warehouse transfers, manual add/adjust with reasons, CSV exports, per-item distribution/holders/jobs drilldowns.
- **Jobs & goods management**: job packs with typed kit lines; engineer accept/start/complete lifecycle; scan-driven issue (warehouse→van), return (van→warehouse or damaged pool, with per-warehouse return caps and away-from-home van returns), consume-on-complete, close-and-reconcile with lost-stock write-off; `JobStockSummary.goodsStatus` state machine locks reconciled jobs.
- **Kit requests (JKR)**: engineer requests extra kit on a live job; PM approves with **per-line sourcing** — each line from a chosen warehouse or another engineer's van; approval atomically grows the job kit, creates one holder-approved transfer per source engineer, and is **resumable** (checkpointed; failure reverts to pending without duplicating transfers).
- **Van stock (VSR)**: engineer restock (approve → scan-out fulfil) and return (scan-in *is* acceptance) flows plus reviewer walk-in issue; per-line approved quantities, source warehouses, close-short, cancel-remaining; canonical line math lives in the repository (single source of truth).
- **Engineer transfers (ENG)**: van-to-van hand-over with holder approval, admin override, optional signature acknowledgment (Cloudinary), ownership preserved per line (company vs customer), and job attribution movements when fulfilling kit requests.
- **Dashboard home**: permission-gated KPI cards, PO pipeline, spend trend (time-bucketed), "Awaiting Your Action" worklist merging up to 8 queues, business activity feed (audit minus `auth.*` noise). Sections degrade independently via `Promise.allSettled`.
- **Settings**: singleton config — Google OAuth, SMTP (encrypted password, test send), Cloudinary (encrypted secret), branding (name/color/logo/favicon/login copy — public endpoint feeds the pre-auth login page and SSR), code prefixes, company legal profile (feeds PO PDFs), regional formats, engineer-transfer signature policy.
- **Email**: DB-backed templates (admin edits plain text with `{{tokens}}`; branded HTML generated server-side), per-template enable/disable, preview/test/restore-default, every send logged to `EmailLog`. ~14 system templates triggered from user/customer/auth/job/PRF/PO events.
- **Audit**: explicit fire-and-forget `audit.record(...)` calls at every mutation (not middleware); actor snapshotted; filterable list + facets + CSV export with formula-injection defense.

### Frontend surfaces

Three permission-driven navigation sets rendered by [Sidebar.tsx](frontend/src/components/dashboard/shell/Sidebar.tsx):

- **Admin suite** (staff): Dashboard, Users & Roles, Customers, Jobs, Warehouses, Suppliers, Purchase Requests, Purchase Orders, Inventory, Settings, Audit Log. (GRN and Van Requests live inside Warehouse detail tabs; the IRM catalogue is an Inventory Hub tab.)
- **Engineer portal** (staff with `engineer.dashboard.view`): Dashboard, Jobs, Stock, Transfers, Field Stock.
- **Customer portal** (customer principals): Dashboard, Projects, Sites, My Stock, Stock Submissions, Reports — read-only except stock submissions.

Feature components follow a **View (list) / Detail / Form** trio per domain, with shared primitives (`FormScaffold`, `Field`, `Select`, `Pagination`, `StatusBadge`, …), an unsaved-changes navigation guard (`NavigationGuardProvider` + `<Link onNavigate>`), barcode scanning (`useBarcodeScanner` + `@zxing/browser`), Excel site import (`xlsx`), recharts dashboards, and a dnd-kit transfer board.

---

## 10. Authentication & Authorization

### Principals

Three principal types ([types/principal.ts](backend/src/types/principal.ts)), resolved from the JWT `actor` claim:

- **admin** — the single super-admin (`Admin` model, env-seeded). Implicit `"*"`; passes every permission gate; manages roles/permissions via admin-only surfaces.
- **user** — staff (`User`), governed by an assigned `Role` whose `permissions` array holds `resource.action` keys (or `"*"`). Roles carry `canHoldStock` (may hold van stock) and `isWarehouseScoped` (restricted to warehouses assigned via `UserWarehouseAssignment`).
- **customer** — external portal user (`CustomerUser` under a `Customer`), fixed permission set `["stock.view"]`, never role-governed.

### Token & session mechanics

- **Cookies** ([utils/cookies.ts](backend/src/utils/cookies.ts)): `senthra_access` (httpOnly, path `/`, 1h) and `senthra_refresh` (httpOnly, path scoped to `/auth/refresh`, 7d; session cookie when `remember=false`). `secure` + `SameSite=None` in production, `Lax` in dev.
- **JWTs** ([utils/jwt.ts](backend/src/utils/jwt.ts)): access `{sub, type:"access", actor, sid}` signed with `JWT_SECRET` (15m); refresh signed with a separate `REFRESH_SECRET` (7d). `sid` binds tokens to a device session.
- **Sessions**: `MAX_DEVICES = 2` per principal (oldest evicted on new login), 7-day TTL, lazily pruned. `requireAuth` cross-checks the session is live and matches the principal on **every request** — this is where logout, password change (`endOthers`/`endAll`), and device-cap eviction take effect immediately.
- **Login** tries admin → staff → customer by email (bcrypt verify; disjoint email namespaces enforced by `assertEmailNamespaceFree`). **Google OAuth** (when enabled in Settings) verifies the ID token server-side and matches the same order; first Google sign-in clears `mustResetPassword`.
- **First-login wall**: users/customers created with a one-time temp password have `mustResetPassword=true`; `requirePermission`/`requireCustomer` block everything until they set a password (frontend shows `SetPasswordScreen` via `FirstLoginGate`).
- **Password reset**: SHA-256 token hash + 1-hour expiry stored on the owning collection; reset ends all sessions.
- **Frontend**: `AuthProvider` validates the session on mount via `GET /auth/me`; `api()` silently refreshes once on 401 and replays; `AuthGuard` renders a skeleton until the principal is known and redirects to `/login` otherwise; logout clears all client caches.

### Permission model ([modules/role/permissions.ts](backend/src/modules/role/permissions.ts))

- `PERMISSION_GROUPS` is the single catalog (categories: Access & Security, Customers, Inventory, Suppliers, Procurement, Goods Management, Jobs, Engineer Portal, System).
- Guards: `requirePermission(p)` (admin passes; else `roleGrants`), `requireAnyPermission(...)`, `requireAdmin`, `requireCustomer`.
- Role editing enforces `sanitizePermissions` (reject unknown), `applyImpliedPermissions` ("manage implies view"), and `escalationViolations` — a non-`"*"` actor can only grant permissions they themselves hold, never `"*"`. System roles are locked; `super_admin` permissions are always `"*"`.
- **Warehouse scoping** ([lib/warehouse-access.ts](backend/src/lib/warehouse-access.ts)): for `isWarehouseScoped` roles, `warehouseScopeFilter(actor)` narrows every warehouse-bound query and `assertWarehouseAccess` 403s out-of-scope writes. Assigned warehouse IDs are loaded once in `requireAuth`.
- **Realtime auth** ([lib/realtime.ts](backend/src/lib/realtime.ts)): socket handshake parses the same `senthra_access` cookie, verifies the session, joins the principal's user room plus permission-gated broadcast rooms (`OFFICE_JOBS_ROOM`, `VAN_STOCK_REVIEWERS_ROOM`, `PURCHASE_ORDER_WATCHERS_ROOM`, `PURCHASE_REQUEST_WATCHERS_ROOM`).

---

## 11. Core Business Logic Flows

### Authentication

```
Login:   Browser → POST /auth/login → auth.service.login (admin→user→customer, bcrypt)
         → startSession (2-device cap) → sign access+refresh JWTs (service)
         → controller sets httpOnly cookies → { principal }
Refresh: 401 anywhere → api.ts interceptor → POST /auth/refresh (deduplicated)
         → verify refresh JWT + live session → re-issue both tokens (same sid) → replay original request
Logout:  POST /auth/logout → endSession(sid) → clearAuthCookies → frontend clears caches
```

### Procurement: PRF → PO → GRN → Inventory

```
PRF: draft ─submit─► submitted ─approve─► approved ─convert─► converted (terminal)
        ▲               │reject / reopen──┘ (both → draft, reason required)
        └─ cancel from draft|submitted|approved → cancelled

convert (1 PO per PRF, transactional, gap-safe code allocation):
  re-read PRF in-tx → assert approved → allocate PO code in-tx → copy lines VERBATIM → PO draft → PRF converted

PO: draft ─submit─► pending_approval ─approve─► approved ─(assign-pm → pm_review)?─send─► sent
      └─ PRF fast-path: draft → approved directly iff commerciallyMatchesPrf (supplier+warehouse+currency+line multiset)
    sent ─(supplier accept event, confirmedDeliveryDate)─► supplier_accepted
    sent|supplier_accepted ─(via Goods-In only)─► partially_received → fully_received ─close─► closed
  send: emails supplier with generated PDF + archives immutable "Issued PO — as sent" attachment

GRN: draft ─complete (single transaction)─►
  1. poService.applyGoodsReceipt: re-validate remaining per line, receivedQuantity += , PO status recomputed
  2. inventoryService.applyInbound per accepted line: InventoryBalance.onHand += ; InventoryTransaction(goods_in)
  3. GRN → completed   (damaged = received − accepted is recorded but NEVER enters on-hand)
```

### Job lifecycle & goods management

```
Job created (kit lines: irm@warehouse | customer_stock | misc) ─assign─► assigned ─engineer accept─► accepted ─start─► in_progress
Issue (GM postIssue, scan): warehouse applyOutbound(−) → engineer van balance(+) + job_issue ledger
  goodsStatus: not_issued → partially_issued → issued
Kit request (JKR): engineer creates (pending) → PM approves with per-line sourcing:
  warehouse-sourced lines → job kit grows → issued via GM
  van-sourced lines → one EngineerStockTransfer per source engineer (holder approves)
    → transfer_out/in ledgers + attribution-only JobStockMovement (no balance change) + kit line hasVanSource=true
Complete: engineer declares used lines → recordConsumeAndComplete (job_consume drains van; job → completed)
  goodsStatus → awaiting_return (or reconciled if nothing left)
Return (GM postReturn): engineer van(−) → good: warehouse applyInbound(+) | damaged: DamagedStockBalance(+)
  caps: at home warehouse = issued − used − returned; away from home = van-sourced portion only
Close & reconcile: tallies per kit line, unaccounted → job_lost write-off → goodsStatus reconciled (locked)
```

### Van stock request

```
Restock: engineer creates (pending) → reviewer approve (per-line approvedQty + sourceWarehouseId; live availability hard-block)
  → scan fulfil (atomic): applyOutbound(warehouse −) → engineer van(+) + van_restock ledger
  → partially_fulfilled → fulfilled (close-short / cancel-remaining paths stamp closedShortQty)
Return: engineer creates (no approval — scan-in IS acceptance)
  → fulfil: van(−) + van_return ledger → good: applyInbound(+) | damaged: damaged pool(+)
Walk-in: reviewer creates pre-approved single-warehouse request → fulfil as restock
```

### Customer stock intake

```
Portal user submits stock request (the only portal write) → pending
Admin approve / edit-approve / reject (status only — no stock writes) → email to customer
Assign warehouses (quantities must sum to request qty) → assigned
Warehouse receives (optimistic-locked) → partially_received → completed
  → CustomerStockEntry created/topped-up (draft → active requires category + CSE barcode)
```

### Realtime

Socket.IO rooms (long-lived server only): PRF/PO watcher rooms, van-stock reviewer room, office jobs room, plus per-user rooms. Every workflow transition emits a `{id, code, status}` refetch signal after commit; frontend hooks refetch through scoped REST calls.

---

## 12. Patterns & Conventions

- **File naming**: `domain.layer.ts` (`user.controller.ts`, `admin.repository.ts`) grouped in `modules/<domain>/`.
- **ESM / NodeNext**: relative imports MUST include `.js` even in `.ts` source. Cross-module imports use the `#modules/*` subpath alias (conditional map: `development` → `src/`, `default` → `dist/`); `pnpm dev` runs `tsx --conditions=development`, typecheck/build use `customConditions`.
- **Errors**: `HttpError` + factories (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`) thrown from services; centralized error middleware; `asyncHandler` wraps every controller.
- **Validation**: zod everywhere. `validateBody(schema)` replaces `req.body` with parsed data and 400s with the first issue message. Shared primitives in [utils/validation.ts](backend/src/utils/validation.ts) (email regex blocking header injection, UK phone/postcode).
- **State machines**: forward-only `ALLOWED_TRANSITIONS` maps + `assertTransition` per workflow document; statuses are strings, never DB enums.
- **Transactions**: `withTransaction` (raised timeouts for Atlas latency) wraps every multi-write; codes allocated in-tx where rollback must reclaim numbers; optimistic concurrency via `updatedAt` re-checks and `updateMany` claims (`claimPending` pattern); Mongo write-conflict (P2034) retries.
- **Zero-floor stock invariant**: every balance decrement passes an upsert that throws `conflict` if the result would go negative, rolling back the whole transaction (`upsertBalanceTx`, `upsertEngineerBalanceTx`, `upsertCustomerHoldingTx`, `adjustCustomerStockEntryQtyTx`).
- **Ledger pattern**: append-only transaction collections with signed `quantityDelta`, `sourceType/sourceId/sourceCode` provenance, and `balanceAfter` snapshots; source documents (e.g. `JobStockMovement`) are kept distinct from ledger legs to avoid double-counting.
- **Snapshot denormalization**: workflow documents snapshot names/emails/codes at write time so history survives renames and soft deletes; "loose socket" ObjectIds intentionally skip Prisma relations.
- **Soft delete**: `deletedAt` on rich masters and workflow documents, written as explicit `null` on create (Mongo filter semantics); reads always filter `deletedAt: null`. Taxonomies hard-delete behind in-use guards.
- **Search**: user input escaped via `escapeRegex` before Prisma `contains` (prevents P2010 errors on Mongo regex compilation).
- **Pagination**: central `paginate()` clamp (default 20, cap 100) for offset lists; keyset/cursor pagination for high-volume ledgers.
- **Audit**: explicit `audit.record({actor: actorFrom(req), action, target...})` after each mutation — fire-and-forget, never blocks or throws.
- **Frontend**: services-not-fetch, hooks-not-context, View/Detail/Form trios, `PermissionGate` on pages, status-badge helper module per domain, unsaved-changes guard on all forms.

---

## 13. Third-Party Integrations

| Service | What it does | Where | Credentials |
|---|---|---|---|
| **MongoDB (Atlas)** | Primary database (replica set required for transactions) | [lib/prisma.ts](backend/src/lib/prisma.ts) | `DATABASE_URL` |
| **Cloudinary** | Branding images, avatars, signatures, damage photos, PRF/PO/GRN attachments, archived PO PDFs | [lib/cloudinary.ts](backend/src/lib/cloudinary.ts) | Settings (encrypted) with env fallback |
| **SMTP (nodemailer)** | All transactional email via admin-configured SMTP | [lib/mailer.ts](backend/src/lib/mailer.ts), [email.service.ts](backend/src/modules/email/email.service.ts) | Settings (password AES-256-GCM encrypted) |
| **Google Identity Services** | Optional Google sign-in (ID-token verification server-side; GIS button on the login page) | [auth.service.ts](backend/src/modules/auth/auth.service.ts), `frontend/src/app/login` | Settings (`googleClientId`, encrypted secret) |
| **postcodes.io** | UK postcode → coordinates/city/county (keyless, best-effort, never throws) | [lib/geocode.ts](backend/src/lib/geocode.ts), geo module | none |
| **Socket.IO** | Realtime refetch signals (self-hosted, same port/cookies) | [lib/realtime.ts](backend/src/lib/realtime.ts), [frontend lib/socket.ts](frontend/src/lib/socket.ts) | reuses auth cookie |
| **pdfkit / bwip-js** | PO PDF generation with letterhead + issuer signature; Code-128 barcode PNGs | [modules/document/](backend/src/modules/document/), irm module | n/a (libraries) |

---

## 14. Testing

- **Framework**: Vitest in both apps (`pnpm test` = `vitest run`).
- **Backend**: **61 test files** colocated with source (alongside files or in `__tests__/` folders) — e.g. `lib/geocode.test.ts`, `lib/warehouse-access.test.ts`, `types/principal.test.ts`, `utils/__tests__/procurement-diff.test.ts`, `utils/__tests__/time-buckets.test.ts`, plus ~56 across modules (auth, customer, inventory, purchase-order, dashboard, document, …). [vitest.config.ts](backend/vitest.config.ts) aliases `#modules` → `src/modules` so tests import/mock with the same specifiers as app code, and excludes `dist/`.
- **Frontend**: colocated unit tests — `api.test.ts`, `auth.test.ts`, `roleReachability.test.ts`, `siteImport.test.ts`, `Pagination.test.ts`, `ExpectedDeliveries.test.ts`, `kitLineSourceSplit.test.ts`.
- **Style**: unit tests over pure logic (state machines, diffing, bucketing, pagination math, access rules); no e2e/integration harness found in the codebase.

---

## 15. Deployment & CI/CD

- **Backend on Vercel**: [vercel.json](backend/vercel.json) rewrites every request to `/api`; [api/index.js](backend/api/index.js) exports the compiled Express app as the serverless handler. Build command `vercel-build` = `prisma generate && tsc`. Prisma `binaryTargets` include `rhel-openssl-3.0.x` for the Vercel runtime. `trust proxy = 1` makes client IPs / rate limiting correct behind the proxy. **Note:** Socket.IO realtime is wired only in `server.ts` (long-lived mode) — the serverless path has no realtime.
- **Frontend**: standard Next.js build (`pnpm build` / `start`); requires `NEXT_PUBLIC_API_URL`. No hosting config committed.
- **CI/CD**: no `.github/workflows/` or other CI pipeline files found in the repo. Development follows a PR-per-feature-branch flow (recent PRs #34–#47) with design specs and implementation plans committed under `docs/superpowers/`.
- **Database migrations**: none (MongoDB) — schema/index changes are applied with `npx prisma db push`; partial unique indexes are (re)created idempotently by the startup seed.

---

## 16. Known Tech Debt & Observations

- **Realtime is dev/long-lived-server only**: `initRealtime` runs in `server.ts`, not on the Vercel serverless path — deployed-to-Vercel realtime silently does nothing (emit helpers no-op). If production runs on Vercel, live updates depend on refetch-on-navigation only.
- **Schema drift risk is procedural**: with MongoDB there are no migrations; forgetting `npx prisma db push` after a schema edit leaves indexes/uniqueness silently missing (documented incident: 29 indexes applied at once on 2026-07-17). Before pushing a new `@@unique` against existing data, duplicates must be found manually — Mongo won't name them.
- **`Role.permissions` vs reality**: permission enforcement is entirely application-layer; customers carry a hard-coded permission set; legacy permission expansion/backfill logic (`LEGACY_PERMISSION_EXPANSION`, `CUSTOMER_COMPAT_BACKFILL`) runs at seed on every startup — a migration mechanism living in code.
- **Deliberately deferred features visible in the schema/code**: `CustomerStockEntry.serialized/serialNumber/highValue` fields are unused; serial/batch-tracked items are refused by warehouse transfers, add-stock, and goods-management issue (only Goods-In handles serials/batches today); `FEATURE_CUSTOMER_STOCK` flag returns `available:false` (customer live stock view / Flow 9 pending); `JobKitRequest.transferId` is deprecated in favour of `transferIds[]`; document module declares 5 future document types beyond `purchase_order`.
- **Client requirements still partly open**: `Client_Requirements.md` is marked DRAFT — finance report templates and items 10–17 (customer report field visibility, physical scanner model, VAT format, branding assets) are pending client answers; the Job-Pack Excel parsing feature is explicitly post-Phase-1.
- **Duplicate route mount**: `/warehouses` mounts both the warehouse router and the customer module's `warehousePendingRouter` — functional, but path ownership is split across modules.
- **No CI pipeline**: quality gates (`typecheck`, `lint`, `test`) exist as scripts but nothing in-repo runs them automatically on PRs.
- **No e2e tests**: coverage is unit-level over pure logic; the long transactional flows (GRN completion, kit-request approval resume, VSR fulfilment) rely on code review + manual testing.
- **`Session` cleanup is lazy** (pruned on read) — expired rows for inactive principals persist until touched.
- **Jobs are deliberately not warehouse-scoped** (dashboard comment) — warehouse-scoped users see all jobs; intentional, but worth knowing.

---

*Sections above were produced by reading the actual source: every module's routes/controller/service/repository/validation files, the full Prisma schema, core infrastructure (`app.ts`, `server.ts`, middleware, lib, utils), the frontend app tree, providers, services and components, and the docs folder.*
