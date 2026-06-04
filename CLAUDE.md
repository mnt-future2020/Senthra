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
| `pnpm prisma:generate` | Regenerate the Prisma client (run after schema changes) |

There is **no backend test runner** (`pnpm test` is a placeholder). Verify changes with `pnpm typecheck` + `pnpm lint`.

**Frontend** (`cd frontend`): `pnpm dev` (serves on :3000), `pnpm build`, `pnpm lint`. Requires `NEXT_PUBLIC_API_URL` in `frontend/.env` pointing at the backend (e.g. `http://localhost:8000`).

## Backend architecture

Fully documented in [backend/README.md](backend/README.md). Key invariants to respect when editing:

- **Strict layering**: `route → middleware (rateLimit → requireAuth → validateBody) → controller → service → repository → Prisma`. Controllers hold no business logic; services return data or `throw new HttpError(status, message)`; the error middleware turns thrown errors into JSON (only 5xx logged).
- **Repositories are the ONLY place Prisma is touched** — one module per model. Never call Prisma from a controller or service.
- **`config/env.ts` is the ONLY place `process.env` is read** — validated with zod at startup; add new env vars there.
- **Auth boundary**: tokens are generated in the *service* and returned; cookies are set in the *controller*. JWT access + refresh; Google OAuth supported.
- **File naming**: `domain.layer.ts` (e.g. `user.controller.ts`, `user.service.ts`, `user.repository.ts`, `user.validation.ts`).
- **ESM / NodeNext**: relative imports MUST include the `.js` extension (e.g. `import { env } from "../config/env.js"`) even though the source is `.ts`.

## Frontend architecture

⚠️ **This is a customized Next.js 16 build with breaking changes vs. stock Next.js** — see [frontend/AGENTS.md](frontend/AGENTS.md). Before writing Next.js code, read the relevant guide in `frontend/node_modules/next/dist/docs/` and heed deprecation notices. Use the `/nextjs` command for App Router guidance.

- **API access goes through `src/lib/api.ts`** — a thin axios wrapper that sends the auth cookies, **silently refreshes once on a 401 and replays the request**, and throws an `Error` carrying the server's message. Never call axios/fetch directly from components.
- **`src/services/*.service.ts`** are typed, per-domain wrappers around `api()` (e.g. `user.service.ts`). Components call services, not `api()` directly.
- **Global state via React Context providers** mounted in the root layout: `AuthProvider` (validates the session via `getCurrentAdmin()` on mount), `DashboardProvider`, `BrandingProvider`. Consume them through the `useAuth` / `useDashboard` / `useBranding` hooks — never `useContext` directly.
- **Route protection**: `AuthGuard` wraps the dashboard shell and redirects to `/login`; while the session is verified (or found invalid) it shows a neutral full-screen loader instead of the shell, so an unauthenticated visitor never sees the app chrome/nav.
- **Appearance** (theme / accent / density / radius) is persisted to a cookie and applied to `<html>` during SSR to avoid a flash — set via `DashboardProvider`, read with `lib/appearance.ts`.
- **UI**: shadcn-style components in `src/components/ui/` with the `cn()` helper from `lib/utils.ts`; Tailwind v4; `lucide-react` icons; `recharts`, `@dnd-kit`, `@base-ui/react`/Radix for richer widgets.
