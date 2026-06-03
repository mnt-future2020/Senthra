# Senthra — Architecture

A monorepo with two independent applications:

```
Senthra/
├── backend/    # Express 5 + Prisma (MongoDB) REST API — TypeScript
├── frontend/   # Next.js 16 (App Router) admin dashboard — TypeScript
└── docs/
```

Each app has its own `package.json`, lockfile, and `.gitignore`; they are developed
and deployed independently.

## Backend — layered architecture

A request flows top-down through clearly separated layers, each with one job:

```
route → middleware (rateLimit / requireAuth / validate) → controller → service → repository → Prisma
```

| Layer | Responsibility |
| --- | --- |
| `routes/` | Wire URLs to middleware + controllers. |
| `controllers/` | Thin HTTP glue — parse request, call a service, send the response. |
| `services/` | All business logic; return data or throw `HttpError`. |
| `repositories/` | The only place Prisma is accessed (one module per model). |
| `validations/` | zod schemas that validate and normalize request bodies. |
| `middleware/` | Cross-cutting: auth, validation runner, error handler, rate limiting. |
| `config/` | Environment validated once with zod (`env.ts`). |
| `lib/` | Stateful third-party clients (Prisma, Nodemailer). |
| `utils/` | Pure helpers (jwt, cookies, crypto, password, http-error, async-handler). |
| `db/` | Startup bootstrap (seed). |

See [`backend/README.md`](../backend/README.md) for details.

## Frontend — feature + role separation

The App Router (`app/`) handles routing only; everything else is grouped by role:

```
frontend/src/
├── app/          # Next.js routes (pages + layouts) — routing only
├── components/
│   ├── ui/        # shadcn primitives
│   ├── auth/      # auth-screen building blocks
│   └── dashboard/ # presentational dashboard components (modals, settings, shell, tabs)
├── providers/    # React context providers (AuthProvider, DashboardProvider)
├── hooks/        # reusable hooks (useAuth, useDashboard)
├── services/     # typed API clients (auth.service, settings.service)
├── lib/          # framework-agnostic infra (axios client, env, utils)
├── types/        # shared types (auth, dashboard, settings)
└── data/         # mock/demo data
```

### Key conventions

- **No raw API calls in components.** UI calls a typed function in `services/`,
  which wraps the shared axios client in `lib/api.ts` (cookies + silent token refresh).
- **Context lives in `providers/`; its hook lives in `hooks/`.** Components consume
  state via `useAuth()` / `useDashboard()` and never import a provider's context directly.
- **Shared types live in `types/`**; feature-local types stay co-located with their
  feature (e.g. `components/dashboard/settings/types.ts`).
- The frontend talks to the backend exclusively through `services/`, so the API
  surface is typed and discoverable in one place.
