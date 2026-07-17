# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Two independent apps in one git repo (not a workspace — each has its own `package.json` and is installed/run separately):

- `backend/` — Express 5 + Prisma (MongoDB) REST API, layered TypeScript, **pnpm**, Node ≥20.
- `frontend/` — Next.js 16 (App Router) + React 19 + Tailwind v4 admin dashboard.
- `docs/` — project documentation.

The frontend talks to the backend over HTTP; auth is carried in **httpOnly cookies** (`withCredentials`), so both must run together during development.

## Commands

**Backend** (`cd backend`):
| | |
|---|---|
| `pnpm dev` | Run with hot reload (`tsx watch`, no build step) |
| `pnpm build` | Compile to `dist/` with `tsc` |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm lint` / `pnpm lint:fix` | ESLint over `src` |
| `pnpm test` | Vitest unit tests (`vitest run`) |
| `pnpm prisma:generate` | Regenerate the Prisma client — types only, **does NOT touch the database** |
| `npx prisma db push` | Push the schema (incl. **indexes**) to MongoDB — no script alias; run it directly |

Verify changes with `pnpm typecheck` + `pnpm lint` + `pnpm test`.

### After ANY `schema.prisma` change, BOTH are required

`prisma:generate` only rebuilds the client's TypeScript types. It never contacts the database, so
typecheck/lint/tests all pass green while the live DB silently lacks whatever you added. For an
`@@index`/`@@unique` that drift is invisible until production: queries quietly fall back to full
collection scans, and a uniqueness rule you *think* is enforced simply isn't.

```bash
npx prisma db push      # applies indexes + field changes to MongoDB (also regenerates the client)
```

This is not hypothetical — on 2026-07-17 a single `db push` applied **29 accumulated indexes** across
PurchaseRequest, PurchaseOrder, JobKitRequest and VanStockRequest, including `code` unique indexes.
Those modules had been running unindexed with no DB-level uniqueness guarantee.

Before pushing a new `@@unique` to a database that already holds data, check for existing rows that
violate it — the index build fails if any duplicates exist, and MongoDB will not tell you which.

**Frontend** (`cd frontend`): `pnpm dev` (serves on :3000), `pnpm build`, `pnpm lint`. Requires `NEXT_PUBLIC_API_URL` in `frontend/.env` pointing at the backend (e.g. `http://localhost:8000`).

## Backend architecture

Fully documented in [backend/README.md](backend/README.md). Key invariants to respect when editing:

- **Domain-module layout**: code is organized by domain under `src/modules/<domain>/`, each folder holding that domain's full vertical slice — `<domain>.controller.ts`, `.service.ts`, `.repository.ts`, `.validation.ts`, `.routes.ts`. Current modules: `auth` (incl. `admin.repository.ts`), `user`, `role`, `settings`, `email` (sending infra + `emailTemplate.*` CRUD + `emailTemplate.defaults.ts`), `audit`. Cross-cutting code stays at `src/` top level: `config/`, `lib/`, `middleware/`, `utils/`, `types/`, `db/`, and the route aggregator `routes/index.ts` (mounts each module's `*.routes.ts`).
- **Strict layering** (within and across modules): `route → middleware (rateLimit → requireAuth → validateBody) → controller → service → repository → Prisma`. Controllers hold no business logic; services return data or `throw new HttpError(status, message)`; the error middleware turns thrown errors into JSON (only 5xx logged).
- **Repositories are the ONLY place Prisma is touched** — one repository per model, living in the owning module. Never call Prisma from a controller or service. A service may import another module's repository/service via `../<other-domain>/...`.
- **`config/env.ts` is the ONLY place `process.env` is read** — validated with zod at startup; add new env vars there.
- **Auth boundary**: tokens are generated in the *service* and returned; cookies are set in the *controller*. JWT access + refresh; Google OAuth supported.
- **File naming**: `domain.layer.ts` (e.g. `user.controller.ts`, `user.service.ts`, `user.repository.ts`, `user.validation.ts`), grouped in `modules/<domain>/`.
- **ESM / NodeNext**: relative imports MUST include the `.js` extension (e.g. `import { env } from "../config/env.js"`) even though the source is `.ts`.
- **`#modules/*` import alias**: cross-module and into-module imports use the Node subpath alias `#modules/<domain>/...` (still with the `.js` extension) instead of `../<domain>/...`. Same-module imports stay relative (`./auth.service.js`); shared dirs stay relative (`../../config/env.js`). The alias is a conditional map in `package.json` `imports`: the `development` condition points at `./src/modules/*`, `default` at `./dist/modules/*`. So **`pnpm dev` runs `tsx --conditions=development`** and `pnpm typecheck`/`build` use `customConditions: ["development"]` in `tsconfig.json` to resolve against source; `pnpm start` (plain `node dist/`) gets `default` → the compiled `dist/`. If you add a new top-level code dir that modules import from, alias it the same way.

## Frontend architecture

⚠️ **This is a customized Next.js 16 build with breaking changes vs. stock Next.js** — see [frontend/AGENTS.md](frontend/AGENTS.md). Before writing Next.js code, read the relevant guide in `frontend/node_modules/next/dist/docs/` and heed deprecation notices. Use the `/nextjs` command for App Router guidance.

- **API access goes through `src/lib/api.ts`** — a thin axios wrapper that sends the auth cookies, **silently refreshes once on a 401 and replays the request**, and throws an `Error` carrying the server's message. Never call axios/fetch directly from components.
- **`src/services/*.service.ts`** are typed, per-domain wrappers around `api()` (e.g. `user.service.ts`). Components call services, not `api()` directly.
- **Global state via React Context providers** mounted in the root layout: `AuthProvider` (validates the session via `getCurrentPrincipal()` on mount), `DashboardProvider`, `BrandingProvider`. Consume them through the `useAuth` / `useDashboard` / `useBranding` hooks — never `useContext` directly.
- **Route protection**: `AuthGuard` wraps the dashboard shell and redirects to `/login`; while the session is verified (or found invalid) it shows a neutral full-screen loader instead of the shell, so an unauthenticated visitor never sees the app chrome/nav.
- **Appearance** (theme / accent / density / radius) is persisted to a cookie and applied to `<html>` during SSR to avoid a flash — set via `DashboardProvider`, read with `lib/appearance.ts`.
- **UI**: shadcn-style components in `src/components/ui/` with the `cn()` helper from `lib/utils.ts`; Tailwind v4; `lucide-react` icons; `recharts`, `@dnd-kit`, `@base-ui/react`/Radix for richer widgets.
